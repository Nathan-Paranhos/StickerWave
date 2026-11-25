import type { MediaMime } from '../core/project';

type Decoder = {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number; animated: boolean } | null };
  decode(options: { frameIndex: number }): Promise<{ image: VideoFrame }>;
  close(): void;
};
const decoderClass = () => (globalThis as typeof globalThis & {
  ImageDecoder?: new (options: { type: string; data: ArrayBuffer }) => Decoder;
}).ImageDecoder;

export const pagedMime = (mime: string) => mime === 'image/heic' || mime === 'image/tiff';
export const animatedMime = (mime: string) => ['image/gif', 'image/avif', 'image/webp', 'image/png'].includes(mime);

export async function openDecoder(blob: Blob, mime: string, signal?: AbortSignal) {
  const ImageDecoder = decoderClass();
  if (!ImageDecoder) throw new Error('1004');
  signal?.throwIfAborted();
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: mime });
  const abort = () => decoder.close();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await decoder.tracks.ready;
    signal?.throwIfAborted();
    return { decoder, close: () => { signal?.removeEventListener('abort', abort); if (!signal?.aborted) decoder.close(); } };
  } catch (error) { signal?.removeEventListener('abort', abort); if (!signal?.aborted) decoder.close(); throw error; }
}

type Page = { pixels: Uint8ClampedArray<ArrayBuffer>; width: number; height: number; count: number };
export async function decodePage(blob: Blob, mime: string, page: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const bytes = await blob.arrayBuffer();
  signal?.throwIfAborted();
  return new Promise<Page>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/pages.ts', import.meta.url), { type: 'module' });
    const abort = () => finish(signal?.reason);
    const timeout = setTimeout(() => finish(new Error('1004')), 15_000);
    function finish(error?: unknown, result?: Page) {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (result) resolve(result); else reject(error ?? new Error('1004'));
    }
    worker.onmessage = ({ data }: MessageEvent<Page | { error: string }>) =>
      'error' in data ? finish(new Error(data.error)) : finish(undefined, data);
    worker.onerror = () => finish(new Error('1004'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.postMessage({ bytes, mime, page }, [bytes]);
  });
}
export async function inspectFrames(blob: Blob, mime: MediaMime, required: boolean, measure: (w: number, h: number) => void, signal?: AbortSignal) {
  if (pagedMime(mime)) {
    const { count, width, height } = await decodePage(blob, mime, 0, signal);
    return { frames: count, width, height, duration: 0, animated: false };
  }
  if (!animatedMime(mime) || !required) return null;
  try {
    const handle = await openDecoder(blob, mime, signal);
    try {
      const track = handle.decoder.tracks.selectedTrack;
      const count = track?.frameCount ?? 0;
      if (count < 1) throw new Error('1004');
      if (count > 600) throw new Error('1002');
      let width = 0, height = 0, duration = 0;
      const frameEnds: number[] = [];
      for (let index = 0; index < count; index++) {
        signal?.throwIfAborted();
        const { image } = await handle.decoder.decode({ frameIndex: index });
        try {
          if (index === 0) { width = image.displayWidth; height = image.displayHeight; measure(width, height); }
          duration += Math.max(20, Math.round((image.duration ?? 100_000) / 1000));
          frameEnds.push(duration);
          if (duration > 60_000 || index * width * height > 180_000_000) throw new Error('1002');
        } finally { image.close(); }
      }
      if (duration < 100) { duration = 100; frameEnds[frameEnds.length - 1] = duration; }
      return count > 1 ? { frames: count, width, height, duration, animated: true, frameEnds } :
        { frames: 1, width, height, duration: 0, animated: false };
    } finally { handle.close(); }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.message === '1002') throw error;
    throw new Error('1005');
  }
}
