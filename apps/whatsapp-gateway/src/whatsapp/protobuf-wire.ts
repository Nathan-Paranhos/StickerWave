/**
 * Schema-less Protobuf wire reader & binary inspector.
 *
 * Used by SoundStickerProtocol to verify raw wire fields independently of
 * generated protobuf schemas that omit experimental/proprietary extensions such as
 * StickerMessage.audioMessage (field 26).
 */

export const WIRE_TYPE = Object.freeze({
  VARINT: 0,
  FIXED64: 1,
  BYTES: 2,
  FIXED32: 5,
} as const);

export interface RawProtoField {
  field: number;
  wireType: 'varint' | 'fixed64' | 'fixed32' | 'bytes';
  value?: string;
  length?: number;
  payload?: Buffer;
}

export function readVarint(buffer: Uint8Array, startOffset: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let pos = startOffset;
  for (;;) {
    const byte = buffer[pos++];
    if (byte === undefined) {
      throw new Error('Unexpected end of protobuf buffer while reading varint.');
    }
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
    if (shift > 63n) throw new Error('Protobuf varint exceeds 64-bit limit.');
  }
}

export function parseRawProtoFields(buffer: Uint8Array): RawProtoField[] {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const fields: RawProtoField[] = [];
  let pos = 0;

  while (pos < buf.length) {
    let tag: bigint;
    [tag, pos] = readVarint(buf, pos);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field <= 0) throw new Error('Invalid protobuf field number 0.');

    if (wire === WIRE_TYPE.VARINT) {
      let value: bigint;
      [value, pos] = readVarint(buf, pos);
      fields.push({ field, wireType: 'varint', value: value.toString() });
    } else if (wire === WIRE_TYPE.FIXED64 || wire === WIRE_TYPE.FIXED32) {
      const size = wire === WIRE_TYPE.FIXED64 ? 8 : 4;
      if (pos + size > buf.length) throw new Error('Truncated fixed-width protobuf field.');
      fields.push({ field, wireType: wire === WIRE_TYPE.FIXED64 ? 'fixed64' : 'fixed32' });
      pos += size;
    } else if (wire === WIRE_TYPE.BYTES) {
      let length: bigint;
      [length, pos] = readVarint(buf, pos);
      const size = Number(length);
      if (size < 0 || pos + size > buf.length) {
        throw new Error('Truncated length-delimited protobuf field.');
      }
      fields.push({
        field,
        wireType: 'bytes',
        length: size,
        payload: buf.subarray(pos, pos + size),
      });
      pos += size;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}.`);
    }
  }

  return fields;
}

export function findProtoBytesField(fields: readonly RawProtoField[], fieldNumber: number): RawProtoField | undefined {
  return fields.find((f) => f.field === fieldNumber && f.wireType === 'bytes');
}

export function findProtoVarintField(fields: readonly RawProtoField[], fieldNumber: number): number | null {
  const found = fields.find((f) => f.field === fieldNumber && f.wireType === 'varint');
  return found && found.value !== undefined ? Number(found.value) : null;
}

export function encodeVarintTagAndBytes(fieldNumber: number, payload: Uint8Array): Buffer {
  const tagNum = (fieldNumber << 3) | WIRE_TYPE.BYTES;
  const tagBytes: number[] = [];
  let n = tagNum;
  while (n >= 0x80) {
    tagBytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  tagBytes.push(n);

  const lenBytes: number[] = [];
  let len = payload.byteLength;
  while (len >= 0x80) {
    lenBytes.push((len & 0x7f) | 0x80);
    len >>>= 7;
  }
  lenBytes.push(len);

  return Buffer.concat([Buffer.from(tagBytes), Buffer.from(lenBytes), Buffer.from(payload)]);
}

/**
 * Sanitizes raw wire representation (redacting URLs, hashes, keys) for protocol diagnostics.
 */
export function describeRawProtoSanitized(buffer: Uint8Array, indent = ''): string {
  const lines: string[] = [];
  for (const field of parseRawProtoFields(buffer)) {
    if (field.wireType !== 'bytes' || !field.payload) {
      lines.push(`${indent}#${field.field} ${field.wireType}${field.value ? ` = ${field.value}` : ''}`);
      continue;
    }
    const text = field.payload.toString('utf8');
    if (/^[\x20-\x7e]+$/.test(text) && (field.length ?? 0) < 300) {
      const sensitive = /^https?:|^\/[ov]\//i.test(text);
      lines.push(`${indent}#${field.field} text(${field.length}) = ${sensitive ? '<redacted-url>' : JSON.stringify(text)}`);
      continue;
    }
    let nested = false;
    try {
      if ((field.length ?? 0) > 1) {
        parseRawProtoFields(field.payload);
        nested = true;
      }
    } catch {
      nested = false;
    }
    if (nested) {
      lines.push(`${indent}#${field.field} message(${field.length}) {`, describeRawProtoSanitized(field.payload, `${indent}  `), `${indent}}`);
    } else {
      lines.push(`${indent}#${field.field} bytes(${field.length}) <redacted>`);
    }
  }
  return lines.join('\n');
}
