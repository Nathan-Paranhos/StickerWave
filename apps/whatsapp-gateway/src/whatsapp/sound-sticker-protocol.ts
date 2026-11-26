import {
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  proto,
  type WAMessage,
} from '@whiskeysockets/baileys';
import {
  encodeVarintTagAndBytes,
  findProtoBytesField,
  findProtoVarintField,
  parseRawProtoFields,
} from './protobuf-wire.js';

export const MESSAGE_STICKER_FIELD = 26;
export const STICKER_AUDIO_FIELD = 26;
export const STICKER_AUDIO_TAG = (STICKER_AUDIO_FIELD << 3) | 2; // 210
export const SOUND_STICKER_AUDIO_MIME = 'audio/ogg; codecs=opus';

const PATCH_INSTALLED_SYMBOL = Symbol.for('stickerwave.soundStickerProtocol.patchInstalled');
const ORIGINAL_ENCODE_SYMBOL = Symbol.for('stickerwave.soundStickerProtocol.originalEncode');

export type ProtocolCompatibilityMode = 'native' | 'patched-encoder' | 'unsupported';

export interface ProtocolCapabilityReport {
  baileysVersion: string;
  mode: ProtocolCompatibilityMode;
  nativeField26Present: boolean;
  patchInstalled: boolean;
  fieldNumber: number;
  wireTag: number;
}

export interface EmbeddedAudioInspection {
  found: boolean;
  keyBase64: string;
  byteLength: number;
  decodedAudio: {
    seconds: number | null;
    fileLength: number | null;
    ptt: number | null;
    mimetype: string | null;
  };
}

export interface SoundStickerPayloadInput {
  webpBuffer: Buffer;
  oggBuffer: Buffer;
  isAnimated: boolean;
  seconds: number;
  waveform: Uint8Array;
  emojis?: string[];
  accessibilityLabel?: string;
}

export interface PreparedSoundStickerMessage {
  waMessage: WAMessage;
  encodedProtoMessage: Buffer;
  stickerFieldKey: string;
  audioBytesLength: number;
  stickerBytesLength: number;
  uploadedSticker: proto.Message.IStickerMessage;
  uploadedAudio: proto.Message.IAudioMessage;
  cleanup: () => void;
}

interface PendingAttachment {
  audioBytes: Uint8Array;
  createdAt: number;
}

const pendingByCompositeKey = new Map<string, PendingAttachment>();
const pendingByShaKey = new Map<string, PendingAttachment>();

function toBase64(bytes: Uint8Array | Buffer | null | undefined): string {
  if (!bytes) return '';
  return Buffer.from(bytes).toString('base64');
}

export function buildAttachmentKeys(
  fileSha256: Uint8Array | Buffer | null | undefined,
  fileEncSha256?: Uint8Array | Buffer | null | undefined,
): { compositeKey: string; shaKey: string } {
  const shaKey = toBase64(fileSha256);
  const encKey = toBase64(fileEncSha256);
  return {
    compositeKey: encKey ? `${shaKey}:${encKey}` : shaKey,
    shaKey,
  };
}

/**
 * Probes whether Baileys' compiled `proto.Message.StickerMessage.encode` already serializes
 * field 26 (`audioMessage`) natively, or whether runtime wire injection is needed.
 */
export function detectNativeStickerAudioSupport(
  stickerProto: typeof proto.Message.StickerMessage = proto.Message.StickerMessage,
): boolean {
  try {
    const encoderFn = (stickerProto as unknown as Record<symbol, unknown>)[ORIGINAL_ENCODE_SYMBOL] as
      | typeof stickerProto.encode
      | undefined;
    const rawEncode = encoderFn ?? stickerProto.encode;
    const probeAudio = proto.Message.AudioMessage.encode(
      proto.Message.AudioMessage.create({ seconds: 1, ptt: true, mimetype: SOUND_STICKER_AUDIO_MIME }),
    ).finish();

    const probeMsg = stickerProto.create({
      fileSha256: Buffer.alloc(32, 0x11),
      isAnimated: true,
    } as proto.Message.IStickerMessage) as unknown as Record<string, unknown>;
    probeMsg.audioMessage = proto.Message.AudioMessage.decode(probeAudio);

    const encoded = rawEncode(probeMsg as proto.Message.IStickerMessage).finish();
    const fields = parseRawProtoFields(encoded);
    return Boolean(findProtoBytesField(fields, STICKER_AUDIO_FIELD));
  } catch {
    return false;
  }
}

