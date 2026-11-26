export interface WebpInspection {
  valid: boolean;
  width: number | null;
  height: number | null;
  animated: boolean;
  hasAlpha: boolean;
  frames: number;
  durationMs: number;
  durationSec: number;
  bytes: number;
}

/**
 * Inspects a RIFF WebP container header and animation chunks (`VP8X`, `ALPH`, `ANMF`).
 * Supports static VP8/VP8L/VP8X WebPs as well as multi-frame animated WebPs.
 */
export function inspectWebpBuffer(buffer: Uint8Array): WebpInspection | null {
  if (buffer.length < 12) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const fourCC = (offset: number) =>
    String.fromCharCode(buffer[offset]!, buffer[offset + 1]!, buffer[offset + 2]!, buffer[offset + 3]!);

  if (fourCC(0) !== 'RIFF' || fourCC(8) !== 'WEBP') return null;

  let width: number | null = null;
  let height: number | null = null;
  let animated = false;
  let hasAlpha = false;
  let frames = 0;
  let durationMs = 0;

  let pos = 12;
  while (pos + 8 <= buffer.length) {
    const tag = fourCC(pos);
    const size = view.getUint32(pos + 4, true);
    const data = pos + 8;
    if (data + size > buffer.length) break;

    if (tag === 'VP8X' && size >= 10) {
      const flags = buffer[data]!;
      animated = Boolean(flags & 0x02);
      hasAlpha = Boolean(flags & 0x10);
      width = 1 + (buffer[data + 4]! | (buffer[data + 5]! << 8) | (buffer[data + 6]! << 16));
      height = 1 + (buffer[data + 7]! | (buffer[data + 8]! << 8) | (buffer[data + 9]! << 16));
    } else if (tag === 'VP8L' && size >= 5 && buffer[data] === 0x2f) {
      const bits = view.getUint32(data + 1, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
      hasAlpha = Boolean((bits >> 28) & 1);
    } else if (tag === 'VP8 ' && size >= 10 && buffer[data + 3] === 0x9d && buffer[data + 4] === 0x01 && buffer[data + 5] === 0x2a) {
      width = view.getUint16(data + 6, true) & 0x3fff;
      height = view.getUint16(data + 8, true) & 0x3fff;
    } else if (tag === 'ALPH') {
      hasAlpha = true;
    } else if (tag === 'ANMF' && size >= 16) {
      frames++;
      durationMs += buffer[data + 12]! | (buffer[data + 13]! << 8) | (buffer[data + 14]! << 16);
    }

    pos = data + size + (size & 1);
  }

  return {
    valid: width !== null && height !== null && width > 0 && height > 0,
    width,
    height,
    animated,
    hasAlpha,
    frames: animated ? frames : 1,
    durationMs: animated ? durationMs : 0,
    durationSec: animated ? durationMs / 1000 : 0,
    bytes: buffer.byteLength,
  };
}
