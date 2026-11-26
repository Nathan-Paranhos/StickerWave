import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { CompositionPipeline } from '../../src/media/composition-pipeline.js';
import { FFmpegAdapter } from '../../src/media/ffmpeg-adapter.js';
import { sniffMediaBytes } from '../../src/media/magic-bytes.js';
import { waveformFromPcm16 } from '../../src/media/audio-processor.js';
import { inspectWebpBuffer } from '../../src/media/webp-inspector.js';

const repoFixtures = path.resolve(process.cwd(), '../../qa/fixtures');
const ffmpeg = new FFmpegAdapter();

test('Magic-byte sniffing distinguishes real signatures regardless of filenames', () => {
  assert.equal(sniffMediaBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).kind, 'png');
  assert.equal(sniffMediaBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).kind, 'jpeg');
  assert.equal(sniffMediaBytes(Buffer.from('GIF89a......')).kind, 'gif');
  assert.equal(sniffMediaBytes(Buffer.from('RIFF1234WEBP')).kind, 'webp');
  assert.equal(sniffMediaBytes(Buffer.from('RIFF1234WAVE')).kind, 'wav');
  assert.equal(sniffMediaBytes(Buffer.from('OggS\x00\x02')).kind, 'ogg');
  assert.equal(sniffMediaBytes(Buffer.from('<svg></svg>')).kind, 'unknown');
});

test('waveformFromPcm16 normalizes 64 bars between 0 and 100 including silence safety', () => {
  const silent = Buffer.alloc(640);
  const silentWave = waveformFromPcm16(silent);
  assert.equal(silentWave.length, 64);
  assert.equal(Math.max(...silentWave), 0);

  const tone = Buffer.alloc(1600 * 2);
  for (let i = 0; i < 1600; i++) {
    tone.writeInt16LE(Math.round(Math.sin(i / 8) * (i < 800 ? 3000 : 12000)), i * 2);
  }
  const wave = waveformFromPcm16(tone);
  assert.equal(wave.length, 64);
  assert.equal(Math.max(...wave), 100);
  assert.ok(wave[5]! < wave[55]!);
});

test('FFmpegAdapter validates capabilities with libwebp and libopus installed', async () => {
  const caps = await ffmpeg.checkCapabilities();
  assert.equal(caps.ready, true, caps.error);
  assert.equal(caps.encoders.libwebp, true);
  assert.equal(caps.encoders.libopus, true);
});

test('CompositionPipeline processes PNG transparency + WAV into valid 512x512 WebP + Ogg/Opus', async () => {
  const config = loadConfig();
  const pipeline = new CompositionPipeline(ffmpeg, config);
  const png = await fs.readFile(path.join(repoFixtures, 'transparency.png'));
  const wav = await fs.readFile(path.resolve(process.cwd(), '../../public/sounds/pop.wav'));

  const result = await pipeline.process({
    visualBytes: png,
    audioBytes: wav,
    audioOptions: { trimStartMs: 0, trimEndMs: 500, fadeOutMs: 60, normalizePeak: true },
  });

  assert.equal(result.isAnimated, false);
  assert.equal(result.visualInspection.width, 512);
  assert.equal(result.visualInspection.height, 512);
  assert.ok(result.webpBuffer.byteLength > 100 && result.webpBuffer.byteLength <= config.maxStickerBytes);
  assert.equal(result.audioStats.codec, 'opus');
  assert.equal(result.audioStats.sampleRate, 48000);
  assert.equal(result.waveform.byteLength, 64);
  assert.ok(result.oggBuffer.subarray(0, 4).toString('ascii') === 'OggS');
});

test('CompositionPipeline processes animated GIF + audio into animated looping 512x512 WebP under 500 KB', async () => {
  const config = loadConfig();
  const pipeline = new CompositionPipeline(ffmpeg, config);
  const gif = await fs.readFile(path.join(repoFixtures, 'motion.gif'));
  const wav = await fs.readFile(path.resolve(process.cwd(), '../../public/sounds/tada.wav'));

  const result = await pipeline.process({
    visualBytes: gif,
    audioBytes: wav,
  });

  const inspected = inspectWebpBuffer(result.webpBuffer);
  assert.ok(inspected?.valid);
  assert.equal(inspected.animated, true);
  assert.equal(inspected.width, 512);
  assert.equal(inspected.height, 512);
  assert.ok(result.webpBuffer.byteLength <= config.maxStickerBytes);
  assert.equal(result.audioStats.codec, 'opus');
});

