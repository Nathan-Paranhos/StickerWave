import { MAX_SOURCE_DURATION, MAX_PIXELS, SIZE, limits, type MediaMime, type VisualStyle, type TextStyle, type StoredAsset } from '../core/project';

import { inspectFrames, decodePage, pagedMime } from './frames';
import { safeSvg } from './svg';

const ascii = (bytes: Uint8Array, start: number, count: number) => String.fromCharCode(...bytes.subarray(start, start + count));
const starts = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((value, index) => bytes[index + offset] === value);

export function identify(bytes: Uint8Array, expected: 'visual' | 'audio'): MediaMime | null {
  if (starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (starts(bytes, [255, 216, 255])) return 'image/jpeg';
  if (ascii(bytes, 0, 3) === 'GIF') return 'image/gif';
  if (ascii(bytes, 0, 2) === 'BM') return 'image/bmp';
  if (starts(bytes, [0, 0, 1, 0])) return 'image/x-icon';
  if (starts(bytes, [73, 73, 42, 0]) || starts(bytes, [77, 77, 0, 42])) return 'image/tiff';
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s/>]/i.test(new TextDecoder().decode(bytes.subarray(0, 1024)))) return 'image/svg+xml';
  if (ascii(bytes, 0, 4) === 'RIFF') {
    if (ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
    if (ascii(bytes, 8, 4) === 'WAVE') return 'audio/wav';
  }
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    const brands = [brand];
    for (let offset = 16; offset + 4 <= Math.min(128, bytes.length); offset += 4) brands.push(ascii(bytes, offset, 4));
    if (brands.some(value => ['avif', 'avis'].includes(value))) return 'image/avif';
    if (brands.some(value => ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(value))) return 'image/heic';
    return expected === 'audio' ? 'audio/mp4' : 'video/mp4';
  }
  if (starts(bytes, [26, 69, 223, 163])) return expected === 'audio' ? 'audio/webm' : 'video/webm';
  if (ascii(bytes, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(bytes, 0, 3) === 'ID3') return 'audio/mpeg';
  if (bytes[0] === 255 && (bytes[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6)) return 'audio/mpeg';
  return null;
}

export function checkDimensions(width: number, height: number) {
  if (!width || !height || width > 4096 || height > 4096 || width * height > MAX_PIXELS) throw new Error('1002');
}

function imageHeader(bytes: Uint8Array, mime: MediaMime) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png' && bytes.length >= 24) {
    checkDimensions(data.getUint32(16), data.getUint32(20));
    for (let offset = 8; offset + 8 <= bytes.length;) {
      const type = ascii(bytes, offset + 4, 4);
      if (type === 'acTL') return true;
      if (type === 'IDAT') break;
      offset += data.getUint32(offset) + 12;
    }
  }
  if (mime === 'image/webp' && bytes.length >= 30) {
    const type = ascii(bytes, 12, 4);
    if (type === 'VP8X') {
      
      checkDimensions(1 + (data.getUint32(24, true) & 0xffffff), 1 + (data.getUint32(26, true) >>> 8));
      if (bytes[20] & 2) return true;
    }
    if (type === 'VP8 ') checkDimensions(data.getUint16(26, true) & 0x3fff, data.getUint16(28, true) & 0x3fff);
    if (type === 'VP8L') {
      const dimensions = data.getUint32(21, true);
      checkDimensions((dimensions & 0x3fff) + 1, ((dimensions >>> 14) & 0x3fff) + 1);
    }
  }
  if (mime === 'image/gif' && bytes.length >= 10) {
    checkDimensions(data.getUint16(6, true), data.getUint16(8, true));
    return true;
  }
  if (mime === 'image/avif' && ascii(bytes, 0, Math.min(bytes.length, 120)).includes('avis')) return true;
  if (mime === 'image/jpeg') {
    for (let offset = 2; offset + 9 <= bytes.length;) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1];
      if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
        checkDimensions(data.getUint16(offset + 7), data.getUint16(offset + 5));
        return;
      }
      if (marker === 255) { offset += 1; continue; }
      if (marker === 218 || marker === 217) break;
      const length = data.getUint16(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
    throw new Error('1003');
  }
}

