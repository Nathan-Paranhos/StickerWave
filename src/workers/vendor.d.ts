/// <reference types="vite/client" />

declare module 'libheif-js/wasm-bundle' {
  type Pixels = { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };
  class HeifDecoder {
    decode(bytes: Uint8Array): { get_width(): number; get_height(): number; display(destination: Pixels, done: (value: Pixels | null) => void): void }[];
  }
  const heif: { HeifDecoder: typeof HeifDecoder };
  export default heif;
}
