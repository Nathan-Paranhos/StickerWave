import fs from 'node:fs/promises';
import type { StickerAudioOptions } from '@stickerwave/contracts';
import type { FFmpegAdapter } from './ffmpeg-adapter.js';
import { sniffMediaBytes } from './magic-bytes.js';

export interface ProcessedAudioResult {
  outputPath: string;
  buffer: Buffer;
  durationSec: number;
  secondsField: number;
  waveform: Uint8Array;
  sampleRate: number;
  codec: string;
  peakDb: number | null;
  meanDb: number | null;
}

/**
 * Generates WhatsApp-compatible 64-bar amplitude waveform (values 0..100) from 16-bit LE mono PCM.
 */
export function waveformFromPcm16(pcm: Uint8Array, bars = 64): Uint8Array {
  const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const sampleCount = Math.floor(buf.byteLength / 2);
  const levels = new Array<number>(bars).fill(0);
  if (sampleCount === 0) return Uint8Array.from(levels);

  const perBar = Math.max(1, Math.floor(sampleCount / bars));
  for (let bar = 0; bar < bars; bar++) {
    const start = bar * perBar;
    const end = Math.min(sampleCount, start + perBar);
    let sum = 0;
    for (let i = start; i < end; i++) {
      sum += Math.abs(buf.readInt16LE(i * 2));
    }
    levels[bar] = end > start ? sum / (end - start) : 0;
  }

  const peak = Math.max(...levels);
  if (peak <= 0) return Uint8Array.from(levels);
  return Uint8Array.from(levels.map((val) => Math.max(0, Math.min(100, Math.round((val / peak) * 100)))));
}

function computePcmStatsDb(pcm16Le: Buffer): { peakDb: number; meanDb: number } {
  const count = Math.floor(pcm16Le.byteLength / 2);
  if (count === 0) return { peakDb: -Infinity, meanDb: -Infinity };
  let maxAbs = 0;
  let sumSq = 0;
  for (let i = 0; i < count; i++) {
    const sample = pcm16Le.readInt16LE(i * 2);
    const abs = Math.abs(sample);
    if (abs > maxAbs) maxAbs = abs;
    const norm = sample / 32768;
    sumSq += norm * norm;
  }
  const peakDb = maxAbs === 0 ? -Infinity : Number((20 * Math.log10(maxAbs / 32768)).toFixed(2));
  const rms = Math.sqrt(sumSq / count);
  const meanDb = rms === 0 ? -Infinity : Number((20 * Math.log10(rms)).toFixed(2));
  return { peakDb, meanDb };
}

/**
 * AudioProcessor decodes MP3, WAV, OGG, M4A, AAC or extracts audio tracks from video containers,
 * applies timeline trim/offset/gain/fades/peak normalization, and encodes mono 48kHz Ogg/Opus
 * plus validates the encoded output and generates the 64-bar waveform.
 */
export class AudioProcessor {
  constructor(private readonly ffmpeg: FFmpegAdapter) {}

