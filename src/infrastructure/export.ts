import { audioTracks, projectDuration, SIZE, type Project, type StoredAsset } from '../core/project';
import { movieStreams } from '../core/movie';
import { webpAnimation } from '../core/webp-animation';
import { encodeWav } from './wav-job';
import { Composition } from './composition';
import { mixAudio } from './mix';
import { closeVisual, identify, openVisual, videoFormats } from './media';
import { logWarn } from './logger';

export type ExportFormat = 'webp' | 'animated-webp' | 'whatsapp-image' | 'wastickers' | 'wav' | 'mp3' | 'opus' | 'video' | 'backup';
export type ExportResult = { blob: Blob; extension: string };

export const mp4Supported = () =>
  typeof WebAssembly !== 'undefined' && typeof Worker !== 'undefined';

function openAudioContext() {
  try { return new AudioContext({ sampleRate: 48_000 }); }
  catch { return new AudioContext(); }
}

function newCanvas(size = SIZE) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  return canvas;
}

async function canvasBlob(canvas: HTMLCanvasElement, mime: string, quality?: number) {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mime, quality));
  if (!blob) throw new Error('3001');
  return blob;
}

async function nativeCanvasWebp(canvas: HTMLCanvasElement, quality: number) {
  const image = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality));
  if (!image || image.type !== 'image/webp' ||
    identify(new Uint8Array(await image.slice(0, 24).arrayBuffer()), 'visual') !== 'image/webp') throw new Error('3001');
  return image;
}

async function canvasWebp(canvas: HTMLCanvasElement, quality: number, signal: AbortSignal) {
  try {
    return await nativeCanvasWebp(canvas, quality);
  } catch (error) {
    if (!(error instanceof Error && error.message === '3001') || !mp4Supported()) throw error;
    const png = await canvasBlob(canvas, 'image/png');
    const { webpFile } = await import('./codec');
    return webpFile(png, quality, signal);
  }
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
      image = await canvasWebp(canvas, quality, signal);
      if (image.size <= 100 * 1024) break;
    }
    return image!;
  } finally { compositor.close(); }
}

async function animatedWebpAttempt(project: Project, assets: ReadonlyMap<string, StoredAsset>, signal: AbortSignal,
  fps: number, quality: number, progress: (ratio: number) => void, baseProgress = 0, spanProgress = 1) {
  const compositor = new Composition(signal);
  const canvas = newCanvas();
  const duration = projectDuration(project, assets);
  const count = Math.min(240, Math.max(2, Math.round(duration * fps / 1000)));
  const frames: { bytes: Uint8Array; duration: number }[] = [];
  const pngFallbackFrames: Blob[] = [];
  let nativeWebpOk: boolean | null = null;
  let total = 0;
  try {
    await compositor.open(project, assets);
    if (!compositor.hasMotion(project)) throw new Error('3001');
    for (let frame = 0; frame < count; frame++) {
      signal.throwIfAborted();
      const start = Math.round(frame * duration / count);
      const end = Math.round((frame + 1) * duration / count);
      await compositor.prepare(project, start);
      compositor.draw(canvas, project, start);
      if (nativeWebpOk !== false) {
        try {
          const bytes = new Uint8Array(await (await nativeCanvasWebp(canvas, quality)).arrayBuffer());
          nativeWebpOk = true;
          total += bytes.byteLength;
          if (total > 32 * 1024 ** 2) throw new Error('1002');
          frames.push({ bytes, duration: end - start });
        } catch (error) {
          if (error instanceof Error && error.message === '3001' && nativeWebpOk === null && mp4Supported()) {
            nativeWebpOk = false;
            pngFallbackFrames.push(await canvasBlob(canvas, 'image/png'));
          } else {
            throw error;
          }
        }
      } else {
        pngFallbackFrames.push(await canvasBlob(canvas, 'image/png'));
      }
      progress(baseProgress + ((frame + 1) / count) * spanProgress * (nativeWebpOk === false ? 0.65 : 1));
    }
    if (nativeWebpOk === false) {
      const { animatedWebpFile } = await import('./codec');
      return animatedWebpFile(pngFallbackFrames, fps, quality, signal);
    }
    return webpAnimation(frames, SIZE, SIZE);
  } finally { compositor.close(); }
}

