import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { proto } from '@whiskeysockets/baileys';
import {
  attachPendingStickerAudio,
  detachPendingStickerAudio,
  ensureStickerAudioProtocolPatch,
  getPendingAttachmentCount,
  inspectRawStickerAudio,
  MESSAGE_AUDIO_STICKER_FIELD,
  MESSAGE_STICKER_FIELD,
  SoundStickerProtocol,
  STICKER_AUDIO_FIELD,
  STICKER_AUDIO_TAG,
  verifyEncodedSoundStickerMessage,
} from '../../src/whatsapp/sound-sticker-protocol.js';
import { findProtoBytesField, parseRawProtoFields } from '../../src/whatsapp/protobuf-wire.js';

const makeAudioPayload = (seconds: number, fileLength: number) => ({
  url: 'https://mmg.whatsapp.net/o1/v/t62.7118-24/test-audio',
  directPath: '/o1/v/t62.7118-24/test-audio',
  fileSha256: crypto.randomBytes(32),
  fileEncSha256: crypto.randomBytes(32),
  mediaKey: crypto.randomBytes(32),
  mimetype: 'audio/ogg; codecs=opus',
  fileLength,
  seconds,
  ptt: true,
  waveform: Uint8Array.from({ length: 64 }, (_, i) => (i * 3) % 101),
});

test('SoundStickerProtocol uses protobuf field 26 wire tag 210 cleanly and idempotently', () => {
  assert.equal(STICKER_AUDIO_FIELD, 26);
  assert.equal(STICKER_AUDIO_TAG, 210);
  const first = ensureStickerAudioProtocolPatch(proto);
  const second = ensureStickerAudioProtocolPatch(proto);
  assert.equal(first.installed, true);
  assert.equal(second.installed, true);

  const protocol = new SoundStickerProtocol('7.0.0-rc14');
  assert.ok(['native', 'patched-encoder'].includes(protocol.capability.mode));
});

test('SoundStickerProtocol Strategy B (envelope-134) & Strategy A (sticker-26) round-trip cleanly without node_modules edits', () => {
  const protocol134 = new SoundStickerProtocol('7.0.0-rc14', 'envelope-134');
  const protocol26 = new SoundStickerProtocol('7.0.0-rc14', 'sticker-26');
  const sha = crypto.randomBytes(32);
  const encSha = crypto.randomBytes(32);
  const audio = makeAudioPayload(4, 9876);

  // Strategy B: Message(#134 audioStickerMessage) -> FutureProof(#1) -> StickerMessage(#24/#25/#26)
  const { encoded: encoded134, verification: ver134 } = protocol134.serializeAndVerifySynthetic({
    sticker: {
      url: 'https://mmg.whatsapp.net/o1/v/t62.15575-24/test-sticker-134',
      directPath: '/o1/v/t62.15575-24/test-sticker-134',
      fileSha256: sha,
      fileEncSha256: encSha,
      mediaKey: crypto.randomBytes(32),
      mimetype: 'image/webp',
      fileLength: 42_000,
      width: 512,
      height: 512,
      isAnimated: true,
    },
    audio,
    seconds: 4,
    waveform: audio.waveform,
    emojis: ['🔊'],
  });

  assert.equal(ver134.valid, true);
  assert.equal(ver134.strategy, 'envelope-134');
  assert.deepEqual(ver134.emojis, ['🔊']);
  assert.equal(ver134.premium, 0);
  assert.equal(ver134.decodedAudio?.ptt, false);
  assert.equal(ver134.decodedAudio?.seconds, 4);
  assert.equal(getPendingAttachmentCount(), 0);

  // Outer wire structure & runtime proto.Message.decode round-trip
  const outer134 = parseRawProtoFields(encoded134);
  assert.ok(findProtoBytesField(outer134, MESSAGE_AUDIO_STICKER_FIELD));
  const decodedOuter = proto.Message.decode(encoded134) as proto.Message & {
    audioStickerMessage?: {
      message?: {
        stickerMessage?: proto.Message.StickerMessage & {
          audioMessage?: proto.Message.AudioMessage;
          emojis?: string[];
        };
      };
    };
  };
  assert.equal(decodedOuter.audioStickerMessage?.message?.stickerMessage?.audioMessage?.seconds, 4);
  assert.deepEqual(decodedOuter.audioStickerMessage?.message?.stickerMessage?.emojis, ['🔊']);

  // Strategy A: Direct Message.stickerMessage (#26) -> StickerMessage.audioMessage (#26)
  const { encoded: encoded26, verification: ver26 } = protocol26.serializeAndVerifySynthetic({
    sticker: {
      url: 'https://mmg.whatsapp.net/o1/v/t62.15575-24/test-sticker',
      directPath: '/o1/v/t62.15575-24/test-sticker',
      fileSha256: sha,
      fileEncSha256: encSha,
      mediaKey: crypto.randomBytes(32),
      mimetype: 'image/webp',
      fileLength: 42_000,
      width: 512,
      height: 512,
      isAnimated: true,
    },
    audio,
    seconds: 4,
    waveform: audio.waveform,
    strategy: 'sticker-26',
  });

  assert.equal(ver26.valid, true);
  assert.equal(ver26.strategy, 'sticker-26');
  assert.ok((ver26.embeddedAudioBytes ?? 0) > 40);
  assert.equal(ver26.decodedAudio?.seconds, 4);
  assert.equal(ver26.decodedAudio?.ptt, true);
  assert.equal(getPendingAttachmentCount(), 0);

  const outer26 = parseRawProtoFields(encoded26);
  const stickerRaw = findProtoBytesField(outer26, MESSAGE_STICKER_FIELD);
  assert.ok(stickerRaw?.payload);
  const audioFields = parseRawProtoFields(stickerRaw.payload).filter((f) => f.field === STICKER_AUDIO_FIELD);
  assert.equal(audioFields.length, 1);

  const parsedIncoming = inspectRawStickerAudio(stickerRaw.payload, 'sticker-26');
  assert.ok(parsedIncoming);
  assert.equal(parsedIncoming.decodedAudio.seconds, 4);
  assert.equal(parsedIncoming.decodedAudio.ptt, 1);

  // Plain sticker after serialization MUST NOT have audio field 26 or #134 envelope
  const plainMsg = proto.Message.create({
    stickerMessage: {
      fileSha256: sha,
      fileEncSha256: encSha,
      width: 512,
      height: 512,
      isAnimated: false,
    },
  });
  const plainEncoded = Buffer.from(proto.Message.encode(plainMsg).finish());
  const plainCheck = verifyEncodedSoundStickerMessage(plainEncoded);
  assert.equal(plainCheck.valid, false);
  assert.equal(plainCheck.embeddedAudioBytes, null);
});