/**
 * Installs an idempotent runtime encoder hook on `proto.Message.StickerMessage.encode`
 * without mutating files in `node_modules`.
 */
export function ensureStickerAudioProtocolPatch(
  waProto: typeof proto = proto,
): { installed: boolean; native: boolean } {
  const StickerMessage = waProto.Message.StickerMessage as typeof waProto.Message.StickerMessage &
    Record<symbol, unknown>;

  if (StickerMessage[PATCH_INSTALLED_SYMBOL]) {
    const native = detectNativeStickerAudioSupport(StickerMessage);
    return { installed: true, native };
  }

  const native = detectNativeStickerAudioSupport(StickerMessage);
  const originalEncode = StickerMessage.encode;
  StickerMessage[ORIGINAL_ENCODE_SYMBOL] = originalEncode;

  if (!native) {
    StickerMessage.encode = function patchedStickerEncode(
      this: unknown,
      message: proto.Message.IStickerMessage,
      writer?: Parameters<typeof originalEncode>[1],
    ) {
      const resultWriter = originalEncode.call(this, message, writer);
      if (!message) return resultWriter;

      const msgAny = message as unknown as Record<string, unknown>;
      // 1) Allow explicit inline raw field when present cleanly without double-writing
      const inlineBytes = msgAny.__stickerWaveAudioBytes;
      if (inlineBytes instanceof Uint8Array && inlineBytes.byteLength > 0) {
        resultWriter.uint32(STICKER_AUDIO_TAG).bytes(inlineBytes);
        return resultWriter;
      }

      // 2) Registry lookup by composite (fileSha256:fileEncSha256) first, then sha256-only fallback
      if (message.fileSha256) {
        const { compositeKey, shaKey } = buildAttachmentKeys(message.fileSha256, message.fileEncSha256);
        const pending =
          (compositeKey && pendingByCompositeKey.get(compositeKey)) ||
          (shaKey ? pendingByShaKey.get(shaKey) : undefined);
        if (pending && pending.audioBytes.byteLength > 0) {
          resultWriter.uint32(STICKER_AUDIO_TAG).bytes(pending.audioBytes);
        }
      }
      return resultWriter;
    } as typeof StickerMessage.encode;
  }

  StickerMessage[PATCH_INSTALLED_SYMBOL] = true;
  return { installed: true, native };
}

export function attachPendingStickerAudio(
  fileSha256: Uint8Array,
  audioMessageBytes: Uint8Array,
  fileEncSha256?: Uint8Array | null,
): string {
  if (!fileSha256 || fileSha256.byteLength === 0) {
    throw new Error('Cannot attach sticker audio without valid sticker fileSha256.');
  }
  const { compositeKey, shaKey } = buildAttachmentKeys(fileSha256, fileEncSha256);
  const record: PendingAttachment = { audioBytes: audioMessageBytes, createdAt: Date.now() };
  if (fileEncSha256 && fileEncSha256.byteLength > 0) {
    pendingByCompositeKey.set(compositeKey, record);
  } else {
    pendingByShaKey.set(shaKey, record);
  }
  return compositeKey;
}

export function detachPendingStickerAudio(
  fileSha256: Uint8Array | null | undefined,
  fileEncSha256?: Uint8Array | null,
): void {
  if (!fileSha256) return;
  const { compositeKey, shaKey } = buildAttachmentKeys(fileSha256, fileEncSha256);
  if (fileEncSha256 && fileEncSha256.byteLength > 0) {
    pendingByCompositeKey.delete(compositeKey);
  } else {
    pendingByShaKey.delete(shaKey);
  }
}

export function getPendingAttachmentCount(): number {
  return pendingByCompositeKey.size + pendingByShaKey.size;
}

/**
 * Inspects an encoded outer `proto.Message` buffer and verifies field 26 (`stickerMessage`)
 * contains inner field 26 (`audioMessage`, wire tag 210).
 */
