const fourCC = (name: string) => new TextEncoder().encode(name);
const readCC = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
const int24 = (buffer: Uint8Array, offset: number, value: number) => {
  buffer[offset] = value & 255;
  buffer[offset + 1] = value >>> 8 & 255;
  buffer[offset + 2] = value >>> 16 & 255;
};
function chunk(name: string, payload: Uint8Array) {
  const output = new Uint8Array(8 + payload.length + payload.length % 2);
  output.set(fourCC(name));
  new DataView(output.buffer).setUint32(4, payload.length, true);
  output.set(payload, 8);
  return output;
}

function framePayload(webp: Uint8Array, duration: number, width: number, height: number) {
  if (readCC(webp, 0) !== 'RIFF' || readCC(webp, 8) !== 'WEBP') throw new Error('3004');
  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
  const bitstream: Uint8Array[] = [];
  let picture = false;
  for (let offset = 12; offset + 8 <= webp.length;) {
    const name = readCC(webp, offset);
    const size = view.getUint32(offset + 4, true);
    const next = offset + 8 + size + size % 2;
    if (next > webp.length) throw new Error('3004');
    if (name === 'ALPH' || name === 'VP8 ' || name === 'VP8L') bitstream.push(webp.subarray(offset, next));
    if (name === 'VP8 ' || name === 'VP8L') picture = true;
    offset = next;
  }
  if (!picture) throw new Error('3004');
  const header = new Uint8Array(16 + bitstream.reduce((sum, data) => sum + data.length, 0));
  int24(header, 6, width - 1);
  int24(header, 9, height - 1);
  int24(header, 12, duration);
  header[15] = 2; // Replace the whole canvas, including transparent pixels.
  let position = 16;
  for (const data of bitstream) { header.set(data, position); position += data.length; }
  return chunk('ANMF', header);
}

export function webpAnimation(frames: { bytes: Uint8Array; duration: number }[], width: number, height: number) {
  if (frames.length < 2 || frames.length > 240 || !width || !height) throw new Error('3004');
  const extended = new Uint8Array(10);
  extended[0] = 0x12; // Alpha and animation.
  int24(extended, 4, width - 1);
  int24(extended, 7, height - 1);
  const data = [chunk('VP8X', extended), chunk('ANIM', new Uint8Array(6)),
    ...frames.map(frame => framePayload(frame.bytes, frame.duration, width, height))];
  const header = new Uint8Array(12);
  header.set(fourCC('RIFF'));
  header.set(fourCC('WEBP'), 8);
  new DataView(header.buffer).setUint32(4, 4 + data.reduce((total, payload) => total + payload.length, 0), true);
  return new Blob([header, ...data], { type: 'image/webp' });
}
