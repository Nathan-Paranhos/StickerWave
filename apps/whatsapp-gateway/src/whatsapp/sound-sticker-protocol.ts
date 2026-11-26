import {
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  proto,
  type WAMessage,
} from '@whiskeysockets/baileys';
import type { SoundStickerProtocolStrategy } from '@stickerwave/contracts';
import {
  encodeVarintTagAndBytes,
  findProtoBytesField,
  findProtoVarintField,
  parseRawProtoFields,
} from './protobuf-wire.js';

export const MESSAGE_STICKER_FIELD = 26;
export const MESSAGE_AUDIO_STICKER_FIELD = 134;
export const FUTURE_PROOF_MESSAGE_FIELD = 1;
export const STICKER_PREMIUM_FIELD = 24;
export const STICKER_EMOJIS_FIELD = 25;
export const STICKER_AUDIO_FIELD = 26;
export const STICKER_AUDIO_TAG = (STICKER_AUDIO_FIELD << 3) | 2; // 210
export const SOUND_STICKER_AUDIO_MIME = 'audio/ogg; codecs=opus';

const PATCH_INSTALLED_SYMBOL = Symbol.for('stickerwave.soundStickerProtocol.patchInstalled.v2');
const ORIGINAL_STICKER_ENCODE_SYMBOL = Symbol.for('stickerwave.soundStickerProtocol.originalStickerEncode.v2');
const ORIGINAL_STICKER_DECODE_SYMBOL = Symbol.for('stickerwave.soundStickerProtocol.originalStickerDecode.v2');
const ORIGINAL_MESSAGE_CREATE_SYMBOL = Symbol.for('stickerwave.soundStickerProtocol.originalMessageCreate.v2');
const ORIGINAL_MESSAGE_ENCODE_SYMBOL = Symbol.for('stickerwave.soundStickerProtocol.originalMessageEncode.v2');
const ORIGINAL_MESSAGE_DECODE_SYMBOL = Symbol.for('stickerwave.soundStickerProtocol.originalMessageDecode.v2');

export type ProtocolCompatibilityMode = 'native' | 'patched-encoder' | 'unsupported';

export interface ProtocolCapabilityReport {
  baileysVersion: string;
  mode: ProtocolCompatibilityMode;
  strategy: SoundStickerProtocolStrategy;
  supportedStrategies: SoundStickerProtocolStrategy[];
  nativeField26Present: boolean;
  nativeField134Present: boolean;
  patchInstalled: boolean;
  fieldNumber: number;
  wireTag: number;
}

export interface EmbeddedAudioInspection {
  found: boolean;
  keyBase64: string;
  byteLength: number;
  strategy: SoundStickerProtocolStrategy;
  emojis: string[];
  premium: number | null;
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
  strategy?: SoundStickerProtocolStrategy;
}

interface PendingAttachment {
  audioBytes: Uint8Array;
  emojis: string[];
  premium: boolean;
  createdAt: number;
}

const pendingByCompositeKey = new Map<string, PendingAttachment>();
const pendingByShaKey = new Map<string, PendingAttachment>();

function toBase64(bytes: Uint8Array | Buffer | null | undefined): string {
  if (!bytes) return '';
  return Buffer.from(bytes).toString('base64');
}