async function animatedExport(project: Project, assets: ReadonlyMap<string, StoredAsset>, signal: AbortSignal,
  progress: (ratio: number) => void, maxBytes?: number) {
  let blob = await animatedWebpAttempt(project, assets, signal, 24, .72, progress, 0, maxBytes ? .55 : 1);
  if (maxBytes && blob.size > maxBytes) {
    blob = await animatedWebpAttempt(project, assets, signal, 12, .45, progress, .55, .45);
  }
  progress(1);
  return blob;
}

async function soundExport(project: Project, assets: ReadonlyMap<string, StoredAsset>, signal: AbortSignal) {
  const buffer = await mixAudio(project, assets, signal);
  if (!buffer) throw new Error('3001');
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel).slice());
  const wav = await encodeWav(channels, buffer.sampleRate, signal);
  if (identify(new Uint8Array(wav, 0, 44), 'audio') !== 'audio/wav') throw new Error('3004');
  return new Blob([wav], { type: 'audio/wav' });
}

async function validateMovieOutput(blob: Blob, mime: 'video/mp4' | 'video/webm', project: Project, duration: number, signal: AbortSignal, toleranceMs = 450) {
  const streams = movieStreams(new Uint8Array(await blob.arrayBuffer()), mime);
  const expectedAudio = audioTracks(project).length > 0;
  if (!streams.video || (expectedAudio && !streams.audio)) {
    logWarn('export', 'movie_stream_validation_failed', {
      code: '3004',
      meta: { mime, hasVideo: streams.video, hasAudio: streams.audio, expectedAudio, bytes: blob.size },
    });
    throw new Error('3004');
  }
  const check = await openVisual(blob, mime, signal);
  try {
    const isVideo = check instanceof HTMLVideoElement;
    const width = isVideo ? check.videoWidth : 0;
    const height = isVideo ? check.videoHeight : 0;
    const decodedMs = isVideo && Number.isFinite(check.duration) ? Math.round(check.duration * 1000) : null;
    if (!isVideo || width !== SIZE || height !== SIZE ||
      (decodedMs !== null && Math.abs(decodedMs - duration) > toleranceMs)) {
      logWarn('export', 'movie_dimension_or_duration_mismatch', {
        code: '3004',
        meta: { mime, isVideo, width, height, decodedMs, expectedMs: duration, toleranceMs },
      });
      throw new Error('3004');
    }
  } finally { closeVisual(check); }
}

async function ffmpegVideoExport(
  project: Project,
  assets: ReadonlyMap<string, StoredAsset>,
  duration: number,
  signal: AbortSignal,
  progress: (ratio: number) => void,
): Promise<ExportResult> {
  const canvas = newCanvas();
  const compositor = new Composition(signal);
  try {
    const wav = audioTracks(project).length ? await soundExport(project, assets, signal) : null;
    await compositor.open(project, assets);
    signal.throwIfAborted();
    const { mp4File } = await import('./codec');
    const fps = 24;
    let blob: Blob;
    if (!compositor.hasMotion(project)) {
      await compositor.prepare(project, 0);
      compositor.draw(canvas, project, 0, true);
      progress(0.25);
      const staticPng = await canvasBlob(canvas, 'image/png');
      blob = await mp4File({
        durationMs: duration,
        fps,
        staticPng,
        wav,
        signal,
        onProgress: ratio => progress(0.25 + ratio * 0.7),
      });
    } else {
      const count = Math.min(240, Math.max(2, Math.round(duration * fps / 1000)));
      const frames: Blob[] = [];
      let ext: 'jpg' | 'png' = 'jpg';
      for (let frame = 0; frame < count; frame++) {
        signal.throwIfAborted();
        const at = Math.min(duration - 1, Math.round(frame * 1000 / fps));
        await compositor.prepare(project, at, false);
        compositor.draw(canvas, project, at, true);
        let frameBlob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.94));
        if (!frameBlob) {
          ext = 'png';
          frameBlob = await canvasBlob(canvas, 'image/png');
        }
        frames.push(frameBlob);
        progress((frame + 1) / count * 0.45);
      }
      blob = await mp4File({
        durationMs: duration,
        fps,
        frames,
        frameExt: ext,
        wav,
        signal,
        onProgress: ratio => progress(0.45 + ratio * 0.5),
      });
    }
    signal.throwIfAborted();
    const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    if (identify(head, 'visual') !== 'video/mp4') throw new Error('3004');
    await validateMovieOutput(blob, 'video/mp4', project, duration, signal, 500);
    progress(1);
    return { blob, extension: 'mp4' };
  } finally {
    compositor.close();
  }
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
    const blob = staged.slice(0, staged.size, mime);
    await validateMovieOutput(blob, mime, project, duration, signal, 420);
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
  if ((!preferred || preferred.startsWith('video/mp4')) && mp4Supported()) {
    return ffmpegVideoExport(project, assets, duration, signal, progress);
  }
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
    return canvasBlob(canvas, 'image/png');
  } finally { compositor.close(); }
}

