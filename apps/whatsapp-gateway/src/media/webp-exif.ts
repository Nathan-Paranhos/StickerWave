import crypto from 'node:crypto';
import type { StickerMetadata } from '@stickerwave/contracts';

const DEFAULT_ANDROID_LINK = 'https://play.google.com/store/apps/details?id=com.whatsapp';
const DEFAULT_IOS_LINK = 'https://apps.apple.com/app/whatsapp-messenger/id310633997';
const WA_EXIF_TAG_ID = 0x5741;

export interface InjectWhatsAppExifOptions {
  packId?: string;
  packName?: string;
  packPublisher?: string;
  emojis?: string[];
  soundSha256?: string | null;
  androidAppStoreLink?: string;
  iosAppStoreLink?: string;
  /**
   * When positive and the source WebP is static (single VP8/VP8L frame), wraps the frame
   * into a 1-frame animated WebP (`VP8X` animation flag + `ANIM` + `ANMF`) so WhatsApp
   * clients recognize static images paired with sound as animated/playable sound stickers.
   */
  forceAnimatedDurationMs?: number;
}

interface RiffChunk {
  fourCC: string;
  data: Buffer;
}

export function computeSha256Base64(buffer: Uint8Array): string {
  return crypto.createHash('sha256').update(buffer).digest('base64');
}

export function buildWhatsAppStickerMeta(options: InjectWhatsAppExifOptions = {}): Record<string, unknown> {
  const emojis = options.emojis && options.emojis.length > 0 ? options.emojis.slice(0, 3) : ['🔊'];
  const meta: Record<string, unknown> = {
    'sticker-pack-id': options.packId?.trim() || crypto.randomUUID(),
    'sticker-pack-name': options.packName?.trim() || 'StickerWave',
    'sticker-pack-publisher': options.packPublisher?.trim() || 'Nathan Paranhos',
    emojis,
  };
  if (options.soundSha256) {
    meta['sound-sha256'] = options.soundSha256;
  }
  if (options.androidAppStoreLink) {
    meta['android-app-store-link'] = options.androidAppStoreLink;
  }
  if (options.iosAppStoreLink) {
    meta['ios-app-store-link'] = options.iosAppStoreLink;
  }
  return meta;
}

/**
 * Builds the 26-byte big-endian TIFF header + JSON payload for WhatsApp sticker EXIF (`0x5741`).
 */
export function buildWhatsAppExifBuffer(options: InjectWhatsAppExifOptions = {}): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(buildWhatsAppStickerMeta(options)), 'utf8');
  const header = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, // TIFF Big-Endian ("MM", 42)
    0x00, 0x00, 0x00, 0x08, // IFD0 offset = 8
    0x00, 0x01, // 1 IFD entry
    0x57, 0x41, // Tag 0x5741 ("WA")
    0x00, 0x07, // Type 7 = UNDEFINED
    0x00, 0x00, 0x00, 0x00, // Byte count at offset 14 (filled below)
    0x00, 0x00, 0x00, 0x1a, // Value offset at offset 18 = 26
    0x00, 0x00, 0x00, 0x00, // Next IFD = 0 at offset 22
  ]);
  header.writeUInt32BE(jsonBytes.length, 14);
  return Buffer.concat([header, jsonBytes]);
}

function parseRiffChunks(webpBuffer: Buffer): RiffChunk[] {
  if (
    webpBuffer.length < 12 ||
    webpBuffer.toString('ascii', 0, 4) !== 'RIFF' ||
    webpBuffer.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new Error('Invalid RIFF/WEBP container.');
  }

  const chunks: RiffChunk[] = [];
  let offset = 12;
  while (offset + 8 <= webpBuffer.length) {
    const fourCC = webpBuffer.toString('ascii', offset, offset + 4);
    const size = webpBuffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > webpBuffer.length) break;
    chunks.push({ fourCC, data: webpBuffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + (size & 1);
  }
  return chunks;
}

function encodeRiffChunk(fourCC: string, data: Uint8Array): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourCC, 0, 4, 'ascii');
  header.writeUInt32LE(data.byteLength, 4);
  if ((data.byteLength & 1) === 1) {
    return Buffer.concat([header, data, Buffer.from([0])]);
  }
  return Buffer.concat([header, data]);
}