export async function hash(blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function decodeAudio(blob: Blob) {
  let context: OfflineAudioContext;
  try { context = new OfflineAudioContext(2, 1, 48000); }
  catch { context = new OfflineAudioContext(2, 1, 44100); }
  try { return await context.decodeAudioData(await blob.arrayBuffer()); }
  catch { throw new Error('1004'); }
}

export type Drawable = ImageBitmap | HTMLImageElement | HTMLVideoElement | VideoFrame;
export async function openVisual(blob: Blob, mime: string, signal?: AbortSignal, page = 0): Promise<Drawable> {
  signal?.throwIfAborted();
  if (pagedMime(mime)) {
    const { pixels, width, height } = await decodePage(blob, mime, page, signal);
    return createImageBitmap(new ImageData(pixels, width, height));
  }
  if (mime === 'image/svg+xml') blob = await safeSvg(blob);
  if (mime.startsWith('image/') && mime !== 'image/svg+xml' && typeof createImageBitmap !== 'undefined') {
    let bitmap: ImageBitmap | undefined;
    try { bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image', colorSpaceConversion: 'default' }); }
    catch { /* Try the browser image element for formats such as ICO. */ }
    if (signal?.aborted) { bitmap?.close(); signal.throwIfAborted(); }
    if (bitmap) return bitmap;
  }
  const url = URL.createObjectURL(blob);
  const isVideo = mime.startsWith('video/');
  const element = isVideo ? document.createElement('video') : new Image();
  if (element instanceof HTMLVideoElement) {
    element.muted = true;
    element.playsInline = true;
    element.setAttribute('playsinline', '');
    element.setAttribute('webkit-playsinline', '');
    element.preload = 'auto';
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => settle(false, new Error('1004')), 8000);
      const event = isVideo ? 'loadeddata' : 'load';
      const finish = () => settle(true);
      const error = () => settle(false, new Error('1004'));
      const abort = () => settle(false, signal?.reason);
      function settle(success: boolean, reason?: unknown) {
        clearTimeout(timeout);
        element.removeEventListener(event, finish);
        element.removeEventListener('error', error);
        signal?.removeEventListener('abort', abort);
        if (success) resolve(); else reject(reason);
      }
      signal?.addEventListener('abort', abort, { once: true });
      element.addEventListener(event, finish, { once: true });
      element.addEventListener('error', error, { once: true });
      element.src = url;
    });
    element.dataset.objectUrl = url;
    return element;
  } catch (error) {
    URL.revokeObjectURL(url);
    element.removeAttribute('src');
    if (element instanceof HTMLVideoElement) element.load();
    throw error;
  }
}
export function closeVisual(source: Drawable) {
  if ('close' in source) { source.close(); return; }
  if (source instanceof HTMLVideoElement || source instanceof HTMLImageElement) {
    if (source.dataset.objectUrl) URL.revokeObjectURL(source.dataset.objectUrl);
    if (source instanceof HTMLVideoElement) {
      source.pause();
      source.removeAttribute('src');
      source.load();
    }
  }
}
function dimensions(source: Drawable) {
  if (source instanceof HTMLVideoElement) return [source.videoWidth, source.videoHeight];
  if (source instanceof HTMLImageElement) return [source.naturalWidth, source.naturalHeight];
  if ('displayWidth' in source) return [source.displayWidth, source.displayHeight];
  return [source.width, source.height];
}