test('Concurrent stickers sharing identical plaintext fileSha256 isolate distinct audio via fileEncSha256', () => {
  const protocol = new SoundStickerProtocol('7.0.0-rc14');
  const sharedPlainSha = Buffer.alloc(32, 0xaa);
  const encA = crypto.randomBytes(32);
  const encB = crypto.randomBytes(32);

  const bytesA = protocol.buildAudioMessageBytes(makeAudioPayload(2, 1111), 2, new Uint8Array(64));
  const bytesB = protocol.buildAudioMessageBytes(makeAudioPayload(7, 2222), 7, new Uint8Array(64));

  attachPendingStickerAudio(sharedPlainSha, bytesA, encA);
  attachPendingStickerAudio(sharedPlainSha, bytesB, encB);
  try {
    const encodedA = Buffer.from(
      proto.Message.encode(
        proto.Message.create({ stickerMessage: { fileSha256: sharedPlainSha, fileEncSha256: encA, isAnimated: true } }),
      ).finish(),
    );
    const encodedB = Buffer.from(
      proto.Message.encode(
        proto.Message.create({ stickerMessage: { fileSha256: sharedPlainSha, fileEncSha256: encB, isAnimated: true } }),
      ).finish(),
    );

    const checkA = verifyEncodedSoundStickerMessage(encodedA);
    const checkB = verifyEncodedSoundStickerMessage(encodedB);
    assert.equal(checkA.decodedAudio?.seconds, 2);
    assert.equal(Number(checkA.decodedAudio?.fileLength), 1111);
    assert.equal(checkB.decodedAudio?.seconds, 7);
    assert.equal(Number(checkB.decodedAudio?.fileLength), 2222);
  } finally {
    detachPendingStickerAudio(sharedPlainSha, encA);
    detachPendingStickerAudio(sharedPlainSha, encB);
  }
  assert.equal(getPendingAttachmentCount(), 0);
});

test('sendSoundSticker rejects upload if encoded protobuf omits field 26 before relay', async () => {
  const protocol = new SoundStickerProtocol('7.0.0-rc14');
  let relayCalled = false;

  await assert.rejects(
    protocol.sendSoundSticker({
      chatJid: '5511999999999@s.whatsapp.net',
      ownJid: '5511888888888@s.whatsapp.net',
      payload: {
        webpBuffer: Buffer.from('RIFF0000WEBP'),
        oggBuffer: Buffer.from('OggS0000'),
        isAnimated: false,
        seconds: 3,
        waveform: new Uint8Array(64),
      },
      // Simulate incomplete upload result missing mediaKey
      upload: async () => ({ mediaUrl: '', directPath: '' }),
      relayMessage: async () => {
        relayCalled = true;
        return 'should-not-happen';
      },
    }),
  );
  assert.equal(relayCalled, false);
});