function readDimensionsFromChunks(chunks: readonly RiffChunk[]): {
  width: number;
  height: number;
  hasAlpha: boolean;
  hasIccp: boolean;
  animated: boolean;
} {
  let width = 512;
  let height = 512;
  let hasAlpha = false;
  let hasIccp = false;
  let animated = false;

  for (const chunk of chunks) {
    if (chunk.fourCC === 'VP8X' && chunk.data.length >= 10) {
      const flags = chunk.data[0]!;
      animated = Boolean(flags & 0x02);
      hasAlpha = Boolean(flags & 0x10);
      hasIccp = Boolean(flags & 0x20);
      width = 1 + (chunk.data[4]! | (chunk.data[5]! << 8) | (chunk.data[6]! << 16));
      height = 1 + (chunk.data[7]! | (chunk.data[8]! << 8) | (chunk.data[9]! << 16));
    } else if (chunk.fourCC === 'VP8L' && chunk.data.length >= 5 && chunk.data[0] === 0x2f) {
      const bits = chunk.data.readUInt32LE(1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
      hasAlpha = Boolean((bits >> 28) & 1);
    } else if (
      chunk.fourCC === 'VP8 ' &&
      chunk.data.length >= 10 &&
      chunk.data[3] === 0x9d &&
      chunk.data[4] === 0x01 &&
      chunk.data[5] === 0x2a
    ) {
      width = chunk.data.readUInt16LE(6) & 0x3fff;
      height = chunk.data.readUInt16LE(8) & 0x3fff;
    } else if (chunk.fourCC === 'ALPH') {
      hasAlpha = true;
    } else if (chunk.fourCC === 'ICCP') {
      hasIccp = true;
    }
  }

  return { width, height, hasAlpha, hasIccp, animated };
}

function buildVp8xChunk(width: number, height: number, flags: number): Buffer {
  const payload = Buffer.alloc(10);
  payload[0] = flags;
  const wMinus1 = Math.max(0, width - 1);
  const hMinus1 = Math.max(0, height - 1);
  payload[4] = wMinus1 & 0xff;
  payload[5] = (wMinus1 >> 8) & 0xff;
  payload[6] = (wMinus1 >> 16) & 0xff;
  payload[7] = hMinus1 & 0xff;
  payload[8] = (hMinus1 >> 8) & 0xff;
  payload[9] = (hMinus1 >> 16) & 0xff;
  return payload;
}

/**
 * Extracts WhatsApp custom EXIF JSON (IFD tag `0x5741`) from a WebP container if present.
 */
export function extractWhatsAppExifMeta(webpBuffer: Uint8Array): StickerMetadata | null {
  try {
    const buf = Buffer.isBuffer(webpBuffer)
      ? webpBuffer
      : Buffer.from(webpBuffer.buffer, webpBuffer.byteOffset, webpBuffer.byteLength);
    const chunks = parseRiffChunks(buf);
    const exifChunk = chunks.find((c) => c.fourCC === 'EXIF');
    if (!exifChunk || exifChunk.data.length < 14) return null;

    let tiff = exifChunk.data;
    if (tiff.length >= 6 && tiff.toString('ascii', 0, 6) === 'Exif\x00\x00') {
      tiff = tiff.subarray(6);
    }
    if (tiff.length < 10) return null;

    const endian = tiff.toString('ascii', 0, 2);
    const le = endian === 'II';
    if (!le && endian !== 'MM') return null;

    const readU16 = (off: number) => (le ? tiff.readUInt16LE(off) : tiff.readUInt16BE(off));
    const readU32 = (off: number) => (le ? tiff.readUInt32LE(off) : tiff.readUInt32BE(off));
    if (readU16(2) !== 0x002a) return null;

    const ifdOffset = readU32(4);
    if (ifdOffset + 2 > tiff.length) return null;
    const entries = readU16(ifdOffset);

    for (let i = 0; i < entries; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      if (entryOffset + 12 > tiff.length) break;
      const tag = readU16(entryOffset);
      if (tag !== WA_EXIF_TAG_ID) continue;

      const count = readU32(entryOffset + 4);
      const valueOffset = count <= 4 ? entryOffset + 8 : readU32(entryOffset + 8);
      if (valueOffset + count > tiff.length) return null;

      const jsonText = tiff.subarray(valueOffset, valueOffset + count).toString('utf8').replace(/\0+$/, '');
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      return {
        packId: String(parsed['sticker-pack-id'] || ''),
        packName: String(parsed['sticker-pack-name'] || 'StickerWave'),
        packPublisher: String(parsed['sticker-pack-publisher'] || 'Nathan Paranhos'),
        emojis: Array.isArray(parsed.emojis) ? parsed.emojis.map((e) => String(e)) : [],
        soundSha256: typeof parsed['sound-sha256'] === 'string' ? parsed['sound-sha256'] : null,
        androidAppStoreLink:
          typeof parsed['android-app-store-link'] === 'string'
            ? parsed['android-app-store-link']
            : DEFAULT_ANDROID_LINK,
        iosAppStoreLink:
          typeof parsed['ios-app-store-link'] === 'string' ? parsed['ios-app-store-link'] : DEFAULT_IOS_LINK,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Injects WhatsApp `0x5741` EXIF metadata into a static or animated WebP buffer.
 * Optionally promotes a single-frame static WebP into a 1-frame animated WebP (`VP8X`/`ANIM`/`ANMF`).
 */
export function injectWhatsAppExif(webpBuffer: Buffer, options: InjectWhatsAppExifOptions = {}): Buffer {
  const chunks = parseRiffChunks(webpBuffer);
  const { width, height, hasAlpha, hasIccp, animated } = readDimensionsFromChunks(chunks);
  const exifData = buildWhatsAppExifBuffer(options);
  const withoutExif = chunks.filter((c) => c.fourCC !== 'EXIF' && c.fourCC !== 'VP8X');

  const outChunks: Buffer[] = [];
  const shouldPromoteToAnimated = !animated && Number(options.forceAnimatedDurationMs || 0) > 0;

  if (shouldPromoteToAnimated) {
    const durationMs = Math.max(100, Math.min(0xffffff, Math.round(options.forceAnimatedDurationMs!)));
    const flags = 0x02 | 0x08 | (hasAlpha ? 0x10 : 0) | (hasIccp ? 0x20 : 0);
    outChunks.push(encodeRiffChunk('VP8X', buildVp8xChunk(width, height, flags)));

    for (const chunk of withoutExif) {
      if (chunk.fourCC === 'ICCP') outChunks.push(encodeRiffChunk('ICCP', chunk.data));
    }

    const animPayload = Buffer.alloc(6); // BGRA=0, loopCount=0 (infinite)
    outChunks.push(encodeRiffChunk('ANIM', animPayload));

    const frameHeader = Buffer.alloc(16);
    const wMinus1 = Math.max(0, width - 1);
    const hMinus1 = Math.max(0, height - 1);
    frameHeader[6] = wMinus1 & 0xff;
    frameHeader[7] = (wMinus1 >> 8) & 0xff;
    frameHeader[8] = (wMinus1 >> 16) & 0xff;
    frameHeader[9] = hMinus1 & 0xff;
    frameHeader[10] = (hMinus1 >> 8) & 0xff;
    frameHeader[11] = (hMinus1 >> 16) & 0xff;
    frameHeader[12] = durationMs & 0xff;
    frameHeader[13] = (durationMs >> 8) & 0xff;
    frameHeader[14] = (durationMs >> 16) & 0xff;
    frameHeader[15] = 0x02; // replace frame, no alpha blending over previous

    const frameParts: Buffer[] = [frameHeader];
    for (const chunk of withoutExif) {
      if (chunk.fourCC === 'ALPH' || chunk.fourCC === 'VP8 ' || chunk.fourCC === 'VP8L') {
        frameParts.push(encodeRiffChunk(chunk.fourCC, chunk.data));
      }
    }
    if (frameParts.length === 1) {
      throw new Error('Static WebP does not contain VP8/VP8L bitstream chunk.');
    }
    outChunks.push(encodeRiffChunk('ANMF', Buffer.concat(frameParts)));
  } else {
    const existingVp8x = chunks.find((c) => c.fourCC === 'VP8X');
    const baseFlags = existingVp8x && existingVp8x.data.length >= 1 ? existingVp8x.data[0]! : 0;
    const flags = baseFlags | 0x08 | (animated ? 0x02 : 0) | (hasAlpha ? 0x10 : 0) | (hasIccp ? 0x20 : 0);
    outChunks.push(encodeRiffChunk('VP8X', buildVp8xChunk(width, height, flags)));
    for (const chunk of withoutExif) {
      outChunks.push(encodeRiffChunk(chunk.fourCC, chunk.data));
    }
  }

  outChunks.push(encodeRiffChunk('EXIF', exifData));
  const body = Buffer.concat(outChunks);
  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0, 4, 'ascii');
  riffHeader.writeUInt32LE(4 + body.byteLength, 4);
  riffHeader.write('WEBP', 8, 4, 'ascii');
  return Buffer.concat([riffHeader, body]);
}