export async function importMedia(file: Blob, name: string, expected: 'visual' | 'audio', signal?: AbortSignal): Promise<StoredAsset> {
  if (!file.size || file.size > limits.video) throw new Error('1002');
  const bytes = new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer());
  const mime = identify(bytes, expected);
  if (!mime || mime.startsWith('audio/') !== (expected === 'audio')) throw new Error('1001');
  const kind = mime.split('/')[0] as keyof typeof limits;
  if (file.size > limits[kind]) throw new Error('1002');
  const animated = kind === 'image' && imageHeader(bytes, mime) === true;
  if (mime === 'audio/wav' && bytes.length >= 16) {
    const view = new DataView(bytes.buffer);
    for (let offset = 12; offset + 8 < bytes.length;) {
      const length = view.getUint32(offset + 4, true);
      if (ascii(bytes, offset, 4) === 'fmt ' && offset + 20 <= bytes.length) {
        const bytesPerSecond = view.getUint32(offset + 16, true);
        if (bytesPerSecond && (file.size - 44) / bytesPerSecond > 61) throw new Error('1002');
        break;
      }
      offset += 8 + length + length % 2;
    }
  }
  const blob = file.slice(0, file.size, mime);
  const parsed = kind === 'image' ? await inspectFrames(blob, mime, animated, checkDimensions, signal) : null;
  if (parsed) return {
    id: crypto.randomUUID(), sha256: await hash(blob), mime, size: blob.size,
    name: name.slice(0, 200), blob, ...parsed,
  };
  let width = 0;
  let height = 0;
  let duration = 0;
  if (kind === 'audio') {
    const audio = await decodeAudio(blob);
    duration = Math.round(audio.duration * 1000);
    if (audio.numberOfChannels > 2) throw new Error('1002');
  } else {
    const element = await openVisual(blob, mime, signal);
    try {
      [width, height] = dimensions(element);
      checkDimensions(width, height);
      if (element instanceof HTMLVideoElement) duration = Math.round(element.duration * 1000);
    } finally { closeVisual(element); }
  }
  if (kind !== 'image' && (!Number.isFinite(duration) || duration < 100 || duration > MAX_SOURCE_DURATION)) throw new Error('1002');
  signal?.throwIfAborted();
  return { id: crypto.randomUUID(), sha256: await hash(blob), mime, size: blob.size,
    name: name.slice(0, 200), width, height, duration, blob };
}

export function drawMedia(ctx: CanvasRenderingContext2D, visual: VisualStyle, source: Drawable | null) {
  if (source && (!(source instanceof HTMLVideoElement) || source.readyState >= 2)) {
    const [w, h] = dimensions(source);
    if (w && h) {
      const crop = visual.crop / 100;
      const sw = w * (1 - crop * 2);
      const sh = h * (1 - crop * 2);
      const fit = visual.fit === 'cover' ? Math.max : Math.min;
      const scale = fit(SIZE / sw, SIZE / sh) * visual.zoom;
      ctx.save();
      ctx.globalAlpha = visual.opacity;
      ctx.translate(SIZE / 2 + visual.x, SIZE / 2 + visual.y);
      ctx.rotate(visual.rotation * Math.PI / 180);
      ctx.scale(visual.horizontal ? -1 : 1, visual.vertical ? -1 : 1);
      ctx.drawImage(source, w * crop, h * crop, sw, sh, -sw * scale / 2, -sh * scale / 2, sw * scale, sh * scale);
      ctx.restore();
    }
  }
}

export function drawText(ctx: CanvasRenderingContext2D, text: TextStyle) {
  if (!text.content) return;
  ctx.save();
  ctx.font = `800 ${text.size}px ${text.font}`;
  ctx.fillStyle = text.color;
  ctx.textAlign = text.align;
  ctx.textBaseline = 'middle';
  const x = { left: 20, center: SIZE / 2, right: SIZE - 20 }[text.align];
  const lines = text.content.split('\n').slice(0, 5);
  lines.forEach((line, index) => {
    const y = text.y + (index - lines.length + 1) * text.size * 1.1;
    if (text.shadow > 0) {
      ctx.shadowColor = text.shadowColor;
      ctx.shadowBlur = text.shadow;
      ctx.shadowOffsetY = Math.ceil(text.shadow / 3);
    }
    if (text.stroke > 0) {
      ctx.strokeStyle = text.strokeColor;
      ctx.lineWidth = text.stroke;
      ctx.lineJoin = 'round';
      ctx.strokeText(line, x, y, SIZE - 40);
    }
    ctx.fillText(line, x, y, SIZE - 40);
  });
  ctx.restore();
}
export function seek(video: HTMLVideoElement, target: number, signal?: AbortSignal) {
  if (Math.abs(video.currentTime - target) < .002) return Promise.resolve();
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(onError, 2500);
    function settle(error?: unknown) {
      clearTimeout(timeout);
      video.removeEventListener('seeked', onSeek);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    }
    function onSeek() { settle(); }
    function onError() { settle(new Error('1004')); }
    function onAbort() { settle(signal?.reason); }
    video.addEventListener('seeked', onSeek, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    video.currentTime = target;
  });
}

const recordTypes = ['video/mp4;codecs=avc1.42001f,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
export function videoFormats() {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function'
    ? recordTypes.filter(type => MediaRecorder.isTypeSupported(type)) : [];
}
export function audioFormats() {
  return typeof MediaRecorder === 'undefined' ? [] :
    ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].filter(type => MediaRecorder.isTypeSupported(type));
}