export function verifyEncodedSoundStickerMessage(encodedOuterMessage: Uint8Array): {
  valid: boolean;
  embeddedAudioBytes: number | null;
  decodedAudio: proto.Message.AudioMessage | null;
  reason?: string;
} {
  try {
    const outerFields = parseRawProtoFields(encodedOuterMessage);
    const stickerField = findProtoBytesField(outerFields, MESSAGE_STICKER_FIELD);
    if (!stickerField || !stickerField.payload) {
      return { valid: false, embeddedAudioBytes: null, decodedAudio: null, reason: 'Missing outer Message.stickerMessage (#26).' };
    }

    const innerFields = parseRawProtoFields(stickerField.payload);
    const audioField = findProtoBytesField(innerFields, STICKER_AUDIO_FIELD);
    if (!audioField || !audioField.payload || audioField.payload.byteLength === 0) {
      return { valid: false, embeddedAudioBytes: null, decodedAudio: null, reason: 'Missing inner StickerMessage.audioMessage (#26).' };
    }

    const decodedAudio = proto.Message.AudioMessage.decode(audioField.payload);
    if (!decodedAudio.mimetype?.includes('opus')) {
      return { valid: false, embeddedAudioBytes: audioField.payload.byteLength, decodedAudio, reason: 'Embedded AudioMessage missing Opus mimetype.' };
    }

    return {
      valid: true,
      embeddedAudioBytes: audioField.payload.byteLength,
      decodedAudio,
    };
  } catch (err) {
    return {
      valid: false,
      embeddedAudioBytes: null,
      decodedAudio: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Reads audio metadata from a raw wire `StickerMessage` buffer (useful for incoming sticker debugging).
 */
export function inspectRawStickerAudio(rawStickerPayload: Uint8Array): EmbeddedAudioInspection | null {
  try {
    const fields = parseRawProtoFields(rawStickerPayload);
    const shaField = findProtoBytesField(fields, 2);
    const audioField = findProtoBytesField(fields, STICKER_AUDIO_FIELD);
    if (!shaField?.payload || !audioField?.payload) return null;

    const audioFields = parseRawProtoFields(audioField.payload);
    const mimeField = findProtoBytesField(audioFields, 2);
    return {
      found: true,
      keyBase64: Buffer.from(shaField.payload).toString('base64'),
      byteLength: audioField.payload.byteLength,
      decodedAudio: {
        seconds: findProtoVarintField(audioFields, 5),
        fileLength: findProtoVarintField(audioFields, 4),
        ptt: findProtoVarintField(audioFields, 6),
        mimetype: mimeField?.payload ? mimeField.payload.toString('utf8') : null,
      },
    };
  } catch {
    return null;
  }
}

export class SoundStickerProtocol {
  public readonly capability: ProtocolCapabilityReport;

  constructor(baileysVersion = '7.0.0-rc14') {
    const { installed, native } = ensureStickerAudioProtocolPatch(proto);
    this.capability = {
      baileysVersion,
      mode: native ? 'native' : installed ? 'patched-encoder' : 'unsupported',
      nativeField26Present: native,
      patchInstalled: installed,
      fieldNumber: STICKER_AUDIO_FIELD,
      wireTag: STICKER_AUDIO_TAG,
    };
  }

  buildAudioMessageBytes(
    uploadedAudio: proto.Message.IAudioMessage,
    seconds: number,
    waveform: Uint8Array,
  ): Uint8Array {
    if (!uploadedAudio.url || !uploadedAudio.mediaKey || !uploadedAudio.fileSha256 || !uploadedAudio.fileEncSha256) {
      throw new Error('Uploaded audio message is missing required WhatsApp encryption/upload fields.');
    }
    const cleanSeconds = Math.max(1, Math.round(seconds));
    const cleanWaveform = waveform.byteLength === 64 ? waveform : Uint8Array.from(new Array(64).fill(20));

    const audioMessage = proto.Message.AudioMessage.create({
      url: uploadedAudio.url,
      mimetype: SOUND_STICKER_AUDIO_MIME,
      fileSha256: uploadedAudio.fileSha256,
      fileLength: uploadedAudio.fileLength,
      seconds: cleanSeconds,
      ptt: true,
      mediaKey: uploadedAudio.mediaKey,
      fileEncSha256: uploadedAudio.fileEncSha256,
      directPath: uploadedAudio.directPath,
      mediaKeyTimestamp: uploadedAudio.mediaKeyTimestamp || Math.floor(Date.now() / 1000),
      waveform: cleanWaveform,
    });

    return proto.Message.AudioMessage.encode(audioMessage).finish();
  }

  /**
   * Builds and verifies an offline/synthetic Sound Sticker `proto.Message` without requiring a live socket.
   * Useful for deterministic binary serialization tests and CI regression gates.
   */
  serializeAndVerifySynthetic(params: {
    sticker: proto.Message.IStickerMessage;
    audio: proto.Message.IAudioMessage;
    seconds: number;
    waveform: Uint8Array;
  }): { encoded: Buffer; verification: ReturnType<typeof verifyEncodedSoundStickerMessage> } {
    ensureStickerAudioProtocolPatch(proto);
    const audioBytes = this.buildAudioMessageBytes(params.audio, params.seconds, params.waveform);
    const stickerSha = params.sticker.fileSha256;
    if (!stickerSha) throw new Error('Sticker fileSha256 required.');

    attachPendingStickerAudio(stickerSha, audioBytes, params.sticker.fileEncSha256);
    try {
      const msg = proto.Message.create({
        stickerMessage: params.sticker,
      });
      const encoded = Buffer.from(proto.Message.encode(msg).finish());
      const verification = verifyEncodedSoundStickerMessage(encoded);
      return { encoded, verification };
    } finally {
      detachPendingStickerAudio(stickerSha, params.sticker.fileEncSha256);
    }
  }

  /**
   * Uploads WebP sticker + Ogg/Opus audio through Baileys `waUploadToServer`, binds the encoded
   * AudioMessage to field 26, validates wire serialization, and relays the single Sound Sticker message.
   */
  async sendSoundSticker(params: {
    chatJid: string;
    ownJid: string;
    payload: SoundStickerPayloadInput;
    upload: NonNullable<Parameters<typeof prepareWAMessageMedia>[1]['upload']>;
    relayMessage: (jid: string, message: proto.IMessage, options: { messageId: string }) => Promise<string>;
    quoted?: WAMessage;
  }): Promise<{ messageId: string; verification: ReturnType<typeof verifyEncodedSoundStickerMessage> }> {
    ensureStickerAudioProtocolPatch(proto);
    const uploadOpts = { upload: params.upload };

    const uploadedAudioMsg = await prepareWAMessageMedia(
      {
        audio: params.payload.oggBuffer,
        mimetype: SOUND_STICKER_AUDIO_MIME,
        seconds: Math.max(1, Math.round(params.payload.seconds)),
        ptt: true,
        waveform: params.payload.waveform,
      } as unknown as Parameters<typeof prepareWAMessageMedia>[0],
      uploadOpts,
    );

    const uploadedStickerMsg = await prepareWAMessageMedia(
      {
        sticker: params.payload.webpBuffer,
        isAnimated: params.payload.isAnimated,
      },
      uploadOpts,
    );

    const uploadedAudio = uploadedAudioMsg.audioMessage;
    const uploadedSticker = uploadedStickerMsg.stickerMessage;
    if (!uploadedAudio || !uploadedSticker || !uploadedSticker.fileSha256) {
      throw new Error('Baileys prepareWAMessageMedia did not return complete audioMessage / stickerMessage payloads.');
    }

    uploadedSticker.isAnimated = params.payload.isAnimated;
    uploadedSticker.width = 512;
    uploadedSticker.height = 512;
    if (params.payload.accessibilityLabel) {
      const limit = params.payload.isAnimated ? 250 : 125;
      uploadedSticker.accessibilityLabel = params.payload.accessibilityLabel.slice(0, limit);
    }

    const audioBytes = this.buildAudioMessageBytes(uploadedAudio, params.payload.seconds, params.payload.waveform);

    attachPendingStickerAudio(uploadedSticker.fileSha256, audioBytes, uploadedSticker.fileEncSha256);
    try {
      const fullMsg = generateWAMessageFromContent(
        params.chatJid,
        { stickerMessage: uploadedSticker },
        {
          quoted: params.quoted,
          userJid: params.ownJid,
        },
      );

      if (!fullMsg.message || !fullMsg.key.id) {
        throw new Error('Failed to build outgoing WhatsApp sticker message envelope.');
      }

      // Binary round-trip validation BEFORE network relay so mute stickers never leak silently
      const encoded = Buffer.from(proto.Message.encode(fullMsg.message).finish());
      const verification = verifyEncodedSoundStickerMessage(encoded);
      if (!verification.valid) {
        throw new Error(`Sound sticker protobuf validation failed before send: ${verification.reason}`);
      }

      const relayedId = await params.relayMessage(params.chatJid, fullMsg.message, {
        messageId: fullMsg.key.id,
      });

      return {
        messageId: relayedId || fullMsg.key.id,
        verification,
      };
    } finally {
      detachPendingStickerAudio(uploadedSticker.fileSha256, uploadedSticker.fileEncSha256);
    }
  }
}

export { encodeVarintTagAndBytes };
