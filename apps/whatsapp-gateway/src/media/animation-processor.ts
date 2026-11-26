import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FFmpegAdapter } from './ffmpeg-adapter.js';
import type { ProcessedVisualResult } from './image-processor.js';
import { sniffMediaBytes } from './magic-bytes.js';
import { inspectWebpBuffer } from './webp-inspector.js';

export const FPS_LADDER = [15, 12, 10, 8, 6, 5] as const;
export const ANIM_QUALITY_LADDER = [75, 60, 45, 30, 20, 12, 6, 2] as const;
const QUALITY_FLOORS = [30, 12] as const;
const BUDGET_SAFETY_RATIO = 0.94;
const DIRECT_SHORT_SECONDS = 6;
const DIRECT_PRESET = { fps: 15, quality: 50 } as const;

export interface ProcessAnimationOptions {
  targetDurationSec: number;
  maxBytes: number;
  maxFrames: number;
  canvasSize?: number;
  signal?: AbortSignal;
}

export interface EncodingPlan {
  fps: number;
  quality: number;
  predictedBytes: number;
  fitsBudget: boolean;
}

export function planAnimationEncoding(input: {
  durationSec: number;
  bytesPerFrame: Record<number, number>;
  budgetBytes: number;
  maxFrames: number;
}): EncodingPlan {
  const allowedFps = FPS_LADDER.filter((fps) => Math.ceil(fps * input.durationSec) <= input.maxFrames);
  const fpsOptions = allowedFps.length > 0 ? allowedFps : [FPS_LADDER[FPS_LADDER.length - 1]!];
  const qualities = ANIM_QUALITY_LADDER.filter((q) => Number.isFinite(input.bytesPerFrame[q]));

  const predict = (fps: number, quality: number) =>
    Math.round((input.bytesPerFrame[quality] ?? 5000) * Math.max(1, fps * input.durationSec));

  for (const floor of QUALITY_FLOORS) {
    for (const fps of fpsOptions) {
      for (const quality of qualities) {
        if (quality < floor) break;
        const predictedBytes = predict(fps, quality);
        if (predictedBytes <= input.budgetBytes) {
          return { fps, quality, predictedBytes, fitsBudget: true };
        }
      }
    }
  }

  const lowestFps = fpsOptions[fpsOptions.length - 1]!;
  for (const quality of qualities) {
    const predictedBytes = predict(lowestFps, quality);
    if (predictedBytes <= input.budgetBytes) {
      return { fps: lowestFps, quality, predictedBytes, fitsBudget: true };
    }
  }

  const lowestQuality = qualities[qualities.length - 1] ?? ANIM_QUALITY_LADDER[ANIM_QUALITY_LADDER.length - 1]!;
  return {
    fps: lowestFps,
    quality: lowestQuality,
    predictedBytes: predict(lowestFps, lowestQuality),
    fitsBudget: false,
  };
}

export function nextLighterAnimationSetting(current: { fps: number; quality: number }): { fps: number; quality: number } | null {
  const lowerQuality = ANIM_QUALITY_LADDER.find((q) => q < current.quality);
  const lowerFps = FPS_LADDER.find((f) => f < current.fps);
  if (lowerQuality !== undefined && current.quality > 12) {
    return { fps: current.fps, quality: lowerQuality };
  }
  if (lowerFps !== undefined) {
    return { fps: lowerFps, quality: current.quality };
  }
  if (lowerQuality !== undefined) {
    return { fps: current.fps, quality: lowerQuality };
  }
  return null;
}

function buildAnimationFilter(fps: number, size: number): string {
  return (
    `fps=${fps},scale=${size}:${size}:force_original_aspect_ratio=decrease,` +
    `format=rgba,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`
  );
}

/**
 * AnimationProcessor converts GIF, MP4, WebM, and animated WebP into 512x512 RGBA looping WebP
 * using independent keyframes (`libwebp`, avoiding `libwebp_anim` delta trails) within WhatsApp byte limits.
 */
export class AnimationProcessor {
  constructor(private readonly ffmpeg: FFmpegAdapter) {}

  private async encodeOnce(
    inputPath: string,
    outputPath: string,
    params: { fps: number; quality: number; durationSec?: number; size: number; signal?: AbortSignal },
  ): Promise<number> {
    await this.ffmpeg.run(
      [
        ...(params.durationSec ? ['-t', params.durationSec.toFixed(3)] : []),
        '-i', inputPath,
        '-an',
        '-map_metadata', '-1',
        '-c:v', 'libwebp',
        '-lossless', '0',
        '-q:v', String(params.quality),
        '-compression_level', '4',
        '-vf', buildAnimationFilter(params.fps, params.size),
        '-loop', '0',
        outputPath,
      ],
      { signal: params.signal, timeoutMs: 60_000 },
    );
    const stat = await fs.stat(outputPath);
    return stat.size;
  }