async function makeWastickers(project: Project, assets: ReadonlyMap<string, StoredAsset>, signal: AbortSignal,
  frameMs: number, progress: (ratio: number) => void): Promise<Blob> {
  const compositor = new Composition(signal);
  const full = newCanvas(SIZE);
  const tray = newCanvas(96);
  let hasMotion = false;
  let trayBytes: Uint8Array;
  try {
    await compositor.open(project, assets);
    hasMotion = compositor.hasMotion(project);
    await compositor.prepare(project, frameMs);
    compositor.draw(full, project, frameMs);
    const trayCtx = tray.getContext('2d');
    if (!trayCtx) throw new Error('3004');
    trayCtx.clearRect(0, 0, 96, 96);
    trayCtx.drawImage(full, 0, 0, 96, 96);
    trayBytes = new Uint8Array(await (await canvasBlob(tray, 'image/png')).arrayBuffer());
  } finally {
    compositor.close();
  }
  const stickerBlob = hasMotion
    ? await animatedExport(project, assets, signal, progress, 500 * 1024)
    : await imageExport(project, assets, signal, frameMs);
  const stickerBytes = new Uint8Array(await stickerBlob.arrayBuffer());
  const { strToU8, zipSync } = await import('fflate');
  const packTitle = project.name.trim().slice(0, 60) || 'StickerWave';
  const archive = zipSync({
    'title.txt': strToU8(packTitle),
    'author.txt': strToU8('StickerWave'),
    'tray.png': trayBytes,
    '1.webp': stickerBytes,
    '2.webp': stickerBytes,
    '3.webp': stickerBytes,
  }, { level: 0 });
  return new Blob([archive as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' });
}

export async function renderExport(format: ExportFormat, project: Project, assets: ReadonlyMap<string, StoredAsset>,
  signal: AbortSignal, progress: (ratio: number) => void, frame: number, videoContainer?: string): Promise<ExportResult> {
  if (format === 'webp') return { blob: await imageExport(project, assets, signal, frame), extension: 'webp' };
  if (format === 'whatsapp-image') return { blob: await imagePngExport(project, assets, signal, frame), extension: 'png' };
  if (format === 'animated-webp') return { blob: await animatedExport(project, assets, signal, progress), extension: 'webp' };
  if (format === 'wastickers') return { blob: await makeWastickers(project, assets, signal, frame, progress), extension: 'wastickers' };
  if (format === 'wav') return { blob: await soundExport(project, assets, signal), extension: 'wav' };
  if (format === 'mp3') {
    const { mp3File } = await import('./codec');
    return { blob: await mp3File(await soundExport(project, assets, signal), signal), extension: 'mp3' };
  }
  if (format === 'opus') {
    const { opusFile } = await import('./codec');
    return { blob: await opusFile(await soundExport(project, assets, signal), signal), extension: 'ogg' };
  }
  if (format === 'video') return videoExport(project, assets, projectDuration(project, assets), signal, progress, videoContainer);
  const { makeBackup } = await import('./backup');
  return { blob: await makeBackup(project, assets, signal), extension: 'stickerwave.zip' };
}