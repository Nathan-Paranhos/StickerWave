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

test('SoundStickerProtocol embeds AudioMessage in field 26 and leaves unrelated stickers clean', () => {
  const protocol = new SoundStickerProtocol('7.0.0-rc14');
  const sha = crypto.randomBytes(32);
  const encSha = crypto.randomBytes(32);
  const audio = makeAudioPayload(4, 9876);

  const { encoded, verification } = protocol.serializeAndVerifySynthetic({
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
  });

  assert.equal(verification.valid, true);
  assert.ok((verification.embeddedAudioBytes ?? 0) > 40);
  assert.equal(verification.decodedAudio?.seconds, 4);
  assert.equal(verification.decodedAudio?.ptt, true);
  assert.equal(getPendingAttachmentCount(), 0);

  // Verify raw wire structure on outer Message and inner StickerMessage
  const outer = parseRawProtoFields(encoded);
  const stickerRaw = findProtoBytesField(outer, MESSAGE_STICKER_FIELD);
  assert.ok(stickerRaw?.payload);
  const audioFields = parseRawProtoFields(stickerRaw.payload).filter((f) => f.field === STICKER_AUDIO_FIELD);
  assert.equal(audioFields.length, 1);

  const parsedIncoming = inspectRawStickerAudio(stickerRaw.payload);
  assert.ok(parsedIncoming);
  assert.equal(parsedIncoming.decodedAudio.seconds, 4);
  assert.equal(parsedIncoming.decodedAudio.ptt, 1);

  // Plain sticker after serialization MUST NOT have audio field 26
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
