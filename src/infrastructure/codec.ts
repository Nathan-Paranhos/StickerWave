import { FFmpeg } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import workerURL from '@ffmpeg/ffmpeg/worker?worker&url';
import { MAX_SOURCE_DURATION } from '../core/project';
import { decodeAudio, identify } from './media';
import { encodeWav } from './wav-job';

export const ffmpegSupported = () =>
  typeof WebAssembly !== 'undefined' && typeof Worker !== 'undefined';

async function runFfmpeg(
  inputs: { name: string; data: Uint8Array | Blob }[],
  outputName: string,
  outputMime: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs = 35_000,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  signal.throwIfAborted();
  const encoder = new FFmpeg();
  const abort = () => encoder.terminate();
  const timer = setTimeout(abort, timeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  const handleProgress = ({ progress }: { progress: number }) => {
    if (onProgress && Number.isFinite(progress)) onProgress(Math.max(0, Math.min(0.99, progress)));
  };
  if (onProgress) encoder.on('progress', handleProgress);
  try {
    await encoder.load({ coreURL, wasmURL, classWorkerURL: workerURL }, { signal });
    signal.throwIfAborted();
    for (const file of inputs) {
      signal.throwIfAborted();
      const raw = file.data instanceof Blob ? new Uint8Array(await file.data.arrayBuffer()) : file.data.slice();
      await encoder.writeFile(file.name, raw, { signal });
    }
    const result = await encoder.exec([...args, outputName], Math.max(15_000, timeoutMs - 5_000), { signal });
    if (result) throw new Error('3001');
    const data = await encoder.readFile(outputName, 'binary', { signal });
    if (typeof data === 'string' || !data.byteLength) throw new Error('3004');
    return new Blob([new Uint8Array(data)], { type: outputMime });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.message === '3004') throw error;
    throw new Error('3001');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    encoder.terminate();
  }
}

async function transcode(blob: Blob, input: 'mp4' | 'webm' | 'wav', output: 'wav' | 'ogg' | 'mp3',
  args: string[], signal: AbortSignal) {
  const mime = output === 'ogg' ? 'audio/ogg' : output === 'mp3' ? 'audio/mpeg' : 'audio/wav';
  return runFfmpeg([{ name: `input.${input}`, data: blob }], `output.${output}`, mime, ['-i', `input.${input}`, '-map', '0:a:0', '-vn', ...args], signal);
}

async function extractNativeAudio(blob: Blob, signal: AbortSignal) {
  const decoded = await decodeAudio(blob);
  signal.throwIfAborted();
  const limit = Math.min(decoded.length, Math.floor((MAX_SOURCE_DURATION / 1000) * decoded.sampleRate));
  if (!limit || decoded.numberOfChannels > 2) throw new Error('1004');
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index).slice(0, limit));
  const wav = await encodeWav(channels, decoded.sampleRate, signal);
  if (identify(new Uint8Array(wav, 0, 44), 'audio') !== 'audio/wav') throw new Error('3004');
  return new Blob([wav], { type: 'audio/wav' });
}

export async function extractSound(blob: Blob, mime: string, signal: AbortSignal) {
  try {
    return await extractNativeAudio(blob, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.message === '3002') throw error;
    return transcode(blob, mime === 'video/mp4' ? 'mp4' : 'webm', 'wav',
      ['-t', '60', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le'], signal);
  }
}

export async function opusFile(wav: Blob, signal: AbortSignal) {
  const ogg = await transcode(wav, 'wav', 'ogg', ['-c:a', 'libopus', '-b:a', '96k'], signal);
  const header = new TextDecoder().decode(await ogg.slice(0, 160).arrayBuffer());
  if (!header.startsWith('OggS') || !header.includes('OpusHead')) throw new Error('3004');
  return ogg;
}

export async function mp3File(wav: Blob, signal: AbortSignal) {
  const mp3 = await transcode(wav, 'wav', 'mp3', ['-c:a', 'libmp3lame', '-b:a', '128k'], signal);
  const head = new Uint8Array(await mp3.slice(0, 32).arrayBuffer());
  if (identify(head, 'audio') !== 'audio/mpeg') throw new Error('3004');
  return mp3;
}

export async function webpFile(png: Blob, quality: number, signal: AbortSignal) {
  const q = Math.max(10, Math.min(100, Math.round(quality * 100)));
  const webp = await runFfmpeg(
    [{ name: 'frame.png', data: png }],
    'out.webp',
    'image/webp',
    ['-i', 'frame.png', '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(q)],
    signal,
  );
  if (identify(new Uint8Array(await webp.slice(0, 24).arrayBuffer()), 'visual') !== 'image/webp') throw new Error('3004');
  return webp;
}

export async function animatedWebpFile(frames: Blob[], fps: number, quality: number, signal: AbortSignal) {
  const q = Math.max(10, Math.min(100, Math.round(quality * 100)));
  const inputs = frames.map((data, idx) => ({ name: `f${String(idx).padStart(4, '0')}.png`, data }));
  const webp = await runFfmpeg(
    inputs,
    'anim.webp',
    'image/webp',
    ['-framerate', String(fps), '-i', 'f%04d.png', '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', String(q), '-loop', '0'],
    signal,
    60_000,
  );
  if (identify(new Uint8Array(await webp.slice(0, 24).arrayBuffer()), 'visual') !== 'image/webp') throw new Error('3004');
  return webp;
}

export async function mp4File({
  durationMs,
  fps,
  staticPng,
  frames,
  frameExt,
  wav,
  signal,
  onProgress,
}: {
  durationMs: number;
  fps: number;
  staticPng?: Blob;
  frames?: Blob[];
  frameExt?: 'jpg' | 'png';
  wav?: Blob | null;
  signal: AbortSignal;
  onProgress?: (ratio: number) => void;
}) {
  const sec = Math.max(0.1, durationMs / 1000).toFixed(3);
  const inputs: { name: string; data: Uint8Array | Blob }[] = [];
  const args: string[] = [];

  if (staticPng) {
    inputs.push({ name: 'frame.png', data: staticPng });
    args.push('-loop', '1', '-framerate', String(fps), '-t', sec, '-i', 'frame.png');
  } else if (frames?.length) {
    const ext = frameExt ?? 'jpg';
    frames.forEach((data, idx) => inputs.push({ name: `f${String(idx).padStart(4, '0')}.${ext}`, data }));
    args.push('-framerate', String(fps), '-i', `f%04d.${ext}`);
  } else {
    throw new Error('3001');
  }

  if (wav) {
    inputs.push({ name: 'audio.wav', data: wav });
    args.push('-i', 'audio.wav');
  }

  args.push(
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-tune', staticPng ? 'stillimage' : 'fastdecode',
    '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p',
  );
  if (wav) args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2');
  args.push('-t', sec, '-movflags', '+faststart');

  return runFfmpeg(inputs, 'out.mp4', 'video/mp4', args, signal, 65_000, onProgress);
}