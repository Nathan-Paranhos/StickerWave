import { audioTracks, projectDuration, SIZE, type Project, type StoredAsset } from '../core/project';
import { movieStreams } from '../core/movie';
import { webpAnimation } from '../core/webp-animation';
import { encodeWav } from './wav-job';
import { Composition } from './composition';
import { mixAudio } from './mix';
import { closeVisual, identify, openVisual, videoFormats } from './media';

export type ExportFormat = 'webp' | 'animated-webp' | 'whatsapp-image' | 'wav' | 'opus' | 'video' | 'backup';
export type ExportResult = { blob: Blob; extension: string };

function openAudioContext() {
  try { return new AudioContext({ sampleRate: 48_000 }); }
  catch { return new AudioContext(); }
}

function newCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  return canvas;
}
async function canvasWebp(canvas: HTMLCanvasElement, quality: number) {
  const image = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality));
  if (!image || image.type !== 'image/webp' ||
    identify(new Uint8Array(await image.slice(0, 24).arrayBuffer()), 'visual') !== 'image/webp') throw new Error('3001');
  return image;
}
export async function imageExport(project: Project, assets: ReadonlyMap<string, StoredAsset>, signal: AbortSignal, frameMs = 0) {
  const canvas = newCanvas();
  const compositor = new Composition(signal);
  try {
    await compositor.open(project, assets);
    await compositor.prepare(project, frameMs);
    compositor.draw(canvas, project, frameMs);
    let image: Blob | undefined;
    for (const quality of [.92, .78, .64, .5, .36, .22]) {
      signal.throwIfAborted();
      image = await canvasWebp(canvas, quality);
      if (image.size <= 100 * 1024) break;
    }
    return image!;
  } finally { compositor.close(); }
}

async function animatedExport(project: Project, assets: ReadonlyMap<string, StoredAsset>, signal: AbortSignal, progress: (ratio: number) => void) {
  const compositor = new Composition(signal);
  const canvas = newCanvas();
  const duration = projectDuration(project, assets);
  const frames = [];
  let total = 0;
  try {
    await compositor.open(project, assets);
    if (!compositor.hasMotion(project)) throw new Error('3001');
    const count = Math.max(2, Math.ceil(duration / (1000 / 24)));
    for (let frame = 0; frame < count; frame++) {
      signal.throwIfAborted();
      const start = Math.round(frame * duration / count);
      const end = Math.round((frame + 1) * duration / count);
      await compositor.prepare(project, start);
      compositor.draw(canvas, project, start);
      const bytes = new Uint8Array(await (await canvasWebp(canvas, .72)).arrayBuffer());
      total += bytes.byteLength;
      if (total > 32 * 1024 ** 2) throw new Error('1002');
      frames.push({ bytes, duration: end - start });
      progress((frame + 1) / count);
    }
    return webpAnimation(frames, SIZE, SIZE);
  } finally { compositor.close(); }
}

async function soundExport(project: Project, assets: ReadonlyMap<string, StoredAsset>, signal: AbortSignal) {
  const buffer = await mixAudio(project, assets, signal);
  if (!buffer) throw new Error('3001');
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel).slice());
  const wav = await encodeWav(channels, buffer.sampleRate, signal);
  if (identify(new Uint8Array(wav, 0, 44), 'audio') !== 'audio/wav') throw new Error('3004');
  return new Blob([wav], { type: 'audio/wav' });
}

