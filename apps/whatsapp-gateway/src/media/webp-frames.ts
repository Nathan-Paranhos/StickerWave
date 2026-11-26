import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Extracts full-canvas animation frames from a RIFF animated WebP into standalone WebP files + an FFmpeg concat manifest.
 * This ensures compatibility with older FFmpeg builds (e.g. Debian 12 FFmpeg 5.1) whose `webp` demuxer cannot read ANMF streams directly.
 * Returns null if the file is not animated or uses cropped/blended subframes that require native decoding.
 */
export async function extractAnimatedWebpToFfconcat(webpBuffer: Buffer, outputDir: string): Promise<string | null> {
  if (webpBuffer.byteLength < 24) return null;
  const fourCC = (offset: number) =>
    String.fromCharCode(webpBuffer[offset]!, webpBuffer[offset + 1]!, webpBuffer[offset + 2]!, webpBuffer[offset + 3]!);
  if (fourCC(0) !== 'RIFF' || fourCC(8) !== 'WEBP') return null;

  const view = new DataView(webpBuffer.buffer, webpBuffer.byteOffset, webpBuffer.byteLength);
  let canvasWidth = 0;
  let canvasHeight = 0;
  let animated = false;

  const frames: Array<{ durationMs: number; frameBuffer: Buffer }> = [];
  let pos = 12;

  while (pos + 8 <= webpBuffer.byteLength) {
    const tag = fourCC(pos);
    const size = view.getUint32(pos + 4, true);
    const data = pos + 8;
    const next = data + size + (size & 1);
    if (next > webpBuffer.byteLength) break;

    if (tag === 'VP8X' && size >= 10) {
      animated = Boolean(webpBuffer[data]! & 0x02);
      canvasWidth = 1 + (webpBuffer[data + 4]! | (webpBuffer[data + 5]! << 8) | (webpBuffer[data + 6]! << 16));
      canvasHeight = 1 + (webpBuffer[data + 7]! | (webpBuffer[data + 8]! << 8) | (webpBuffer[data + 9]! << 16));
    } else if (tag === 'ANMF' && size >= 16) {
      const fx = (webpBuffer[data]! | (webpBuffer[data + 1]! << 8) | (webpBuffer[data + 2]! << 16)) * 2;
      const fy = (webpBuffer[data + 3]! | (webpBuffer[data + 4]! << 8) | (webpBuffer[data + 5]! << 16)) * 2;
      const fw = 1 + (webpBuffer[data + 6]! | (webpBuffer[data + 7]! << 8) | (webpBuffer[data + 8]! << 16));
      const fh = 1 + (webpBuffer[data + 9]! | (webpBuffer[data + 10]! << 8) | (webpBuffer[data + 11]! << 16));
      const durMs = Math.max(20, webpBuffer[data + 12]! | (webpBuffer[data + 13]! << 8) | (webpBuffer[data + 14]! << 16));
      const disposeReplace = (webpBuffer[data + 15]! & 0x02) !== 0;

      // Only materialize standalone full-canvas frames safely without delta compositing
      if (fx !== 0 || fy !== 0 || (canvasWidth > 0 && fw !== canvasWidth) || (canvasHeight > 0 && fh !== canvasHeight) || !disposeReplace) {
        return null;
      }

      const payloadChunks = webpBuffer.subarray(data + 16, data + size);
      const riffHeader = Buffer.alloc(12);
      riffHeader.write('RIFF', 0, 'ascii');
      riffHeader.writeUInt32LE(4 + payloadChunks.byteLength, 4);
      riffHeader.write('WEBP', 8, 'ascii');
      frames.push({ durationMs: durMs, frameBuffer: Buffer.concat([riffHeader, payloadChunks]) });
    }

    pos = next;
  }

  if (!animated || frames.length < 2) return null;

  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < frames.length; i++) {
    const fileName = `frame-${String(i).padStart(4, '0')}.webp`;
    const filePath = path.join(outputDir, fileName);
    await fs.writeFile(filePath, frames[i]!.frameBuffer);
    lines.push(`file '${filePath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${(frames[i]!.durationMs / 1000).toFixed(3)}`);
  }
  // FFconcat requires repeating the last frame without duration to preserve its display interval cleanly
  const lastPath = path.join(outputDir, `frame-${String(frames.length - 1).padStart(4, '0')}.webp`);
  lines.push(`file '${lastPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);

  const manifestPath = path.join(outputDir, 'frames.ffconcat');
  await fs.writeFile(manifestPath, lines.join('\n'), 'utf8');
  return manifestPath;
}
