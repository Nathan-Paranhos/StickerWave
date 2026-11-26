import fs from 'node:fs/promises';
import path from 'node:path';
import type { StickerShapeOptions } from '@stickerwave/contracts';
import type { FFmpegAdapter } from './ffmpeg-adapter.js';
import { sniffMediaBytes } from './magic-bytes.js';
import { inspectWebpBuffer, type WebpInspection } from './webp-inspector.js';

export const STATIC_QUALITY_LADDER = [78, 65, 52, 38, 24, 12] as const;

export interface ProcessImageOptions {
  targetBytes: number;
  fallbackMaxBytes: number;
  canvasSize?: number;
  shapeOptions?: Partial<StickerShapeOptions>;
  signal?: AbortSignal;
}

export interface ProcessedVisualResult {
  outputPath: string;
  buffer: Buffer;
  inspection: WebpInspection;
  qualityUsed: number;
  fpsUsed: number | null;
  strategy: 'static' | 'animated-direct' | 'animated-planned';
}

function buildStaticFilter(size: number, shapeOptions?: Partial<StickerShapeOptions>): string {
  const shape = shapeOptions?.shape ?? 'square';
  const borderWhite = Boolean(shapeOptions?.borderWhite);
  const bgRaw = shapeOptions?.background;
  const validHexBg = bgRaw && /^#[0-9a-fA-F]{6}$/.test(bgRaw) ? `0x${bgRaw.slice(1)}` : null;

  const padColor = validHexBg || '0x00000000';
  const baseScale = `scale=${size}:${size}:force_original_aspect_ratio=decrease,format=rgba,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`;

  if (shape === 'circle' || borderWhite) {
    // Apply inset when white border requested; keep full transparent RGBA padding for safe stickers.
    const inset = borderWhite ? 10 : 0;
    const innerSize = size - inset * 2;
    const filters = [
      `scale=${innerSize}:${innerSize}:force_original_aspect_ratio=decrease`,
      `format=rgba`,
      `pad=${innerSize}:${innerSize}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`,
    ];
    if (shape === 'circle') {
      const half = innerSize / 2;
      filters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-${half},Y-${half}),${half}),alpha(X,Y),0)'`);
    }
    if (borderWhite) {
      filters.push(`pad=${size}:${size}:${inset}:${inset}:color=0xFFFFFFFF`);
    }
    return filters.join(',');
  }

  return baseScale;
}

/**
 * ImageProcessor converts PNG, JPEG, or WebP static sources into sanitized 512x512 RGBA WebP stickers
 * stripped of EXIF/GPS metadata while preserving transparency and targeting <= 100 KB static limits.
 */
export class ImageProcessor {
  constructor(private readonly ffmpeg: FFmpegAdapter) {}

  async processStaticImage(
    inputPath: string,
    outputPath: string,
    options: ProcessImageOptions,
  ): Promise<ProcessedVisualResult> {
    const header = await fs.readFile(inputPath, { flag: 'r' });
    const sniff = sniffMediaBytes(header);
    if (!['png', 'jpeg', 'webp'].includes(sniff.kind)) {
      throw new Error(`Unsupported static image signature: ${sniff.kind} (${sniff.mime})`);
    }

    const size = options.canvasSize ?? 512;
    const filter = buildStaticFilter(size, options.shapeOptions);

    // Inspect source first with FFprobe so malformed/truncated images fail early cleanly.
    const probed = await this.ffmpeg.probe(inputPath);
    const videoStream = probed.streams?.find((s) => s.codec_type === 'video');
    if (!videoStream || !videoStream.width || !videoStream.height) {
      throw new Error('Static image has no readable pixel stream.');
    }

    let lastBuffer: Buffer | null = null;
    let lastInspection: WebpInspection | null = null;
    let lastQuality: number = STATIC_QUALITY_LADDER[0];

    for (const quality of STATIC_QUALITY_LADDER) {
      options.signal?.throwIfAborted();
      const candidate = `${outputPath}.q${quality}.webp`;
      await this.ffmpeg.run(
        [
          '-i', inputPath,
          '-vframes', '1',
          '-an',
          '-map_metadata', '-1',
          '-vf', filter,
          '-c:v', 'libwebp',
          '-lossless', '0',
          '-compression_level', '4',
          '-q:v', String(quality),
          candidate,
        ],
        { signal: options.signal },
      );

      const buf = await fs.readFile(candidate);
      const inspection = inspectWebpBuffer(buf);
      if (!inspection || !inspection.valid || inspection.width !== size || inspection.height !== size) {
        await fs.rm(candidate, { force: true });
        throw new Error(`Encoded static WebP failed validation (${inspection?.width}x${inspection?.height}).`);
      }

      lastBuffer = buf;
      lastInspection = inspection;
      lastQuality = quality;

      if (buf.byteLength <= options.targetBytes) {
        await fs.rename(candidate, outputPath);
        return {
          outputPath,
          buffer: buf,
          inspection,
          qualityUsed: quality,
          fpsUsed: null,
          strategy: 'static',
        };
      }
      await fs.rm(candidate, { force: true });
    }

    if (lastBuffer && lastInspection && lastBuffer.byteLength <= options.fallbackMaxBytes) {
      await fs.writeFile(outputPath, lastBuffer);
      return {
        outputPath,
        buffer: lastBuffer,
        inspection: lastInspection,
        qualityUsed: lastQuality,
        fpsUsed: null,
        strategy: 'static',
      };
    }

    throw new Error(
      `Static WebP exceeded maximum byte budget (${lastBuffer?.byteLength ?? 0} > ${options.fallbackMaxBytes} bytes).`,
    );
  }
}
