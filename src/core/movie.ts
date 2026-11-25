type Streams = { video: boolean; audio: boolean };

function mp4(bytes: Uint8Array): Streams {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const tracks: Streams = { video: false, audio: false };
  function scan(start: number, limit: number, parent: string) {
    for (let offset = start; offset + 8 <= limit;) {
      const code = text(offset + 4);
      let header = 8;
      let size = view.getUint32(offset);
      if (size === 1) {
        if (offset + 16 > limit) return;
        size = Number(view.getBigUint64(offset + 8));
        header = 16;
      } else if (size === 0) size = limit - offset;
      if (size < header || size > limit - offset) return;
      const payload = offset + header;
      const end = offset + size;
      if (code === 'moov' && parent === '' || code === 'trak' && parent === 'moov' || code === 'mdia' && parent === 'trak') {
        scan(payload, end, code);
      } else if (code === 'hdlr' && parent === 'mdia' && end - payload >= 12) {
        const handler = text(payload + 8);
        if (handler === 'vide') tracks.video = true;
        if (handler === 'soun') tracks.audio = true;
      }
      offset = end;
    }
  }
  scan(0, bytes.length, '');
  return tracks;
}

function webm(bytes: Uint8Array): Streams {
  const tracks: Streams = { video: false, audio: false };
  function field(offset: number, limit: number, identifier: boolean) {
    const first = bytes[offset];
    if (!first) return null;
    let length = 1;
    let marker = 0x80;
    while (!(first & marker)) { marker >>= 1; length++; }
    if (offset + length > limit || identifier && length > 4) return null;
    let value = identifier ? first : first & (marker - 1);
    let unknown = !identifier && value === marker - 1;
    for (let position = offset + 1; position < offset + length; position++) {
      value = value * 256 + bytes[position];
      unknown &&= bytes[position] === 255;
    }
    return { value, end: offset + length, unknown };
  }
  function scan(start: number, limit: number, parent: number) {
    for (let offset = start; offset < limit;) {
      const id = field(offset, limit, true);
      const size = id && field(id.end, limit, false);
      if (!id || !size) return;
      const end = size.unknown ? limit : size.end + size.value;
      if (end > limit || end < size.end) return;
      if (id.value === 0x18538067 && parent === 0 || id.value === 0x1654ae6b && parent === 0x18538067 ||
        id.value === 0xae && parent === 0x1654ae6b) {
        scan(size.end, end, id.value);
      } else if (id.value === 0x83 && parent === 0xae && end - size.end === 1) {
        if (bytes[size.end] === 1) tracks.video = true;
        if (bytes[size.end] === 2) tracks.audio = true;
      }
      offset = end;
    }
  }
  scan(0, bytes.length, 0);
  return tracks;
}

export function movieStreams(bytes: Uint8Array, mime: 'video/mp4' | 'video/webm') {
  return mime === 'video/mp4' ? mp4(bytes) : webm(bytes);
}
