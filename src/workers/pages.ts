import { MAX_PIXELS } from '../core/project';
import UTIF from 'utif';

declare function postMessage(message: unknown, transfer: Transferable[]): void;
function bounded(width: number, height: number) {
  if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > MAX_PIXELS) throw new Error('1002');
}

self.addEventListener('message', async ({ data }: MessageEvent<{ bytes: ArrayBuffer; mime: string; page: number }>) => {
  const { bytes, mime, page } = data;
  try {
    let width: number, height: number, count: number, pixels: Uint8ClampedArray<ArrayBuffer>;
    if (mime === 'image/heic') {
      const { default: heif } = await import('libheif-js/wasm-bundle');
      const decoder = new heif.HeifDecoder();
      const images = decoder.decode(new Uint8Array(bytes));
      count = images.length;
      const image = images[page];
      if (!image || count > 600) throw new Error('1004');
      width = image.get_width();
      height = image.get_height();
      bounded(width, height);
      pixels = new Uint8ClampedArray(width * height * 4);
      const result = await new Promise<typeof pixels>((resolve, reject) => {
        image.display({ data: pixels, width, height }, value => value ? resolve(value.data) : reject(new Error('1004')));
      });
      pixels.set(result);
    } else {
      const pages = UTIF.decode(bytes);
      count = pages.length;
      const image = pages[page];
      if (!image || count > 600) throw new Error('1004');
      const tags = image as unknown as { t256?: number[]; t257?: number[] };
      bounded(tags.t256?.[0] ?? 0, tags.t257?.[0] ?? 0);
      UTIF.decodeImage(bytes, image);
      width = image.width;
      height = image.height;
      bounded(width, height);
      pixels = new Uint8ClampedArray(UTIF.toRGBA8(image));
    }
    postMessage({ pixels, width, height, count }, [pixels.buffer]);
  } catch (error) { postMessage({ error: error instanceof Error && error.message === '1002' ? '1002' : '1004' }, []); }
});