  private async measureBytesPerFrame(
    inputPath: string,
    tempBasePath: string,
    durationSec: number,
    size: number,
    signal?: AbortSignal,
  ): Promise<Record<number, number>> {
    const samplePath = `${tempBasePath}.sample.mkv`;
    const sampleFps = 10;
    const windowsCount = 3;
    const winSec = 1;
    const windows =
      durationSec <= windowsCount * winSec
        ? [{ start: 0, end: durationSec }]
        : Array.from({ length: windowsCount }, (_, i) => {
            const start = ((durationSec - winSec) * (i + 0.5)) / windowsCount;
            return { start, end: start + winSec };
          });
    const selectExpr = windows.map((w) => `between(t,${w.start.toFixed(3)},${w.end.toFixed(3)})`).join('+');

    try {
      await this.ffmpeg.run(
        [
          '-t', durationSec.toFixed(3),
          '-i', inputPath,
          '-an',
          '-vf',
          `fps=${sampleFps},select='${selectExpr}',setpts=N/(${sampleFps}*TB),scale=${size}:${size}:force_original_aspect_ratio=decrease,format=rgba`,
          '-c:v', 'ffv1',
          samplePath,
        ],
        { signal, timeoutMs: 45_000 },
      );

      const parallelism = Math.max(1, Math.min(4, os.availableParallelism ? os.availableParallelism() : 2));
      const results: Array<[number, number]> = [];
      let cursor = 0;

      const worker = async () => {
        while (cursor < ANIM_QUALITY_LADDER.length) {
          signal?.throwIfAborted();
          const q = ANIM_QUALITY_LADDER[cursor++]!;
          const outSample = `${tempBasePath}.q${q}.webp`;
          try {
            const bytes = await this.encodeOnce(samplePath, outSample, { fps: sampleFps, quality: q, size, signal });
            const buf = await fs.readFile(outSample);
            const info = inspectWebpBuffer(buf);
            results.push([q, bytes / Math.max(1, info ? info.frames : 1)]);
          } finally {
            await fs.rm(outSample, { force: true });
          }
        }
      };

      await Promise.all(Array.from({ length: parallelism }, worker));
      return Object.fromEntries(results);
    } finally {
      await fs.rm(samplePath, { force: true });
    }
  }

  async processAnimatedMedia(
    inputPath: string,
    outputPath: string,
    options: ProcessAnimationOptions,
  ): Promise<ProcessedVisualResult> {
    const header = await fs.readFile(inputPath, { flag: 'r' });
    const sniff = sniffMediaBytes(header);
    if (!['gif', 'mp4', 'webm', 'webp'].includes(sniff.kind)) {
      throw new Error(`Unsupported animated media signature: ${sniff.kind} (${sniff.mime})`);
    }

    const size = options.canvasSize ?? 512;
    const durationSec = Math.max(0.2, options.targetDurationSec);

    if (durationSec <= DIRECT_SHORT_SECONDS && Math.ceil(DIRECT_PRESET.fps * durationSec) <= options.maxFrames) {
      const bytes = await this.encodeOnce(inputPath, outputPath, {
        fps: DIRECT_PRESET.fps,
        quality: DIRECT_PRESET.quality,
        durationSec,
        size,
        signal: options.signal,
      });
      if (bytes <= options.maxBytes) {
        const buffer = await fs.readFile(outputPath);
        const inspection = inspectWebpBuffer(buffer);
        if (inspection && inspection.valid && inspection.width === size && inspection.height === size) {
          return {
            outputPath,
            buffer,
            inspection,
            qualityUsed: DIRECT_PRESET.quality,
            fpsUsed: DIRECT_PRESET.fps,
            strategy: 'animated-direct',
          };
        }
      }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-anim-'));
    try {
      const tempBase = path.join(tempDir, 'work');
      const bytesPerFrame = await this.measureBytesPerFrame(inputPath, tempBase, durationSec, size, options.signal);
      let setting: { fps: number; quality: number } | null = planAnimationEncoding({
        durationSec,
        bytesPerFrame,
        budgetBytes: Math.floor(options.maxBytes * BUDGET_SAFETY_RATIO),
        maxFrames: options.maxFrames,
      });

      let attempts = 0;
      let lastResult: { fps: number; quality: number; bytes: number } | null = null;
      while (setting && attempts < 5) {
        options.signal?.throwIfAborted();
        attempts++;
        const bytes = await this.encodeOnce(inputPath, outputPath, {
          fps: setting.fps,
          quality: setting.quality,
          durationSec,
          size,
          signal: options.signal,
        });
        lastResult = { ...setting, bytes };
        if (bytes <= options.maxBytes) {
          const buffer = await fs.readFile(outputPath);
          const inspection = inspectWebpBuffer(buffer);
          if (!inspection || !inspection.valid || inspection.width !== size || inspection.height !== size) {
            throw new Error(`Animated WebP validation failed (${inspection?.width}x${inspection?.height}).`);
          }
          return {
            outputPath,
            buffer,
            inspection,
            qualityUsed: setting.quality,
            fpsUsed: setting.fps,
            strategy: 'animated-planned',
          };
        }
        setting = nextLighterAnimationSetting(setting);
      }

      throw new Error(
        `Animated WebP exceeded budget even at lowest quality (${lastResult?.bytes ?? 0} > ${options.maxBytes} bytes).`,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}