  async processAudio(
    inputPath: string,
    outputOggPath: string,
    options: StickerAudioOptions & {
      maxDurationSec: number;
      kbps: number;
      leadMs?: number;
      maxAudioBytes: number;
      signal?: AbortSignal;
    },
  ): Promise<ProcessedAudioResult> {
    const header = await fs.readFile(inputPath, { flag: 'r' });
    const sniff = sniffMediaBytes(header);
    if (sniff.category !== 'audio' && sniff.category !== 'container') {
      throw new Error(`Unsupported audio/container magic signature: ${sniff.kind} (${sniff.mime})`);
    }

    const probe = await this.ffmpeg.probe(inputPath);
    const audioStream = probe.streams?.find((s) => s.codec_type === 'audio');
    if (!audioStream) {
      throw new Error('Input media contains no audio stream.');
    }

    const sourceDurationSec = Number(audioStream.duration || probe.format?.duration || 0);
    const trimStartSec = Math.max(0, (options.trimStartMs ?? 0) / 1000);
    const trimEndMs = options.trimEndMs && options.trimEndMs > 0 ? options.trimEndMs : undefined;
    const rawSpanSec =
      trimEndMs !== undefined
        ? Math.max(0.1, trimEndMs / 1000 - trimStartSec)
        : sourceDurationSec > trimStartSec
          ? sourceDurationSec - trimStartSec
          : options.maxDurationSec;

    const targetDurSec = Math.min(
      options.maxDurationSec,
      options.targetDurationMs ? Math.max(0.25, options.targetDurationMs / 1000) : rawSpanSec,
    );
    const leadSec = Math.max(0, (options.leadMs ?? 0) / 1000);
    const effectiveStartSec = trimStartSec + (trimStartSec === 0 && rawSpanSec > targetDurSec + leadSec ? leadSec : 0);

    const timelineOffsetMs = Math.max(0, Math.round(options.timelineOffsetMs ?? 0));
    const gain = Math.min(3, Math.max(0, options.volume ?? 1));
    const fadeInSec = Math.min(targetDurSec / 2, Math.max(0, (options.fadeInMs ?? 0) / 1000));
    const fadeOutSec = Math.min(targetDurSec / 2, Math.max(0, (options.fadeOutMs ?? 0) / 1000));

    const filterChain: string[] = ['aresample=48000:first_pts=0'];
    if (Math.abs(gain - 1) > 0.001) {
      filterChain.push(`volume=${gain.toFixed(3)}`);
    }
    if (fadeInSec > 0.01) {
      filterChain.push(`afade=t=in:st=0:d=${fadeInSec.toFixed(3)}`);
    }
    if (fadeOutSec > 0.01 && targetDurSec > fadeOutSec) {
      filterChain.push(`afade=t=out:st=${Math.max(0, targetDurSec - fadeOutSec).toFixed(3)}:d=${fadeOutSec.toFixed(3)}`);
    }
    if (options.normalizePeak) {
      filterChain.push('loudnorm=I=-16:TP=-1.5:LRA=11');
    }
    if (timelineOffsetMs > 0) {
      filterChain.push(`adelay=${timelineOffsetMs}:all=1`);
    }
    filterChain.push(`apad=whole_dur=${targetDurSec.toFixed(3)}`);

    const caps = await this.ffmpeg.checkCapabilities();
    const opusEncoderArgs = caps.encoders.libopus
      ? ['-c:a', 'libopus']
      : ['-c:a', 'opus', '-strict', '-2'];

    // Single-pass filtergraph directly from input -> clean Ogg/Opus, avoiding redundant WAV staging spawns.
    await this.ffmpeg.run(
      [
        ...(effectiveStartSec > 0 ? ['-ss', effectiveStartSec.toFixed(3)] : []),
        '-i', inputPath,
        '-vn',
        '-map', '0:a:0',
        '-af', filterChain.join(','),
        '-ac', '1',
        '-ar', '48000',
        '-t', targetDurSec.toFixed(3),
        ...opusEncoderArgs,
        '-b:a', `${options.kbps}k`,
        '-vbr', 'on',
        '-compression_level', '10',
        '-application', 'audio',
        '-avoid_negative_ts', 'make_zero',
        '-map_metadata', '-1',
        '-f', 'ogg',
        outputOggPath,
      ],
      { signal: options.signal },
    );

    const outBuffer = await fs.readFile(outputOggPath);
    if (outBuffer.byteLength > options.maxAudioBytes) {
      throw new Error(`Encoded Ogg/Opus exceeded limit (${outBuffer.byteLength} > ${options.maxAudioBytes} bytes).`);
    }

    const [outProbe, decodeResult] = await Promise.all([
      this.ffmpeg.probe(outputOggPath),
      this.ffmpeg.run(
        ['-i', outputOggPath, '-vn', '-f', 's16le', '-ac', '1', '-ar', '8000', '-'],
        { signal: options.signal },
      ),
    ]);

    const outAudio = outProbe.streams?.find((s) => s.codec_type === 'audio');
    if (!outAudio || outAudio.codec_name !== 'opus') {
      throw new Error(`Encoded audio validation failed: expected opus codec, got ${outAudio?.codec_name ?? 'none'}.`);
    }
    const finalDurationSec = Number(outProbe.format?.duration || outAudio.duration || targetDurSec);
    if (!Number.isFinite(finalDurationSec) || finalDurationSec <= 0.05) {
      throw new Error('Encoded audio has invalid or zero duration.');
    }

    const decodeErrors = decodeResult.stderr
      .split(/\r?\n/)
      .filter((line) => /\b(error|invalid|corrupt|truncated)\b/i.test(line));
    if (decodeErrors.length > 0) {
      throw new Error(`Audio stream decode errors detected: ${decodeErrors[0]}`);
    }

    const stats = computePcmStatsDb(decodeResult.stdout);

    return {
      outputPath: outputOggPath,
      buffer: outBuffer,
      durationSec: finalDurationSec,
      secondsField: Math.max(1, Math.round(finalDurationSec)),
      waveform: waveformFromPcm16(decodeResult.stdout),
      sampleRate: Number(outAudio.sample_rate || 48000),
      codec: outAudio.codec_name,
      peakDb: stats.peakDb,
      meanDb: stats.meanDb,
    };
  }
}
