import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { StickerAudioOptions, StickerShapeOptions } from '@stickerwave/contracts';
import type { GatewayConfig } from '../config.js';
import { AnimationProcessor } from './animation-processor.js';
import type { FFmpegAdapter } from './ffmpeg-adapter.js';
import { AudioProcessor, type ProcessedAudioResult } from './audio-processor.js';
import { ImageProcessor, type ProcessedVisualResult } from './image-processor.js';
import { sniffMediaBytes } from './magic-bytes.js';

export interface ProcessStickerMediaRequest {
  visualBytes: Buffer;
  visualOriginalName?: string;
  audioBytes?: Buffer | null;
  audioOriginalName?: string;
  shapeOptions?: Partial<StickerShapeOptions>;
  audioOptions?: StickerAudioOptions;
  signal?: AbortSignal;
  onStage?: (stage: 'VALIDATING' | 'PROCESSING_VISUAL' | 'PROCESSING_AUDIO' | 'ENCODING', progress: number, label: string) => void;
}

export interface ProcessStickerMediaOutput {
  webpBuffer: Buffer;
  oggBuffer: Buffer;
  isAnimated: boolean;
  durationSec: number;
  durationMs: number;
  secondsField: number;
  waveform: Uint8Array;
  visualInspection: ProcessedVisualResult['inspection'];
  audioStats: Pick<ProcessedAudioResult, 'codec' | 'sampleRate' | 'peakDb' | 'meanDb'>;
}

/**
 * Coordinates ImageProcessor, AnimationProcessor, and AudioProcessor in an isolated
 * temporary directory that is unconditionally cleaned up when processing completes or fails.
 */
export class CompositionPipeline {
  public readonly imageProcessor: ImageProcessor;
  public readonly animationProcessor: AnimationProcessor;
  public readonly audioProcessor: AudioProcessor;

  constructor(
    private readonly ffmpeg: FFmpegAdapter,
    private readonly config: GatewayConfig,
  ) {
    this.imageProcessor = new ImageProcessor(ffmpeg);
    this.animationProcessor = new AnimationProcessor(ffmpeg);
    this.audioProcessor = new AudioProcessor(ffmpeg);
  }

  async process(req: ProcessStickerMediaRequest): Promise<ProcessStickerMediaOutput> {
    req.onStage?.('VALIDATING', 10, 'Validando assinaturas binárias e limites');
    if (req.visualBytes.byteLength === 0) {
      throw new Error('Visual payload is empty.');
    }
    if (req.visualBytes.byteLength > this.config.maxVisualUploadBytes) {
      throw new Error(`Visual file exceeds upload cap (${req.visualBytes.byteLength} > ${this.config.maxVisualUploadBytes} bytes).`);
    }
    if (req.audioBytes && req.audioBytes.byteLength > this.config.maxAudioUploadBytes) {
      throw new Error(`Audio file exceeds upload cap (${req.audioBytes.byteLength} > ${this.config.maxAudioUploadBytes} bytes).`);
    }

    const visualSniff = sniffMediaBytes(req.visualBytes);
    if (!['png', 'jpeg', 'webp', 'gif', 'mp4', 'webm'].includes(visualSniff.kind)) {
      throw new Error(`Unsupported visual file signature: ${visualSniff.kind} (${visualSniff.mime}).`);
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stickerwave-gw-'));
    try {
      const visualInPath = path.join(tempDir, `visual-input.${visualSniff.kind}`);
      await fs.writeFile(visualInPath, req.visualBytes);

      const audioSourceBytes = req.audioBytes && req.audioBytes.byteLength > 0 ? req.audioBytes : null;
      let audioInPath: string;

      if (audioSourceBytes) {
        const audioSniff = sniffMediaBytes(audioSourceBytes);
        if (audioSniff.category !== 'audio' && audioSniff.category !== 'container') {
          throw new Error(`Unsupported audio file signature: ${audioSniff.kind} (${audioSniff.mime}).`);
        }
        audioInPath = path.join(tempDir, `audio-input.${audioSniff.kind}`);
        await fs.writeFile(audioInPath, audioSourceBytes);
      } else if (visualSniff.kind === 'mp4' || visualSniff.kind === 'webm') {
        audioInPath = visualInPath;
      } else {
        throw new Error('Audio track is required for a WhatsApp Sound Sticker.');
      }

      // Probe source audio first so duration informs animated visual framing cleanly
      req.onStage?.('PROCESSING_AUDIO', 20, 'Analisando e codificando áudio Ogg/Opus');
      const oggOutPath = path.join(tempDir, 'sticker-audio.ogg');
      const audioRes = await this.audioProcessor.processAudio(audioInPath, oggOutPath, {
        ...(req.audioOptions ?? {}),
        maxDurationSec: this.config.maxSeconds,
        kbps: this.config.audioKbps,
        leadMs: this.config.audioLeadMs,
        maxAudioBytes: this.config.maxAudioBytes,
        signal: req.signal,
      });

      req.onStage?.('PROCESSING_VISUAL', 45, 'Processando camada visual da figurinha');
      const webpOutPath = path.join(tempDir, 'sticker-visual.webp');

      let visualIsAnimated = ['gif', 'mp4', 'webm'].includes(visualSniff.kind);
      if (visualSniff.kind === 'webp') {
        const existing = await this.ffmpeg.probe(visualInPath);
        const nbFrames = Number(existing.streams?.[0]?.nb_frames || 1);
        const dur = Number(existing.format?.duration || 0);
        visualIsAnimated = nbFrames > 1 || dur > 0.05;
      }

      let visualRes: ProcessedVisualResult;
      if (visualIsAnimated) {
        const visualProbe = await this.ffmpeg.probe(visualInPath);
        const visualDur = Number(visualProbe.format?.duration || audioRes.durationSec);
        const targetVisualDur = Math.min(
          this.config.maxSeconds,
          Math.max(0.4, Number.isFinite(visualDur) && visualDur > 0 ? visualDur : audioRes.durationSec),
        );
        visualRes = await this.animationProcessor.processAnimatedMedia(visualInPath, webpOutPath, {
          targetDurationSec: targetVisualDur,
          maxBytes: this.config.maxStickerBytes,
          maxFrames: this.config.maxFrames,
          canvasSize: 512,
          signal: req.signal,
        });
      } else {
        visualRes = await this.imageProcessor.processStaticImage(visualInPath, webpOutPath, {
          targetBytes: this.config.maxStaticStickerBytes,
          fallbackMaxBytes: this.config.maxStickerBytes,
          canvasSize: 512,
          shapeOptions: req.shapeOptions,
          signal: req.signal,
        });
      }

      req.onStage?.('ENCODING', 65, 'Validando pacotes WebP e Ogg/Opus');

      return {
        webpBuffer: visualRes.buffer,
        oggBuffer: audioRes.buffer,
        isAnimated: visualRes.inspection.animated,
        durationSec: audioRes.durationSec,
        durationMs: Math.round(audioRes.durationSec * 1000),
        secondsField: audioRes.secondsField,
        waveform: audioRes.waveform,
        visualInspection: visualRes.inspection,
        audioStats: {
          codec: audioRes.codec,
          sampleRate: audioRes.sampleRate,
          peakDb: audioRes.peakDb,
          meanDb: audioRes.meanDb,
        },
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}
