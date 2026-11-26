import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CloudMediaFormat,
  EncodedSoundSticker,
  SoundStickerProtocolStrategy,
  StickerAudioOptions,
  StickerMetadata,
  StickerShapeOptions,
  StickerType,
  StickerValidationReport,
} from '@stickerwave/contracts';
import type { GatewayConfig } from '../config.js';
import { createStoredZip } from '../utils/zip-store.js';
import { AnimationProcessor } from './animation-processor.js';
import type { FFmpegAdapter } from './ffmpeg-adapter.js';
import { AudioProcessor, type ProcessedAudioResult } from './audio-processor.js';
import { ImageProcessor, type ProcessedVisualResult } from './image-processor.js';
import { sniffMediaBytes, type DetectedMediaKind } from './magic-bytes.js';
import { validateEncodedSticker } from './sticker-validator.js';
import { computeSha256Base64, injectWhatsAppExif } from './webp-exif.js';
import { extractAnimatedWebpToFfconcat } from './webp-frames.js';
import { inspectWebpBuffer } from './webp-inspector.js';

export interface ProcessStickerMediaRequest {
  visualBytes: Buffer;
  visualOriginalName?: string;
  audioBytes?: Buffer | null;
  audioOriginalName?: string;
  shapeOptions?: Partial<StickerShapeOptions>;
  audioOptions?: StickerAudioOptions;
  metadata?: Partial<StickerMetadata>;
  protocolStrategy?: SoundStickerProtocolStrategy;
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
  exifMeta: StickerMetadata | null;
  validation: StickerValidationReport;
  audioStats: Pick<ProcessedAudioResult, 'codec' | 'sampleRate' | 'peakDb' | 'meanDb'>;
}

export interface ProcessCloudMediaRequest {
  format: CloudMediaFormat;
  visualBytes?: Buffer | null;
  audioBytes?: Buffer | null;
  title?: string;
  shapeOptions?: Partial<StickerShapeOptions>;
  audioOptions?: StickerAudioOptions;
  signal?: AbortSignal;
}

export interface ProcessCloudMediaOutput {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  isAnimated: boolean;
  durationMs: number;
}

