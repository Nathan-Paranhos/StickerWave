import { pcmWav } from '../core/wav';

export function encodeWav(channels: Float32Array<ArrayBuffer>[], sampleRate: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (typeof Worker === 'undefined') return Promise.resolve(pcmWav(channels, sampleRate));
  let worker: Worker;
  try { worker = new Worker(new URL('../workers/wav.ts', import.meta.url), { type: 'module' }); }
  catch { return Promise.resolve(pcmWav(channels, sampleRate)); }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const timeout = setTimeout(() => finish(null, new Error('3003')), 12000);
    const abort = () => finish(null, signal.reason ?? new Error('3002'));
    function finish(data: ArrayBuffer | null, error?: unknown) {
      worker.terminate();
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (data) resolve(data);
      else reject(error ?? new Error('3004'));
    }
    worker.onerror = () => finish(null);
    worker.onmessage = ({ data }: MessageEvent<{ data?: ArrayBuffer; error?: string }>) =>
      finish(data.data instanceof ArrayBuffer ? data.data : null);
    signal.addEventListener('abort', abort, { once: true });
    try { worker.postMessage({ channels, sampleRate }, channels.map(channel => channel.buffer)); }
    catch { finish(null); }
  });
}