test('CompositionPipeline extracts audio directly from WebM video fixture when separate audio omitted', async () => {
  const config = loadConfig();
  const pipeline = new CompositionPipeline(ffmpeg, config);
  const webm = await fs.readFile(path.join(repoFixtures, 'video.webm'));

  const result = await pipeline.process({ visualBytes: webm });
  assert.equal(result.isAnimated, true);
  assert.equal(result.visualInspection.width, 512);
  assert.equal(result.visualInspection.height, 512);
  assert.equal(result.audioStats.codec, 'opus');
  assert.ok(result.durationSec > 0.2);
});

test('CompositionPipeline rejects corrupted and oversized inputs safely', async () => {
  const config = loadConfig({ ...process.env, MAX_VISUAL_UPLOAD_BYTES: '1024' });
  const pipeline = new CompositionPipeline(ffmpeg, config);

  await assert.rejects(
    pipeline.process({ visualBytes: Buffer.from('not-a-media-file'), audioBytes: Buffer.from('RIFF0000WAVE') }),
    /Unsupported visual file signature/,
  );

  await assert.rejects(
    pipeline.process({ visualBytes: Buffer.alloc(2048, 0x89), audioBytes: Buffer.from('RIFF0000WAVE') }),
    /exceeds upload cap/,
  );

  // Valid PNG magic bytes but truncated/corrupt body
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-bad-'));
  try {
    await assert.rejects(
      pipeline.process({
        visualBytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]),
        audioBytes: await fs.readFile(path.resolve(process.cwd(), '../../public/sounds/pop.wav')),
      }),
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('CompositionPipeline processes PNG + MP3, JPEG + WAV, MP4 + original audio, silent audio, and mismatched durations', async () => {
  const config = loadConfig();
  const pipeline = new CompositionPipeline(ffmpeg, config);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-matrix-'));

  try {
    const mp3Path = path.join(tmpDir, 'tone.mp3');
    const mp4Path = path.join(tmpDir, 'clip.mp4');
    const silentWavPath = path.join(tmpDir, 'silence.wav');

    // Generate real MP3, MP4 (with H.264 + AAC audio), and silent WAV fixtures via FFmpeg
    await ffmpeg.run(['-f', 'lavfi', '-i', 'sine=frequency=520:duration=2.4', '-c:a', 'libmp3lame', '-b:a', '96k', mp3Path]);
    await ffmpeg.run([
      '-f', 'lavfi', '-i', 'color=c=0x4488FF:s=320x240:r=15:d=1.2',
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1.2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4Path,
    ]);
    await ffmpeg.run(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '0.9', '-c:a', 'pcm_s16le', silentWavPath]);

    const pngBytes = await fs.readFile(path.join(repoFixtures, 'transparency.png'));
    const jpgBytes = await fs.readFile(path.join(repoFixtures, 'exif-1.jpg'));
    const wavBytes = await fs.readFile(path.resolve(process.cwd(), '../../public/sounds/pop.wav'));
    const mp3Bytes = await fs.readFile(mp3Path);
    const mp4Bytes = await fs.readFile(mp4Path);
    const silentWavBytes = await fs.readFile(silentWavPath);

    // 1) PNG + MP3
    const pngMp3 = await pipeline.process({ visualBytes: pngBytes, audioBytes: mp3Bytes });
    assert.equal(pngMp3.isAnimated, false);
    assert.equal(pngMp3.audioStats.codec, 'opus');
    assert.ok(pngMp3.durationSec >= 2.0);

    // 2) JPEG EXIF + WAV
    const jpgWav = await pipeline.process({
      visualBytes: jpgBytes,
      audioBytes: wavBytes,
      shapeOptions: { shape: 'circle', borderWhite: true },
    });
    assert.equal(jpgWav.visualInspection.width, 512);
    assert.equal(jpgWav.visualInspection.height, 512);

    // 3) MP4 + original embedded audio track
    const mp4Res = await pipeline.process({ visualBytes: mp4Bytes });
    assert.equal(mp4Res.isAnimated, true);
    assert.equal(mp4Res.audioStats.codec, 'opus');

    // 4) Silent audio + mismatched visual/audio durations (0.4s GIF vs 2.4s MP3)
    const gifBytes = await fs.readFile(path.join(repoFixtures, 'motion.gif'));
    const mismatched = await pipeline.process({ visualBytes: gifBytes, audioBytes: mp3Bytes });
    assert.equal(mismatched.isAnimated, true);
    assert.ok(mismatched.durationSec > 1.5);

    const silentRes = await pipeline.process({ visualBytes: pngBytes, audioBytes: silentWavBytes });
    assert.equal(Math.max(...silentRes.waveform), 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
