import { FFmpeg } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import workerURL from '@ffmpeg/ffmpeg/worker?worker&url';
import { MAX_SOURCE_DURATION } from '../core/project';
import { decodeAudio, identify } from './media';
import { encodeWav } from './wav-job';

async function transcode(blob: Blob, input: 'mp4' | 'webm' | 'wav', output: 'wav' | 'ogg',
  args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  const encoder = new FFmpeg();
  const abort = () => encoder.terminate();
  const timeout = setTimeout(abort, 35_000);
  signal.addEventListener('abort', abort, { once: true });
  const from = `input.${input}`, to = `output.${output}`;
  try {
    await encoder.load({ coreURL, wasmURL, classWorkerURL: workerURL }, { signal });
    await encoder.writeFile(from, new Uint8Array(await blob.arrayBuffer()), { signal });
    const result = await encoder.exec(['-i', from, '-map', '0:a:0', '-vn', ...args, to], 20_000, { signal });
    if (result) throw new Error('3001');
    const data = await encoder.readFile(to, 'binary', { signal });
    if (typeof data === 'string' || !data.byteLength) throw new Error('3004');
    return new Blob([new Uint8Array(data)], { type: output === 'ogg' ? 'audio/ogg' : 'audio/wav' });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.message === '3004') throw error;
    throw new Error('3001');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    encoder.terminate();
  }
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