async function attemptVideoExport(project: Project, assets: ReadonlyMap<string, StoredAsset>,
  duration: number, signal: AbortSignal, progress: (ratio: number) => void, mimeType: string,
  context: AudioContext, resumed: Promise<void>): Promise<ExportResult> {
  const canvas = newCanvas();
  const compositor = new Composition(signal);
  const stream = canvas.captureStream(24);
  const videoTrack = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
  const destination = context.createMediaStreamDestination();
  destination.stream.getTracks().forEach(track => stream.addTrack(track));
  const chunks: Blob[] = [];
  let source: AudioBufferSourceNode | undefined;
  let recorder: MediaRecorder | undefined;
  try {
    const buffer = await mixAudio(project, assets, signal);
    await compositor.open(project, assets);
    await compositor.prepare(project, 0);
    signal.throwIfAborted();
    if (document.hidden) throw new Error('3005');
    await Promise.race([resumed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('3001')), 2500))]);
    signal.throwIfAborted();
    try {
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 });
    } catch {
      throw new Error('3001');
    }
    const activeRecorder = recorder;
    activeRecorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
    let recorderError = false;
    activeRecorder.addEventListener('error', () => { recorderError = true; });
    compositor.draw(canvas, project, 0, true);
    activeRecorder.start(250);
    // Re-push frame 0 after MediaRecorder starts so short clips always register a video track.
    compositor.draw(canvas, project, 0, true);
    videoTrack?.requestFrame?.();
    const origin = context.currentTime;
    if (buffer) {
      source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      source.start(origin);
    }
    await new Promise<void>((resolve, reject) => {
      let frame = 0;
      let drawn = 0;
      let active = true;
      const timeout = window.setTimeout(() => finish(new Error('3003')), duration + 4000);
      const onAbort = () => finish(signal.reason ?? new Error('3002'));
      const onVisibility = () => { if (document.hidden) finish(new Error('3005')); };
      function finish(error?: unknown) {
        if (!active) return;
        active = false;
        clearTimeout(timeout);
        cancelAnimationFrame(frame);
        signal.removeEventListener('abort', onAbort);
        document.removeEventListener('visibilitychange', onVisibility);
        if (error) reject(error); else resolve();
      }
      async function tick() {
        if (recorderError) throw new Error('3001');
        const elapsed = (context.currentTime - origin) * 1000;
        await compositor.prepare(project, Math.min(duration, elapsed), true);
        if (!active) return;
        compositor.draw(canvas, project, elapsed, true);
        videoTrack?.requestFrame?.();
        drawn += 1;
        progress(Math.min(.99, elapsed / duration));
        if (elapsed >= duration && drawn >= 3) finish(); else frame = requestAnimationFrame(() => void tick().catch(finish));
      }
      if (signal.aborted) { onAbort(); return; }
      if (document.hidden) { onVisibility(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      document.addEventListener('visibilitychange', onVisibility);
      frame = requestAnimationFrame(() => void tick().catch(finish));
    });
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('3003')), 3000);
      activeRecorder.addEventListener('stop', () => { clearTimeout(timer); resolve(); }, { once: true });
      if (activeRecorder.state === 'inactive') { clearTimeout(timer); reject(new Error('3001')); }
      else activeRecorder.stop();
    });
    signal.throwIfAborted();
    const staged = new Blob(chunks);
    const mime = identify(new Uint8Array(await staged.slice(0, 64).arrayBuffer()), 'visual');
    if (!(mime === 'video/mp4' || mime === 'video/webm') || staged.size < 100 || recorderError ||
      (activeRecorder.mimeType && !activeRecorder.mimeType.startsWith(mime))) throw new Error('3004');
    const streams = movieStreams(new Uint8Array(await staged.arrayBuffer()), mime);
    if (!streams.video || (audioTracks(project).length && !streams.audio)) throw new Error('3004');
    const blob = staged.slice(0, staged.size, mime);
    const check = await openVisual(blob, mime, signal);
    try {
      if (!(check instanceof HTMLVideoElement) || check.videoWidth !== SIZE || check.videoHeight !== SIZE ||
        (Number.isFinite(check.duration) && Math.abs(check.duration * 1000 - duration) > 420)) throw new Error('3004');
    } finally { closeVisual(check); }
    progress(1);
    return { blob, extension: mime === 'video/mp4' ? 'mp4' : 'webm' };
  } finally {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    try { source?.stop(); } catch { /* already ended */ }
    source?.disconnect();
    stream.getTracks().forEach(track => track.stop());
    compositor.close();
  }
}

async function videoExport(project: Project, assets: ReadonlyMap<string, StoredAsset>,
  duration: number, signal: AbortSignal, progress: (ratio: number) => void, preferred?: string): Promise<ExportResult> {
  const formats = videoFormats().filter(type => !preferred || type.startsWith(preferred));
  if (!formats.length) throw new Error('3001');
  // Create and unlock AudioContext once synchronously from the user gesture before trying fallback codecs.
  const context = openAudioContext();
  const resumed = context.resume();
  void resumed.catch(() => undefined);
  let lastError: unknown = new Error('3001');
  try {
    for (const mimeType of formats) {
      signal.throwIfAborted();
      try {
        return await attemptVideoExport(project, assets, duration, signal, progress, mimeType, context, resumed);
      } catch (error) {
        if (signal.aborted || (error instanceof Error && (error.message === '3002' || error.message === '3005'))) throw error;
        lastError = error;
      }
    }
    throw lastError;
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function imagePngExport(project: Project, assets: ReadonlyMap<string, StoredAsset>, signal: AbortSignal, frameMs = 0): Promise<Blob> {
  const canvas = newCanvas();
  const compositor = new Composition(signal);
  try {
    await compositor.open(project, assets);
    await compositor.prepare(project, frameMs);
    compositor.draw(canvas, project, frameMs);
    const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!png) throw new Error('3001');
    return png;
  } finally { compositor.close(); }
}

export async function renderExport(format: ExportFormat, project: Project, assets: ReadonlyMap<string, StoredAsset>,
  signal: AbortSignal, progress: (ratio: number) => void, frame: number, videoContainer?: string): Promise<ExportResult> {
  if (format === 'webp') return { blob: await imageExport(project, assets, signal, frame), extension: 'webp' };
  if (format === 'whatsapp-image') {
    try { return { blob: await imageExport(project, assets, signal, frame), extension: 'webp' }; }
    catch (error) {
      if (error instanceof Error && error.message === '3001') {
        return { blob: await imagePngExport(project, assets, signal, frame), extension: 'png' };
      }
      throw error;
    }
  }
  if (format === 'animated-webp') return { blob: await animatedExport(project, assets, signal, progress), extension: 'webp' };
  if (format === 'wav') return { blob: await soundExport(project, assets, signal), extension: 'wav' };
  if (format === 'opus') {
    const { opusFile } = await import('./codec');
    return { blob: await opusFile(await soundExport(project, assets, signal), signal), extension: 'ogg' };
  }
  if (format === 'video') return videoExport(project, assets, projectDuration(project, assets), signal, progress, videoContainer);
  const { makeBackup } = await import('./backup');
  return { blob: await makeBackup(project, assets, signal), extension: 'stickerwave.zip' };
}
