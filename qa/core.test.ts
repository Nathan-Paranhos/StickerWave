import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createProject, projectDuration, projectSchema, updateTrim, validateAssets, type StoredAsset } from '../src/core/project';
import { pcmWav, waveform } from '../src/core/wav';
import { checkDimensions, identify } from '../src/infrastructure/media';

test('trims preserve a 100 ms minimum and 10 second composition limit', () => {
  const original = { start: 20_000, end: 25_000 };
  assert.deepEqual(updateTrim(original, 'start', 0, 60_000), { start: 15_000, end: 25_000 });
  assert.deepEqual(updateTrim(original, 'start', 40_000, 60_000), { start: 24_900, end: 25_000 });
  assert.deepEqual(updateTrim(original, 'end', 21, 60_000), { start: 20_000, end: 20_100 });
  assert.deepEqual(updateTrim(original, 'end', 34_000, 60_000), { start: 20_000, end: 30_000 });
  assert.deepEqual(updateTrim(original, 'end', 34_000, 28_000), { start: 20_000, end: 28_000 });
});

test('project schema rejects invalid trims, unknown versions and invalid asset references', () => {
  const project = createProject('QA');
  assert(projectSchema.safeParse(project).success);
  assert.equal(projectDuration(project, new Map()), 5000);
  assert.equal(projectSchema.safeParse({ ...project, schemaVersion: 20 }).success, false);
  assert.equal(projectSchema.safeParse({ ...project, media: crypto.randomUUID() }).success, false);
  assert.equal(projectSchema.safeParse({ ...project, sound: { ...project.sound, trim: { start: 0, end: 10001 } } }).success, false);
  assert.throws(() => validateAssets({ ...project, audio: crypto.randomUUID() }, new Map()), /4002/);
});

test('project duration uses the longest selected audio or video track', () => {
  const project = createProject('QA');
  const id = crypto.randomUUID();
  const asset: StoredAsset = {
    id, name: 'fixture.webm', duration: 7800, mime: 'video/webm', width: 80, height: 80, sha256: '0'.repeat(64),
    size: 6, blob: new Blob(['sample']),
  };
  const assets = new Map([[id, asset]]);
  const input = { ...project, media: id, visualOptions: [id], visual: { ...project.visual, trim: { start: 1000, end: 4100 } } };
  validateAssets(input, assets);
  assert.equal(projectDuration(input, assets), 3100);
  assert.throws(() => validateAssets({ ...input, audio: id }, assets), /4002/);
});

test('WAV encoder writes PCM16 little endian, interleaves channels and clips at full scale', () => {
  const wav = pcmWav([Float32Array.from([-.5, 1.5]), Float32Array.from([.25, -1.2])], 48000);
  const view = new DataView(wav);
  assert.equal(identify(new Uint8Array(wav), 'audio'), 'audio/wav');
  assert.equal(view.getUint32(4, true), 44);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48_000);
  assert.equal(view.getUint32(40, true), 8);
  assert.deepEqual([44, 46, 48, 50].map(offset => view.getInt16(offset, true)), [-16384, 8192, 32767, -32768]);
  assert.throws(() => pcmWav([Float32Array.from([0, 1]), Float32Array.from([0])], 48000), /3004/);
});

test('waveform reduces blocks to absolute peaks', () => {
  assert.deepEqual(waveform(Float32Array.from([-.5, .25, -1, .125]), 2), [.5, 1]);
});

test('media probe ignores filename type and enforces decoded dimensions', () => {
  const raw = (value: string) => new Uint8Array(Buffer.from(value));
  assert.equal(identify(raw('RIFFabcdWEBP'), 'visual'), 'image/webp');
  assert.equal(identify(raw('xxxxftypM4A '), 'audio'), 'audio/mp4');
  assert.equal(identify(raw('xxxxftypavif'), 'visual'), 'image/avif');
  assert.equal(identify(raw('<svg/>'), 'visual'), 'image/svg+xml');
  assert.doesNotThrow(() => checkDimensions(4096, 4096));
  assert.throws(() => checkDimensions(4097, 200), /1002/);
});

test('the 120 catalog entries match the binary assets, license and WAV durations', () => {
  const catalog = JSON.parse(readFileSync('public/sounds/catalog.json', 'utf8'));
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.sounds.length, 120);
  assert.equal(new Set(catalog.sounds.map((sound: { id: string }) => sound.id)).size, 120);
  for (const sound of catalog.sounds) {
    const wav = readFileSync('public' + sound.url);
    assert.equal(wav.length, sound.sizeBytes);
    assert.equal(createHash('sha256').update(wav).digest('hex'), sound.sha256);
    assert.equal(identify(wav, 'audio'), 'audio/wav');
    assert.equal(wav.readUInt32LE(24), sound.sampleRate);
    assert.equal(wav.readUInt16LE(22), sound.channels);
    assert.equal(wav.readUInt32LE(40) / wav.readUInt32LE(28) * 1000, sound.durationMs);
    assert.equal(sound.license, 'CC0-1.0');
  }
});

test('detects audio and video tracks from MP4/WebM header fixtures', async () => {
  const { movieStreams } = await import('../src/core/movie');
  const bytes = (input: number[]) => Buffer.from(input);
  const box = (name: string, payload: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(payload.length + 8);
    header.write(name, 4, 'ascii');
    return Buffer.concat([header, payload]);
  };
  const mp4Track = (handler: string) =>
    box('trak', box('mdia', box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from(handler)]))));
  assert.deepEqual(movieStreams(box('moov', Buffer.concat([mp4Track('vide'), mp4Track('soun')])), 'video/mp4'),
    { video: true, audio: true });
  assert.deepEqual(movieStreams(box('moov', mp4Track('vide')), 'video/mp4'), { video: true, audio: false });
  const webm = bytes([0x18, 0x53, 0x80, 0x67, 0xff, 0x16, 0x54, 0xae, 0x6b, 0x8a,
    0xae, 0x83, 0x83, 0x81, 1, 0xae, 0x83, 0x83, 0x81, 2]);
  assert.deepEqual(movieStreams(webm, 'video/webm'), { video: true, audio: true });
  assert.deepEqual(movieStreams(webm.subarray(0, 10), 'video/webm'), { video: false, audio: false });
});

test('beta fields migrate v1 drafts and preserve editable primary tracks', () => {
  const current = createProject('Legacy draft');
  const legacy = structuredClone(current) as Record<string, unknown>;
  legacy.schemaVersion = 1;
  for (const key of ['layers', 'tracks', 'order', 'hidden']) delete legacy[key];
  legacy.visual = { fit: 'contain', x: 121, y: -45, zoom: 1.5, rotation: 90, horizontal: true, vertical: false, crop: 10, trim: { start: 0, end: 4300 } };
  legacy.sound = { gain: 1.3, muted: false, trim: { start: 250, end: 1700 } };
  legacy.text = { content: 'Preserved', color: '#333333', size: 36, align: 'left', font: 'serif', y: 400 };
  const migrated = projectSchema.parse(legacy);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.visual.x, 121);
  assert.equal(migrated.visual.frame, 0);
  assert.equal(migrated.sound.rate, 1);
  assert.equal(migrated.sound.gain, 1.3);
  assert.equal(migrated.text.content, 'Preserved');
  assert.equal(migrated.background, null);
  assert.equal(migrated.stickerShape, 'square');
  assert.equal(migrated.stickerBorder, false);
  assert.deepEqual(migrated.layers, []);
});