/**
 * Coordinates ImageProcessor, AnimationProcessor, AudioProcessor, and Cloud export formats
 * (WebP, Ogg/Opus, MP4 Sticker Card, and `.wastickers` packs) in an isolated temp directory.
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

  private async prepareVisualInput(
    tempDir: string,
    visualBytes: Buffer,
    signal?: AbortSignal,
  ): Promise<{ visualPath: string; visualKind: DetectedMediaKind; isAnimated: boolean; durationSec: number | null }> {
    if (visualBytes.byteLength === 0) {
      throw new Error('Visual payload is empty.');
    }
    if (visualBytes.byteLength > this.config.maxVisualUploadBytes) {
      throw new Error(`Visual file exceeds upload cap (${visualBytes.byteLength} > ${this.config.maxVisualUploadBytes} bytes).`);
    }

    const visualSniff = sniffMediaBytes(visualBytes);
    if (!['png', 'jpeg', 'webp', 'gif', 'mp4', 'webm'].includes(visualSniff.kind)) {
      throw new Error(`Unsupported visual file signature: ${visualSniff.kind} (${visualSniff.mime}).`);
    }

    const rawPath = path.join(tempDir, `visual-input.${visualSniff.kind}`);
    await fs.writeFile(rawPath, visualBytes);

    let isAnimated = ['gif', 'mp4', 'webm'].includes(visualSniff.kind);
    let durationSec: number | null = null;
    let resolvedPath = rawPath;

    if (visualSniff.kind === 'webp') {
      const info = inspectWebpBuffer(visualBytes);
      isAnimated = Boolean(info?.animated);
      if (isAnimated) {
        durationSec = info && info.durationSec > 0 ? info.durationSec : null;
        const canNativeDecode = await this.ffmpeg
          .probe(rawPath)
          .then((p) => Number(p.streams?.[0]?.nb_frames || 0) > 1 || Number(p.format?.duration || 0) > 0.05)
          .catch(() => false);

        if (!canNativeDecode) {
          const framesDir = path.join(tempDir, 'webp-frames');
          await fs.mkdir(framesDir, { recursive: true });
          const manifestPath = await extractAnimatedWebpToFfconcat(visualBytes, framesDir);
          if (manifestPath) {
            const mkvPath = path.join(tempDir, 'visual-normalized.mkv');
            await this.ffmpeg.run(
              ['-f', 'concat', '-safe', '0', '-i', manifestPath, '-an', '-c:v', 'ffv1', '-pix_fmt', 'bgra', mkvPath],
              { signal, timeoutMs: 45_000 },
            );
            resolvedPath = mkvPath;
          }
        }
      }
    }

    if (isAnimated && durationSec === null) {
      const probed = await this.ffmpeg.probe(resolvedPath).catch(() => null);
      const probedDur = Number(probed?.format?.duration || 0);
      durationSec = Number.isFinite(probedDur) && probedDur > 0 ? probedDur : null;
    }

    return { visualPath: resolvedPath, visualKind: visualSniff.kind, isAnimated, durationSec };
  }

  private async prepareAudioInput(
    tempDir: string,
    audioBytes: Buffer | null | undefined,
    fallbackVisualPath: string | null,
    fallbackVisualKind: DetectedMediaKind | null,
    audioOptions: StickerAudioOptions | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ProcessedAudioResult> {
    let audioInPath: string;
    const hasAudioBytes = Boolean(audioBytes && audioBytes.byteLength > 0);
    if (hasAudioBytes) {
      if (audioBytes!.byteLength > this.config.maxAudioUploadBytes) {
        throw new Error(`Audio file exceeds upload cap (${audioBytes!.byteLength} > ${this.config.maxAudioUploadBytes} bytes).`);
      }
      const audioSniff = sniffMediaBytes(audioBytes!);
      if (audioSniff.category !== 'audio' && audioSniff.category !== 'container') {
        throw new Error(`Unsupported audio file signature: ${audioSniff.kind} (${audioSniff.mime}).`);
      }
      audioInPath = path.join(tempDir, `audio-input.${audioSniff.kind}`);
      await fs.writeFile(audioInPath, audioBytes!);
    } else if (fallbackVisualPath && (fallbackVisualKind === 'mp4' || fallbackVisualKind === 'webm')) {
      audioInPath = fallbackVisualPath;
    } else {
      throw new Error('Audio track is required for a WhatsApp Sound Sticker.');
    }

    const oggOutPath = path.join(tempDir, 'sticker-audio.ogg');
    return this.audioProcessor.processAudio(audioInPath, oggOutPath, {
      ...(audioOptions ?? {}),
      maxDurationSec: this.config.maxSeconds,
      kbps: this.config.audioKbps,
      leadMs: this.config.audioLeadMs,
      maxAudioBytes: this.config.maxAudioBytes,
      signal,
    });
  }

  private async encodeVisualToWebp(
    tempDir: string,
    prepared: { visualPath: string; isAnimated: boolean; durationSec: number | null },
    targetDurationSec: number,
    shapeOptions: Partial<StickerShapeOptions> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ProcessedVisualResult> {
    const webpOutPath = path.join(tempDir, 'sticker-visual.webp');
    if (prepared.isAnimated) {
      const targetVisualDur = Math.min(
        this.config.maxSeconds,
        Math.max(0.4, prepared.durationSec ?? targetDurationSec),
      );
      return this.animationProcessor.processAnimatedMedia(prepared.visualPath, webpOutPath, {
        targetDurationSec: targetVisualDur,
        maxBytes: this.config.maxStickerBytes,
        maxFrames: this.config.maxFrames,
        canvasSize: 512,
        signal,
      });
    }
    return this.imageProcessor.processStaticImage(prepared.visualPath, webpOutPath, {
      targetBytes: this.config.maxStaticStickerBytes,
      fallbackMaxBytes: this.config.maxStickerBytes,
      canvasSize: 512,
      shapeOptions,
      signal,
    });
  }

  async process(req: ProcessStickerMediaRequest): Promise<ProcessStickerMediaOutput> {
    req.onStage?.('VALIDATING', 10, 'Validando assinaturas binárias e limites');
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stickerwave-gw-'));
    try {
      const prepared = await this.prepareVisualInput(tempDir, req.visualBytes, req.signal);

      req.onStage?.('PROCESSING_AUDIO', 20, 'Analisando e codificando áudio Ogg/Opus');
      const audioRes = await this.prepareAudioInput(
        tempDir,
        req.audioBytes,
        prepared.visualPath,
        prepared.visualKind,
        req.audioOptions,
        req.signal,
      );

      req.onStage?.('PROCESSING_VISUAL', 45, 'Processando camada visual da figurinha');
      const visualRes = await this.encodeVisualToWebp(
        tempDir,
        prepared,
        audioRes.durationSec,
        req.shapeOptions,
        req.signal,
      );

      req.onStage?.('ENCODING', 65, 'Injetando EXIF 0x5741 e validando pacotes WebP + Ogg/Opus');
      const soundSha256 = computeSha256Base64(audioRes.buffer);
      const durationMs = Math.max(500, Math.round(audioRes.durationSec * 1000));
      const webpWithExif = injectWhatsAppExif(visualRes.buffer, {
        packId: req.metadata?.packId,
        packName: req.metadata?.packName || 'StickerWave',
        packPublisher: req.metadata?.packPublisher || 'Nathan Paranhos',
        emojis: req.metadata?.emojis?.length ? req.metadata.emojis : ['🔊'],
        soundSha256,
        forceAnimatedDurationMs: visualRes.inspection.animated ? undefined : durationMs,
      });
      const finalWebp =
        webpWithExif.byteLength <= this.config.maxStickerBytes ? webpWithExif : visualRes.buffer;
      const finalInspection = inspectWebpBuffer(finalWebp) ?? visualRes.inspection;
      const validation = validateEncodedSticker({
        webpBuffer: finalWebp,
        oggBuffer: audioRes.buffer,
        stickerType: 'SOUND',
        durationMs,
        maxWebpStaticBytes: this.config.maxStaticStickerBytes,
        maxWebpAnimatedBytes: this.config.maxStickerBytes,
        maxAudioBytes: this.config.maxAudioBytes,
        maxDurationMs: this.config.maxSeconds * 1000,
      });

      return {
        webpBuffer: finalWebp,
        oggBuffer: audioRes.buffer,
        isAnimated: finalInspection.animated,
        durationSec: audioRes.durationSec,
        durationMs,
        secondsField: audioRes.secondsField,
        waveform: audioRes.waveform,
        visualInspection: finalInspection,
        exifMeta: finalInspection.exifMeta ?? null,
        validation,
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

  /**
   * Produces a unified `EncodedSoundSticker` artifact for STATIC, ANIMATED, or SOUND stickers
   * cleanly separated from WhatsApp network transport.
   */
  async processInternalSticker(req: ProcessStickerMediaRequest): Promise<{
    encodedSticker: EncodedSoundSticker;
    webpBuffer: Buffer;
    oggBuffer: Buffer | null;
  }> {
    const hasAudio = Boolean(req.audioBytes && req.audioBytes.byteLength > 0);
    const protocolStrategy: SoundStickerProtocolStrategy =
      req.protocolStrategy ?? this.config.soundStickerProtocol;

    if (hasAudio) {
      const processed = await this.process(req);
      return {
        webpBuffer: processed.webpBuffer,
        oggBuffer: processed.oggBuffer,
        encodedSticker: {
          stickerType: 'SOUND',
          protocolStrategy,
          width: processed.visualInspection.width ?? 512,
          height: processed.visualInspection.height ?? 512,
          animated: processed.isAnimated,
          hasAudio: true,
          durationMs: processed.durationMs,
          webpBytes: processed.webpBuffer.byteLength,
          oggBytes: processed.oggBuffer.byteLength,
          exifMeta: processed.exifMeta,
          waveform: Array.from(processed.waveform),
          validation: processed.validation,
          webpBase64: processed.webpBuffer.toString('base64'),
          oggBase64: processed.oggBuffer.toString('base64'),
        },
      };
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stickerwave-core-'));
    try {
      const prepared = await this.prepareVisualInput(tempDir, req.visualBytes, req.signal);
      let audioRes: ProcessedAudioResult | null = null;
      if (prepared.visualKind === 'mp4' || prepared.visualKind === 'webm') {
        audioRes = await this.prepareAudioInput(
          tempDir,
          null,
          prepared.visualPath,
          prepared.visualKind,
          req.audioOptions,
          req.signal,
        ).catch((err) => {
          if (err instanceof Error && err.message.includes('no audio stream')) return null;
          throw err;
        });
      }

      const defaultDur = audioRes?.durationSec ?? prepared.durationSec ?? 3;
      const visualRes = await this.encodeVisualToWebp(tempDir, prepared, defaultDur, req.shapeOptions, req.signal);
      const stickerType: StickerType = audioRes
        ? 'SOUND'
        : visualRes.inspection.animated
          ? 'ANIMATED'
          : 'STATIC';
      const durationMs = Math.round((audioRes?.durationSec ?? visualRes.inspection.durationSec) * 1000);
      const soundSha256 = audioRes ? computeSha256Base64(audioRes.buffer) : null;
      const webpWithExif = injectWhatsAppExif(visualRes.buffer, {
        packId: req.metadata?.packId,
        packName: req.metadata?.packName || 'StickerWave',
        packPublisher: req.metadata?.packPublisher || 'Nathan Paranhos',
        emojis: req.metadata?.emojis?.length ? req.metadata.emojis : audioRes ? ['🔊'] : ['✨'],
        soundSha256,
        forceAnimatedDurationMs:
          audioRes && !visualRes.inspection.animated ? Math.max(500, durationMs) : undefined,
      });
      const sizeCap =
        stickerType === 'STATIC' ? this.config.maxStaticStickerBytes : this.config.maxStickerBytes;
      const finalWebp = webpWithExif.byteLength <= sizeCap ? webpWithExif : visualRes.buffer;
      const finalInspection = inspectWebpBuffer(finalWebp) ?? visualRes.inspection;
      const validation = validateEncodedSticker({
        webpBuffer: finalWebp,
        oggBuffer: audioRes?.buffer ?? null,
        stickerType,
        durationMs,
        maxWebpStaticBytes: this.config.maxStaticStickerBytes,
        maxWebpAnimatedBytes: this.config.maxStickerBytes,
        maxAudioBytes: this.config.maxAudioBytes,
        maxDurationMs: this.config.maxSeconds * 1000,
      });

      return {
        webpBuffer: finalWebp,
        oggBuffer: audioRes?.buffer ?? null,
        encodedSticker: {
          stickerType,
          protocolStrategy,
          width: finalInspection.width ?? 512,
          height: finalInspection.height ?? 512,
          animated: finalInspection.animated,
          hasAudio: Boolean(audioRes),
          durationMs,
          webpBytes: finalWebp.byteLength,
          oggBytes: audioRes?.buffer.byteLength ?? 0,
          exifMeta: finalInspection.exifMeta ?? null,
          waveform: audioRes ? Array.from(audioRes.waveform) : [],
          validation,
          webpBase64: finalWebp.toString('base64'),
          oggBase64: audioRes ? audioRes.buffer.toString('base64') : null,
        },
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  async renderCloudMedia(req: ProcessCloudMediaRequest): Promise<ProcessCloudMediaOutput> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stickerwave-cloud-'));
    try {
      const hasVisual = Boolean(req.visualBytes && req.visualBytes.byteLength > 0);
      const hasAudio = Boolean(req.audioBytes && req.audioBytes.byteLength > 0);

      if (req.format === 'opus') {
        let preparedPath: string | null = null;
        let preparedKind: DetectedMediaKind | null = null;
        if (!hasAudio && hasVisual) {
          const vis = await this.prepareVisualInput(tempDir, req.visualBytes!, req.signal);
          preparedPath = vis.visualPath;
          preparedKind = vis.visualKind;
        }
        const audioRes = await this.prepareAudioInput(
          tempDir,
          req.audioBytes,
          preparedPath,
          preparedKind,
          req.audioOptions,
          req.signal,
        );
        return {
          buffer: audioRes.buffer,
          mimeType: 'audio/ogg; codecs=opus',
          extension: 'ogg',
          isAnimated: false,
          durationMs: Math.round(audioRes.durationSec * 1000),
        };
      }

      if (!hasVisual) {
        throw new Error('Visual file is required for WebP, MP4, or .wastickers rendering.');
      }

      const prepared = await this.prepareVisualInput(tempDir, req.visualBytes!, req.signal);

      let audioRes: ProcessedAudioResult | null = null;
      if (hasAudio || ((prepared.visualKind === 'mp4' || prepared.visualKind === 'webm') && req.format === 'mp4')) {
        audioRes = await this.prepareAudioInput(
          tempDir,
          req.audioBytes,
          prepared.visualPath,
          prepared.visualKind,
          req.audioOptions,
          req.signal,
        ).catch((err) => {
          // Video visuals without an audio stream are valid silent MP4 exports
          if (!hasAudio && err instanceof Error && err.message.includes('no audio stream')) return null;
          throw err;
        });
      }

      if (req.format === 'webp') {
        const defaultDur = audioRes?.durationSec ?? prepared.durationSec ?? 3;
        const visualRes = await this.encodeVisualToWebp(tempDir, prepared, defaultDur, req.shapeOptions, req.signal);
        const withExif = injectWhatsAppExif(visualRes.buffer, {
          packName: req.title || 'StickerWave',
          packPublisher: 'Nathan Paranhos',
          emojis: visualRes.inspection.animated ? ['✨'] : ['🙂'],
        });
        const cap = visualRes.inspection.animated ? this.config.maxStickerBytes : this.config.maxStaticStickerBytes;
        const finalWebp = withExif.byteLength <= cap ? withExif : visualRes.buffer;
        return {
          buffer: finalWebp,
          mimeType: 'image/webp',
          extension: 'webp',
          isAnimated: visualRes.inspection.animated,
          durationMs: Math.round((audioRes?.durationSec ?? visualRes.inspection.durationSec) * 1000),
        };
      }

      if (req.format === 'wastickers') {
        const defaultDur = audioRes?.durationSec ?? prepared.durationSec ?? 3;
        const visualRes = await this.encodeVisualToWebp(tempDir, prepared, defaultDur, req.shapeOptions, req.signal);
        const withExif = injectWhatsAppExif(visualRes.buffer, {
          packName: req.title || 'StickerWave',
          packPublisher: 'Nathan Paranhos',
          emojis: ['✨'],
        });
        const cap = visualRes.inspection.animated ? this.config.maxStickerBytes : this.config.maxStaticStickerBytes;
        const finalWebp = withExif.byteLength <= cap ? withExif : visualRes.buffer;
        const trayPath = path.join(tempDir, 'tray.png');
        await this.ffmpeg.run(
          [
            '-i',
            prepared.visualPath,
            '-vframes',
            '1',
            '-vf',
            'scale=96:96:force_original_aspect_ratio=decrease,format=rgba,pad=96:96:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
            trayPath,
          ],
          { signal: req.signal, timeoutMs: 20_000 },
        );
        const trayBytes = await fs.readFile(trayPath);
        const title = (req.title || 'StickerWave').trim().slice(0, 60) || 'StickerWave';
        const zipBuf = createStoredZip([
          { name: 'title.txt', data: Buffer.from(title, 'utf8') },
          { name: 'author.txt', data: Buffer.from('Nathan Paranhos (StickerWave)', 'utf8') },
          { name: 'tray.png', data: trayBytes },
          { name: '1.webp', data: finalWebp },
          { name: '2.webp', data: finalWebp },
          { name: '3.webp', data: finalWebp },
        ]);
        return {
          buffer: zipBuf,
          mimeType: 'application/octet-stream',
          extension: 'wastickers',
          isAnimated: visualRes.inspection.animated,
          durationMs: Math.round((audioRes?.durationSec ?? visualRes.inspection.durationSec) * 1000),
        };
      }

      // MP4 Sticker Card (512x512 H.264/MPEG4 + AAC with opaque WhatsApp-ready background)
      const caps = await this.ffmpeg.checkCapabilities();
      const targetDurSec = Math.min(
        this.config.maxSeconds,
        Math.max(1, audioRes?.durationSec ?? prepared.durationSec ?? 3),
      );
      const bgRaw = req.shapeOptions?.background;
      const bgHex = bgRaw && /^#[0-9a-fA-F]{6}$/.test(bgRaw) ? `0x${bgRaw.slice(1)}` : '0xffffff';
      const mp4OutPath = path.join(tempDir, 'sticker-card.mp4');
      const vCodec = caps.encoders.libx264 ? 'libx264' : 'mpeg4';
      const inputArgs = prepared.isAnimated
        ? (audioRes && (!prepared.durationSec || prepared.durationSec < targetDurSec) ? ['-stream_loop', '-1', '-i', prepared.visualPath] : ['-i', prepared.visualPath])
        : ['-loop', '1', '-i', prepared.visualPath];
      const audioInputs = audioRes ? ['-i', audioRes.outputPath] : [];
      const filter =
        `color=c=${bgHex}:s=512x512:r=24[bg];` +
        `[0:v]fps=24,scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000[fg];` +
        `[bg][fg]overlay=0:0:shortest=1,format=yuv420p[v]`;

      const mp4Args: string[] = [
        ...inputArgs,
        ...audioInputs,
        '-filter_complex',
        filter,
        '-map',
        '[v]',
        ...(audioRes ? ['-map', '1:a', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-shortest'] : ['-an']),
        '-t',
        targetDurSec.toFixed(3),
        '-c:v',
        vCodec,
        ...(vCodec === 'libx264' ? ['-preset', 'veryfast', '-crf', '22'] : ['-q:v', '4']),
        '-movflags',
        '+faststart',
        mp4OutPath,
      ];

      await this.ffmpeg.run(mp4Args, { signal: req.signal, timeoutMs: 60_000 });
      const mp4Buffer = await fs.readFile(mp4OutPath);
      return {
        buffer: mp4Buffer,
        mimeType: 'video/mp4',
        extension: 'mp4',
        isAnimated: prepared.isAnimated || Boolean(audioRes),
        durationMs: Math.round(targetDurSec * 1000),
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}