function encodeVarintTagAndUint(fieldNumber: number, value: number): Buffer {
  const bytes: number[] = [];
  let tag = (fieldNumber << 3) | 0;
  while (tag >= 0x80) {
    bytes.push((tag & 0x7f) | 0x80);
    tag >>>= 7;
  }
  bytes.push(tag);
  let v = Math.max(0, Math.floor(value));
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
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
 * field 26 (`audioMessage`) natively without runtime hooks.
 */
export function detectNativeStickerAudioSupport(
  stickerProto: typeof proto.Message.StickerMessage = proto.Message.StickerMessage,
): boolean {
  try {
    const encoderFn = (stickerProto as unknown as Record<symbol, unknown>)[ORIGINAL_STICKER_ENCODE_SYMBOL] as
      | typeof stickerProto.encode
      | undefined;
    const rawEncode = encoderFn ?? stickerProto.encode;
    const probeAudio = proto.Message.AudioMessage.encode(
      proto.Message.AudioMessage.create({ seconds: 1, ptt: false, mimetype: SOUND_STICKER_AUDIO_MIME }),
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

export function detectNativeAudioStickerEnvelopeSupport(
  messageProto: typeof proto.Message = proto.Message,
): boolean {
  try {
    const rawEncode =
      ((messageProto as unknown as Record<symbol, unknown>)[ORIGINAL_MESSAGE_ENCODE_SYMBOL] as
        | typeof messageProto.encode
        | undefined) ?? messageProto.encode;
    const probe = messageProto.create({
      audioStickerMessage: {
        message: {
          stickerMessage: {
            fileSha256: Buffer.alloc(32, 0x22),
            isAnimated: true,
          },
        },
      },
    } as unknown as proto.IMessage);
    const encoded = rawEncode(probe).finish();
    const fields = parseRawProtoFields(encoded);
    return Boolean(findProtoBytesField(fields, MESSAGE_AUDIO_STICKER_FIELD));
  } catch {
    return false;
  }
}

/**
 * Installs idempotent runtime protobuf encode/decode hooks for BOTH:
 * - Strategy A (`sticker-26`): `Message.stickerMessage (#26)` -> `StickerMessage.audioMessage (#26)`
 * - Strategy B (`envelope-134`): `Message.audioStickerMessage (#134)` -> `FutureProofMessage.message (#1)`
 *   -> `Message.stickerMessage (#26)` -> `StickerMessage.{premium(#24), emojis(#25), audioMessage(#26)}`
 * Zero mutations inside `node_modules`.
 */
export function ensureStickerAudioProtocolPatch(waProto: typeof proto = proto): {
  installed: boolean;
  native: boolean;
  nativeEnvelope134: boolean;
} {
  const MessageProto = waProto.Message as typeof waProto.Message & Record<symbol, unknown>;
  const StickerMessage = waProto.Message.StickerMessage as typeof waProto.Message.StickerMessage &
    Record<symbol, unknown>;

  if (StickerMessage[PATCH_INSTALLED_SYMBOL]) {
    return {
      installed: true,
      native: detectNativeStickerAudioSupport(StickerMessage),
      nativeEnvelope134: detectNativeAudioStickerEnvelopeSupport(MessageProto),
    };
  }

  const native = detectNativeStickerAudioSupport(StickerMessage);
  const nativeEnvelope134 = detectNativeAudioStickerEnvelopeSupport(MessageProto);
  const originalStickerEncode = StickerMessage.encode;
  const originalStickerDecode = StickerMessage.decode;
  const originalMessageCreate = MessageProto.create;
  const originalMessageEncode = MessageProto.encode;
  const originalMessageDecode = MessageProto.decode;

  StickerMessage[ORIGINAL_STICKER_ENCODE_SYMBOL] = originalStickerEncode;
  StickerMessage[ORIGINAL_STICKER_DECODE_SYMBOL] = originalStickerDecode;
  MessageProto[ORIGINAL_MESSAGE_CREATE_SYMBOL] = originalMessageCreate;
  MessageProto[ORIGINAL_MESSAGE_ENCODE_SYMBOL] = originalMessageEncode;
  MessageProto[ORIGINAL_MESSAGE_DECODE_SYMBOL] = originalMessageDecode;

  if (!native) {
    StickerMessage.encode = function patchedStickerEncode(
      this: unknown,
      message: proto.Message.IStickerMessage,
      writer?: Parameters<typeof originalStickerEncode>[1],
    ) {
      const resultWriter = originalStickerEncode.call(this, message, writer);
      if (!message) return resultWriter;

      const msgAny = message as unknown as Record<string, unknown>;
      const inlineBytes = msgAny.__stickerWaveAudioBytes;
      const inlineEmojis = Array.isArray(msgAny.__stickerWaveEmojis) ? (msgAny.__stickerWaveEmojis as string[]) : [];
      const inlinePremium = typeof msgAny.__stickerWavePremium === 'boolean' ? msgAny.__stickerWavePremium : false;

      if (inlineBytes instanceof Uint8Array && inlineBytes.byteLength > 0) {
        if (inlinePremium) resultWriter.uint32((STICKER_PREMIUM_FIELD << 3) | 0).bool(false);
        for (const emoji of inlineEmojis) {
          resultWriter.uint32((STICKER_EMOJIS_FIELD << 3) | 2).string(emoji);
        }
        resultWriter.uint32(STICKER_AUDIO_TAG).bytes(inlineBytes);
        return resultWriter;
      }

      if (message.fileSha256) {
        const { compositeKey, shaKey } = buildAttachmentKeys(message.fileSha256, message.fileEncSha256);
        const pending =
          (compositeKey && pendingByCompositeKey.get(compositeKey)) ||
          (shaKey ? pendingByShaKey.get(shaKey) : undefined);
        if (pending && pending.audioBytes.byteLength > 0) {
          if (pending.premium) {
            resultWriter.uint32((STICKER_PREMIUM_FIELD << 3) | 0).bool(false);
          }
          for (const emoji of pending.emojis) {
            resultWriter.uint32((STICKER_EMOJIS_FIELD << 3) | 2).string(emoji);
          }
          resultWriter.uint32(STICKER_AUDIO_TAG).bytes(pending.audioBytes);
        }
      }
      return resultWriter;
    } as typeof StickerMessage.encode;

    StickerMessage.decode = function patchedStickerDecode(
      this: unknown,
      reader: Parameters<typeof originalStickerDecode>[0],
      length?: number,
    ) {
      let rawSlice: Uint8Array | null = null;
      if (reader instanceof Uint8Array) {
        rawSlice = reader;
      } else if (reader && typeof reader === 'object' && 'buf' in reader && reader.buf instanceof Uint8Array) {
        const r = reader as { buf: Uint8Array; pos: number; len: number };
        const end = length === undefined ? r.len : Math.min(r.len, r.pos + length);
        rawSlice = r.buf.subarray(r.pos, end);
      }

      const decoded = originalStickerDecode.call(this, reader, length);
      if (rawSlice && rawSlice.byteLength > 0) {
        try {
          const rawFields = parseRawProtoFields(rawSlice);
          const decodedAny = decoded as unknown as Record<string, unknown>;
          const audioField = findProtoBytesField(rawFields, STICKER_AUDIO_FIELD);
          if (audioField?.payload && audioField.payload.byteLength > 0) {
            decodedAny.audioMessage = waProto.Message.AudioMessage.decode(audioField.payload);
          }
          const emojiFields = rawFields.filter((f) => f.field === STICKER_EMOJIS_FIELD && f.wireType === 'bytes' && f.payload);
          if (emojiFields.length > 0) {
            decodedAny.emojis = emojiFields.map((f) => f.payload!.toString('utf8'));
          }
          const premiumVal = findProtoVarintField(rawFields, STICKER_PREMIUM_FIELD);
          if (premiumVal !== null) {
            decodedAny.premium = Boolean(premiumVal);
          }
        } catch {
          // Leave standard Baileys decoded message untouched on non-matching trailing chunks
        }
      }
      return decoded;
    } as typeof StickerMessage.decode;
  }

  if (!nativeEnvelope134) {
    MessageProto.create = function patchedMessageCreate(
      this: unknown,
      properties?: Parameters<typeof originalMessageCreate>[0],
    ) {
      const created = originalMessageCreate.call(this, properties);
      if (properties && typeof properties === 'object') {
        const propAny = properties as Record<string, unknown>;
        if ('audioStickerMessage' in propAny && propAny.audioStickerMessage) {
          (created as unknown as Record<string, unknown>).audioStickerMessage = propAny.audioStickerMessage;
        }
        const rawSt = propAny.stickerMessage as Record<string, unknown> | undefined;
        if (created.stickerMessage && rawSt?.__stickerWaveAudioBytes) {
          Object.defineProperties(created.stickerMessage, {
            __stickerWaveAudioBytes: { value: rawSt.__stickerWaveAudioBytes, enumerable: false, configurable: true },
            __stickerWaveEmojis: { value: rawSt.__stickerWaveEmojis, enumerable: false, configurable: true },
            __stickerWavePremium: { value: rawSt.__stickerWavePremium, enumerable: false, configurable: true },
          });
        }
      }
      return created;
    } as typeof MessageProto.create;

    MessageProto.encode = function patchedMessageEncode(
      this: unknown,
      message: proto.IMessage,
      writer?: Parameters<typeof originalMessageEncode>[1],
    ) {
      const resultWriter = originalMessageEncode.call(this, message, writer);
      if (!message) return resultWriter;

      const msgAny = message as unknown as Record<string, unknown>;
      const envelope = msgAny.audioStickerMessage as
        | { message?: { stickerMessage?: proto.Message.IStickerMessage } }
        | undefined;
      const innerSticker = envelope?.message?.stickerMessage;
      if (innerSticker) {
        const innerMsgBytes = MessageProto.encode(
          MessageProto.create({ stickerMessage: innerSticker }),
        ).finish();
        const futureProofBytes = encodeVarintTagAndBytes(FUTURE_PROOF_MESSAGE_FIELD, innerMsgBytes);
        resultWriter.uint32((MESSAGE_AUDIO_STICKER_FIELD << 3) | 2).bytes(futureProofBytes);
      }
      return resultWriter;
    } as typeof MessageProto.encode;

    MessageProto.decode = function patchedMessageDecode(
      this: unknown,
      reader: Parameters<typeof originalMessageDecode>[0],
      length?: number,
    ) {
      let rawSlice: Uint8Array | null = null;
      if (reader instanceof Uint8Array) {
        rawSlice = reader;
      } else if (reader && typeof reader === 'object' && 'buf' in reader && reader.buf instanceof Uint8Array) {
        const r = reader as { buf: Uint8Array; pos: number; len: number };
        const end = length === undefined ? r.len : Math.min(r.len, r.pos + length);
        rawSlice = r.buf.subarray(r.pos, end);
      }

      const decoded = originalMessageDecode.call(this, reader, length);
      if (rawSlice && rawSlice.byteLength > 0) {
        try {
          const outerFields = parseRawProtoFields(rawSlice);
          const envelopeField = findProtoBytesField(outerFields, MESSAGE_AUDIO_STICKER_FIELD);
          if (envelopeField?.payload) {
            const fpFields = parseRawProtoFields(envelopeField.payload);
            const innerMsgField = findProtoBytesField(fpFields, FUTURE_PROOF_MESSAGE_FIELD);
            if (innerMsgField?.payload) {
              (decoded as unknown as Record<string, unknown>).audioStickerMessage = {
                message: MessageProto.decode(innerMsgField.payload),
              };
            }
          }
        } catch {
          // Ignore malformed unknown trailing fields
        }
      }
      return decoded;
    } as typeof MessageProto.decode;
  }

  StickerMessage[PATCH_INSTALLED_SYMBOL] = true;
  return { installed: true, native, nativeEnvelope134 };
}

export function attachPendingStickerAudio(
  fileSha256: Uint8Array,
  audioMessageBytes: Uint8Array,
  fileEncSha256?: Uint8Array | null,
  options: { emojis?: string[]; premium?: boolean } = {},
): string {
  if (!fileSha256 || fileSha256.byteLength === 0) {
    throw new Error('Cannot attach sticker audio without valid sticker fileSha256.');
  }
  const { compositeKey, shaKey } = buildAttachmentKeys(fileSha256, fileEncSha256);
  const record: PendingAttachment = {
    audioBytes: audioMessageBytes,
    emojis: options.emojis && options.emojis.length > 0 ? options.emojis : ['🔊'],
    premium: Boolean(options.premium),
    createdAt: Date.now(),
  };
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
 * Wraps an already-encoded outer `proto.Message` (`stickerMessage` #26) inside `FutureProofMessage` (#1)
 * under outer `Message` field #134 (`audioStickerMessage`) when building raw wire envelopes.
 */
export function buildEnvelope134OuterMessageBytes(
  sticker: proto.Message.IStickerMessage,
  audioBytes: Uint8Array,
  emojis: string[] = ['🔊'],
): Buffer {
  ensureStickerAudioProtocolPatch(proto);
  const msgWithMeta = proto.Message.StickerMessage.create(sticker) as proto.Message.StickerMessage &
    Record<string, unknown>;
  msgWithMeta.__stickerWaveAudioBytes = audioBytes;
  msgWithMeta.__stickerWaveEmojis = emojis;
  msgWithMeta.__stickerWavePremium = true;

  const stickerBytes = proto.Message.StickerMessage.encode(msgWithMeta).finish();
  const innerMessageBytes = encodeVarintTagAndBytes(MESSAGE_STICKER_FIELD, stickerBytes);
  const futureProofBytes = encodeVarintTagAndBytes(FUTURE_PROOF_MESSAGE_FIELD, innerMessageBytes);
  return encodeVarintTagAndBytes(MESSAGE_AUDIO_STICKER_FIELD, futureProofBytes);
}

/**
 * Inspects an encoded outer `proto.Message` buffer for BOTH strategies:
 * - Strategy B (`envelope-134`): outer #134 -> #1 -> #26 -> StickerMessage(#24, #25, #26)
 * - Strategy A (`sticker-26`): outer #26 -> StickerMessage(#26)
 */
export function verifyEncodedSoundStickerMessage(encodedOuterMessage: Uint8Array): {
  valid: boolean;
  strategy: SoundStickerProtocolStrategy | null;
  embeddedAudioBytes: number | null;
  decodedAudio: proto.Message.AudioMessage | null;
  emojis: string[];
  premium: number | null;
  reason?: string;
} {
  try {
    const outerFields = parseRawProtoFields(encodedOuterMessage);
    const envelope134 = findProtoBytesField(outerFields, MESSAGE_AUDIO_STICKER_FIELD);

    let strategy: SoundStickerProtocolStrategy;
    let stickerPayload: Buffer | undefined;

    if (envelope134?.payload) {
      strategy = 'envelope-134';
      const fpFields = parseRawProtoFields(envelope134.payload);
      const innerMsg = findProtoBytesField(fpFields, FUTURE_PROOF_MESSAGE_FIELD);
      if (!innerMsg?.payload) {
        return {
          valid: false,
          strategy,
          embeddedAudioBytes: null,
          decodedAudio: null,
          emojis: [],
          premium: null,
          reason: 'Missing FutureProofMessage.message (#1) inside #134 audioStickerMessage.',
        };
      }
      const innerMsgFields = parseRawProtoFields(innerMsg.payload);
      const stickerField = findProtoBytesField(innerMsgFields, MESSAGE_STICKER_FIELD);
      if (!stickerField?.payload) {
        return {
          valid: false,
          strategy,
          embeddedAudioBytes: null,
          decodedAudio: null,
          emojis: [],
          premium: null,
          reason: 'Missing nested Message.stickerMessage (#26) inside #134 envelope.',
        };
      }
      stickerPayload = stickerField.payload;
    } else {
      strategy = 'sticker-26';
      const stickerField = findProtoBytesField(outerFields, MESSAGE_STICKER_FIELD);
      if (!stickerField?.payload) {
        return {
          valid: false,
          strategy: null,
          embeddedAudioBytes: null,
          decodedAudio: null,
          emojis: [],
          premium: null,
          reason: 'Missing outer Message.audioStickerMessage (#134) and Message.stickerMessage (#26).',
        };
      }
      stickerPayload = stickerField.payload;
    }

    const innerFields = parseRawProtoFields(stickerPayload);
    const audioField = findProtoBytesField(innerFields, STICKER_AUDIO_FIELD);
    if (!audioField?.payload || audioField.payload.byteLength === 0) {
      return {
        valid: false,
        strategy,
        embeddedAudioBytes: null,
        decodedAudio: null,
        emojis: [],
        premium: null,
        reason: 'Missing inner StickerMessage.audioMessage (#26).',
      };
    }

    const decodedAudio = proto.Message.AudioMessage.decode(audioField.payload);
    if (!decodedAudio.mimetype?.includes('opus')) {
      return {
        valid: false,
        strategy,
        embeddedAudioBytes: audioField.payload.byteLength,
        decodedAudio,
        emojis: [],
        premium: null,
        reason: 'Embedded AudioMessage missing Opus mimetype.',
      };
    }

    // Round-trip StickerMessage decode verification
    const decodedSticker = proto.Message.StickerMessage.decode(stickerPayload) as proto.Message.StickerMessage & {
      audioMessage?: proto.Message.AudioMessage;
    };
    if (!decodedSticker.audioMessage?.mimetype?.includes('opus')) {
      return {
        valid: false,
        strategy,
        embeddedAudioBytes: audioField.payload.byteLength,
        decodedAudio,
        emojis: [],
        premium: null,
        reason: 'Runtime StickerMessage.decode hook failed to recover audioMessage.',
      };
    }

    const emojis = innerFields
      .filter((f) => f.field === STICKER_EMOJIS_FIELD && f.wireType === 'bytes' && f.payload)
      .map((f) => f.payload!.toString('utf8'));
    const premium = findProtoVarintField(innerFields, STICKER_PREMIUM_FIELD);

    return {
      valid: true,
      strategy,
      embeddedAudioBytes: audioField.payload.byteLength,
      decodedAudio,
      emojis,
      premium,
    };
  } catch (err) {
    return {
      valid: false,
      strategy: null,
      embeddedAudioBytes: null,
      decodedAudio: null,
      emojis: [],
      premium: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Reads audio metadata from a raw wire `StickerMessage` buffer (useful for incoming sticker debugging).
 */
export function inspectRawStickerAudio(
  rawStickerPayload: Uint8Array,
  strategy: SoundStickerProtocolStrategy = 'sticker-26',
): EmbeddedAudioInspection | null {
  try {
    const fields = parseRawProtoFields(rawStickerPayload);
    const shaField = findProtoBytesField(fields, 2);
    const audioField = findProtoBytesField(fields, STICKER_AUDIO_FIELD);
    if (!shaField?.payload || !audioField?.payload) return null;

    const audioFields = parseRawProtoFields(audioField.payload);
    const mimeField = findProtoBytesField(audioFields, 2);
    const emojis = fields
      .filter((f) => f.field === STICKER_EMOJIS_FIELD && f.wireType === 'bytes' && f.payload)
      .map((f) => f.payload!.toString('utf8'));

    return {
      found: true,
      keyBase64: Buffer.from(shaField.payload).toString('base64'),
      byteLength: audioField.payload.byteLength,
      strategy,
      emojis,
      premium: findProtoVarintField(fields, STICKER_PREMIUM_FIELD),
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

  constructor(
    baileysVersion = '7.0.0-rc14',
    public readonly defaultStrategy: SoundStickerProtocolStrategy = 'envelope-134',
  ) {
    const { installed, native, nativeEnvelope134 } = ensureStickerAudioProtocolPatch(proto);
    this.capability = {
      baileysVersion,
      mode: native ? 'native' : installed ? 'patched-encoder' : 'unsupported',
      strategy: defaultStrategy,
      supportedStrategies: ['envelope-134', 'sticker-26'],
      nativeField26Present: native,
      nativeField134Present: nativeEnvelope134,
      patchInstalled: installed,
      fieldNumber: defaultStrategy === 'envelope-134' ? MESSAGE_AUDIO_STICKER_FIELD : STICKER_AUDIO_FIELD,
      wireTag: defaultStrategy === 'envelope-134' ? (MESSAGE_AUDIO_STICKER_FIELD << 3) | 2 : STICKER_AUDIO_TAG,
    };
  }

  buildAudioMessageBytes(
    uploadedAudio: proto.Message.IAudioMessage,
    seconds: number,
    waveform: Uint8Array,
    ptt = true,
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
      ptt,
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
   * Supports both `envelope-134` (`alkhrzmy/wa-sound-sticker` + v2.26.41.6) and `sticker-26`.
   */
  serializeAndVerifySynthetic(params: {
    sticker: proto.Message.IStickerMessage;
    audio: proto.Message.IAudioMessage;
    seconds: number;
    waveform: Uint8Array;
    strategy?: SoundStickerProtocolStrategy;
    emojis?: string[];
  }): { encoded: Buffer; verification: ReturnType<typeof verifyEncodedSoundStickerMessage> } {
    ensureStickerAudioProtocolPatch(proto);
    const strategy = params.strategy ?? this.defaultStrategy;
    const ptt = strategy === 'sticker-26';
    const audioBytes = this.buildAudioMessageBytes(params.audio, params.seconds, params.waveform, ptt);
    const stickerSha = params.sticker.fileSha256;
    if (!stickerSha) throw new Error('Sticker fileSha256 required.');

    attachPendingStickerAudio(stickerSha, audioBytes, params.sticker.fileEncSha256, {
      emojis: params.emojis ?? ['🔊'],
      premium: strategy === 'envelope-134',
    });
    try {
      const msgContent =
        strategy === 'envelope-134'
          ? ({
              audioStickerMessage: {
                message: {
                  stickerMessage: params.sticker,
                },
              },
            } as unknown as proto.IMessage)
          : ({
              stickerMessage: params.sticker,
            } as proto.IMessage);

      const msg = proto.Message.create(msgContent);
      const encoded = Buffer.from(proto.Message.encode(msg).finish());
      const verification = verifyEncodedSoundStickerMessage(encoded);
      return { encoded, verification };
    } finally {
      detachPendingStickerAudio(stickerSha, params.sticker.fileEncSha256);
    }
  }

  /**
   * Uploads WebP sticker + Ogg/Opus audio through Baileys `waUploadToServer`, binds the encoded
   * AudioMessage via Strategy B (`envelope-134`) or Strategy A (`sticker-26`), validates wire serialization,
   * and relays the single Sound Sticker message.
   */
  async sendSoundSticker(params: {
    chatJid: string;
    ownJid: string;
    payload: SoundStickerPayloadInput;
    upload: NonNullable<Parameters<typeof prepareWAMessageMedia>[1]['upload']>;
    relayMessage: (
      jid: string,
      message: proto.IMessage,
      options: { messageId: string; additionalAttributes?: Record<string, string> },
    ) => Promise<string>;
    quoted?: WAMessage;
  }): Promise<{
    messageId: string;
    strategy: SoundStickerProtocolStrategy;
    verification: ReturnType<typeof verifyEncodedSoundStickerMessage>;
  }> {
    ensureStickerAudioProtocolPatch(proto);
    const strategy = params.payload.strategy ?? this.defaultStrategy;
    const uploadOpts = { upload: params.upload };
    const ptt = strategy === 'sticker-26';

    const uploadedAudioMsg = await prepareWAMessageMedia(
      {
        audio: params.payload.oggBuffer,
        mimetype: SOUND_STICKER_AUDIO_MIME,
        seconds: Math.max(1, Math.round(params.payload.seconds)),
        ptt,
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

    uploadedSticker.isAnimated = true;
    uploadedSticker.width = 512;
    uploadedSticker.height = 512;
    if (params.payload.accessibilityLabel) {
      const limit = params.payload.isAnimated ? 250 : 125;
      uploadedSticker.accessibilityLabel = params.payload.accessibilityLabel.slice(0, limit);
    }

    const audioBytes = this.buildAudioMessageBytes(uploadedAudio, params.payload.seconds, params.payload.waveform, ptt);
    const emojis = params.payload.emojis ?? ['🔊'];
    const premium = strategy === 'envelope-134';
    Object.defineProperties(uploadedSticker, {
      __stickerWaveAudioBytes: { value: audioBytes, enumerable: false, configurable: true },
      __stickerWaveEmojis: { value: emojis, enumerable: false, configurable: true },
      __stickerWavePremium: { value: premium, enumerable: false, configurable: true },
    });

    attachPendingStickerAudio(uploadedSticker.fileSha256, audioBytes, uploadedSticker.fileEncSha256, {
      emojis,
      premium,
    });
    try {
      const content =
        strategy === 'envelope-134'
          ? ({
              audioStickerMessage: {
                message: {
                  stickerMessage: uploadedSticker,
                },
              },
            } as unknown as Parameters<typeof generateWAMessageFromContent>[1])
          : ({
              stickerMessage: uploadedSticker,
            } as Parameters<typeof generateWAMessageFromContent>[1]);

      const fullMsg = generateWAMessageFromContent(params.chatJid, content, {
        quoted: params.quoted,
        userJid: params.ownJid,
      });

      if (!fullMsg.message || !fullMsg.key.id) {
        throw new Error('Failed to build outgoing WhatsApp sticker message envelope.');
      }

      // Binary round-trip validation BEFORE network relay so mute stickers never leak silently
      const encoded = Buffer.from(proto.Message.encode(fullMsg.message).finish());
      const verification = verifyEncodedSoundStickerMessage(encoded);
      if (!verification.valid) {
        throw new Error(`Sound sticker protobuf validation failed before send (${strategy}): ${verification.reason}`);
      }

      const relayedId = await params.relayMessage(params.chatJid, fullMsg.message, {
        messageId: fullMsg.key.id,
        additionalAttributes: { mediatype: 'sticker' },
      });

      return {
        messageId: relayedId || fullMsg.key.id,
        strategy,
        verification,
      };
    } finally {
      detachPendingStickerAudio(uploadedSticker.fileSha256, uploadedSticker.fileEncSha256);
    }
  }
}

export { encodeVarintTagAndBytes, encodeVarintTagAndUint };
