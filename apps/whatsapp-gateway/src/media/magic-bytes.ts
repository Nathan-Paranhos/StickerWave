export type DetectedMediaKind =
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'gif'
  | 'mp4'
  | 'webm'
  | 'wav'
  | 'ogg'
  | 'mp3'
  | 'aac'
  | 'unknown';

export interface MagicSniffResult {
  kind: DetectedMediaKind;
  category: 'visual' | 'audio' | 'container' | 'unknown';
  mime: string;
}

const startsWithAscii = (buf: Uint8Array, offset: number, ascii: string): boolean => {
  if (buf.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (buf[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
};

/**
 * Inspects real magic bytes (header signature) rather than trusting file extension or MIME header.
 */
export function sniffMediaBytes(buffer: Uint8Array): MagicSniffResult {
  if (buffer.length < 4) return { kind: 'unknown', category: 'unknown', mime: 'application/octet-stream' };

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { kind: 'png', category: 'visual', mime: 'image/png' };
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { kind: 'jpeg', category: 'visual', mime: 'image/jpeg' };
  }

  // GIF: GIF87a / GIF89a
  if (startsWithAscii(buffer, 0, 'GIF87a') || startsWithAscii(buffer, 0, 'GIF89a')) {
    return { kind: 'gif', category: 'visual', mime: 'image/gif' };
  }

  // RIFF containers (WEBP or WAV)
  if (buffer.length >= 12 && startsWithAscii(buffer, 0, 'RIFF')) {
    if (startsWithAscii(buffer, 8, 'WEBP')) return { kind: 'webp', category: 'visual', mime: 'image/webp' };
    if (startsWithAscii(buffer, 8, 'WAVE')) return { kind: 'wav', category: 'audio', mime: 'audio/wav' };
  }

  // WebM / Matroska (EBML header: 1A 45 DF A3)
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return { kind: 'webm', category: 'container', mime: 'video/webm' };
  }

  // ISO BMFF / MP4 / M4A (`ftyp` at byte 4)
  if (buffer.length >= 12 && startsWithAscii(buffer, 4, 'ftyp')) {
    const brand = String.fromCharCode(buffer[8] ?? 0, buffer[9] ?? 0, buffer[10] ?? 0, buffer[11] ?? 0);
    if (brand.startsWith('M4A')) return { kind: 'mp4', category: 'audio', mime: 'audio/mp4' };
    return { kind: 'mp4', category: 'container', mime: 'video/mp4' };
  }

  // Ogg container (`OggS`)
  if (startsWithAscii(buffer, 0, 'OggS')) {
    return { kind: 'ogg', category: 'audio', mime: 'audio/ogg' };
  }

  // MP3 (`ID3` tag or MPEG frame sync 11111111 111xxxxx)
  if (startsWithAscii(buffer, 0, 'ID3') || (buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0)) {
    // Distinguish ADTS AAC vs MP3 frame sync gently when possible
    if (buffer[0] === 0xff && (buffer[1]! & 0xf6) === 0xf0) {
      return { kind: 'aac', category: 'audio', mime: 'audio/aac' };
    }
    return { kind: 'mp3', category: 'audio', mime: 'audio/mpeg' };
  }

  return { kind: 'unknown', category: 'unknown', mime: 'application/octet-stream' };
}
