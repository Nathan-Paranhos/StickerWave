import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createGatewayRuntime } from '../../src/http/server.js';
import { extractAnimatedWebpToFfconcat } from '../../src/media/webp-frames.js';
import { inspectWebpBuffer } from '../../src/media/webp-inspector.js';
import { createStoredZip } from '../../src/utils/zip-store.js';

const fixturesDir = path.resolve(process.cwd(), '../../qa/fixtures');
const soundsDir = path.resolve(process.cwd(), '../../public/sounds');

test('Cloud Media Engine operates with WhatsApp Bot disabled (ENABLE_WA_BOT=false) and converts WebP, Opus, MP4, and .wastickers', async (t) => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-cloud-'));
  const runtime = createGatewayRuntime(
    {
      host: '127.0.0.1',
      port: 0,
      adminSecret: 'cloud-admin-secret-123456',
      dataDir: workDir,
      sessionDir: path.join(workDir, 'session'),
      dbPath: path.join(workDir, 'cloud.db'),
      allowedOrigins: ['https://stickerwave.netlify.app'],
      enableWaBot: false,
      rateLimitMaxRequests: 100,
    },
    { skipStartupReconnect: true },
  );

  t.after(async () => {
    await runtime.stop();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  const { port } = await runtime.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  const corsHeaders = { Origin: 'https://stickerwave.netlify.app' };

  // 1) Ready & capabilities report Cloud Media active without requiring a WhatsApp phone bot
  const readyRes = await fetch(`${baseUrl}/ready`, { headers: corsHeaders });
  assert.equal(readyRes.status, 200);
  const readyJson = (await readyRes.json()) as { ready: boolean; whatsappBotEnabled: boolean; whatsappConnected: boolean };
  assert.equal(readyJson.ready, true);
  assert.equal(readyJson.whatsappBotEnabled, false);
  assert.equal(readyJson.whatsappConnected, false);

  const capsRes = await fetch(`${baseUrl}/api/v1/capabilities`, { headers: corsHeaders });
  assert.equal(capsRes.status, 200);
  const capsJson = (await capsRes.json()) as { cloudMediaEnabled: boolean; cloudFormats: string[]; whatsappBotEnabled: boolean };
  assert.equal(capsJson.cloudMediaEnabled, true);
  assert.deepEqual(capsJson.cloudFormats, ['webp', 'opus', 'mp4', 'wastickers']);
  assert.equal(capsJson.whatsappBotEnabled, false);

  // Bot endpoints refuse cleanly when ENABLE_WA_BOT=false so no number turns into a public bot
  const botConnect = await fetch(`${baseUrl}/api/v1/admin/whatsapp/connect`, {
    method: 'POST',
    headers: { ...corsHeaders, Authorization: 'Bearer cloud-admin-secret-123456' },
  });
  assert.equal(botConnect.status, 503);

  const pngBytes = await fs.readFile(path.join(fixturesDir, 'transparency.png'));
  const gifBytes = await fs.readFile(path.join(fixturesDir, 'motion.gif'));
  const wavBytes = await fs.readFile(path.join(soundsDir, 'pop.wav'));

  // 2) WebP static conversion with circle crop + white border
  const webpForm = new FormData();
  webpForm.append('format', 'webp');
  webpForm.append('visual', new Blob([pngBytes], { type: 'image/png' }), 'sticker.png');
  webpForm.append('shapeOptions', JSON.stringify({ shape: 'circle', borderWhite: true, background: null }));
  const webpRes = await fetch(`${baseUrl}/api/v1/media/convert`, { method: 'POST', headers: corsHeaders, body: webpForm });
  assert.equal(webpRes.status, 200);
  assert.equal(webpRes.headers.get('x-sticker-cloud-engine'), 'stickerwave-ffmpeg');
  const webpBuf = Buffer.from(await webpRes.arrayBuffer());
  const webpInfo = inspectWebpBuffer(webpBuf);
  assert.ok(webpInfo?.valid);
  assert.equal(webpInfo?.width, 512);
  assert.equal(webpInfo?.height, 512);

  // 3) Ogg/Opus normalized audio conversion
  const opusForm = new FormData();
  opusForm.append('format', 'opus');
  opusForm.append('audio', new Blob([wavBytes], { type: 'audio/wav' }), 'pop.wav');
  opusForm.append('audioOptions', JSON.stringify({ normalizePeak: true, fadeInMs: 40 }));
  const opusRes = await fetch(`${baseUrl}/api/v1/media/convert`, { method: 'POST', headers: corsHeaders, body: opusForm });
  assert.equal(opusRes.status, 200);
  const opusBuf = Buffer.from(await opusRes.arrayBuffer());
  assert.equal(opusBuf.subarray(0, 4).toString('ascii'), 'OggS');

  // 4) MP4 Sticker Card (animated GIF + WAV audio -> verified with FFprobe)
  const mp4Form = new FormData();
  mp4Form.append('format', 'mp4');
  mp4Form.append('visual', new Blob([gifBytes], { type: 'image/gif' }), 'motion.gif');
  mp4Form.append('audio', new Blob([wavBytes], { type: 'audio/wav' }), 'pop.wav');
  const mp4Res = await fetch(`${baseUrl}/api/v1/media/convert`, { method: 'POST', headers: corsHeaders, body: mp4Form });
  assert.equal(mp4Res.status, 200);
  assert.equal(mp4Res.headers.get('content-type'), 'video/mp4');
  const mp4Buf = Buffer.from(await mp4Res.arrayBuffer());
  assert.ok(mp4Buf.subarray(0, 16).toString('latin1').includes('ftyp'));
  const mp4Path = path.join(workDir, 'verify.mp4');
  await fs.writeFile(mp4Path, mp4Buf);
  const mp4Probe = await runtime.ffmpeg.probe(mp4Path);
  assert.ok(mp4Probe.streams?.some((s) => s.codec_type === 'video' && s.width === 512 && s.height === 512));
  assert.ok(mp4Probe.streams?.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac'));

  // 5) .wastickers ZIP bundle containing title.txt, author.txt, tray.png, and WebP stickers
  const packForm = new FormData();
  packForm.append('format', 'wastickers');
  packForm.append('title', 'Meu Pack Cloud');
  packForm.append('visual', new Blob([gifBytes], { type: 'image/gif' }), 'motion.gif');
  const packRes = await fetch(`${baseUrl}/api/v1/media/convert`, { method: 'POST', headers: corsHeaders, body: packForm });
  assert.equal(packRes.status, 200);
  const packBuf = Buffer.from(await packRes.arrayBuffer());
  assert.equal(packBuf.subarray(0, 2).toString('ascii'), 'PK');
  assert.ok(packBuf.includes(Buffer.from('Meu Pack Cloud', 'utf8')));
  assert.ok(packBuf.includes(Buffer.from('tray.png', 'utf8')));
  assert.ok(packBuf.includes(Buffer.from('1.webp', 'utf8')));

  // 6) Canonical /api/stickers/process returns validated EXIF 0x5741 EncodedSoundSticker + sound-sha256
  const processForm = new FormData();
  processForm.append('visual', new Blob([pngBytes], { type: 'image/png' }), 'sticker.png');
  processForm.append('audio', new Blob([wavBytes], { type: 'audio/wav' }), 'pop.wav');
  processForm.append('packName', 'StickerWave Core Test');
  const processRes = await fetch(`${baseUrl}/api/stickers/process`, { method: 'POST', headers: corsHeaders, body: processForm });
  assert.equal(processRes.status, 200);
  const processJson = (await processRes.json()) as {
    ok: boolean;
    sticker: {
      stickerType: string;
      animated: boolean;
      hasAudio: boolean;
      exifMeta: { packPublisher: string; soundSha256: string } | null;
      validation: { valid: boolean; hasExif0x5741: boolean; soundSha256MatchesAudio: boolean };
    };
  };
  assert.equal(processJson.ok, true);
  assert.equal(processJson.sticker.stickerType, 'SOUND');
  assert.equal(processJson.sticker.animated, true);
  assert.equal(processJson.sticker.hasAudio, true);
  assert.equal(processJson.sticker.exifMeta?.packPublisher, 'Nathan Paranhos');
  assert.equal(processJson.sticker.validation.valid, true);
  assert.equal(processJson.sticker.validation.hasExif0x5741, true);
  assert.equal(processJson.sticker.validation.soundSha256MatchesAudio, true);

  // 7) Canonical /api/stickers/add-to-whatsapp returns honest bridge strategy when bot is off
  const bridgeForm = new FormData();
  bridgeForm.append('platform', 'android');
  bridgeForm.append('visual', new Blob([pngBytes], { type: 'image/png' }), 'sticker.png');
  bridgeForm.append('audio', new Blob([wavBytes], { type: 'audio/wav' }), 'pop.wav');
  const bridgeRes = await fetch(`${baseUrl}/api/stickers/add-to-whatsapp`, { method: 'POST', headers: corsHeaders, body: bridgeForm });
  assert.equal(bridgeRes.status, 200);
  const bridgeJson = (await bridgeRes.json()) as {
    ok: boolean;
    strategy: string;
    supportsAudioInNativePackApi: boolean;
    canDirectSendViaGateway: boolean;
  };
  assert.equal(bridgeJson.ok, true);
  assert.equal(bridgeJson.strategy, 'wa-bot-relay');
  assert.equal(bridgeJson.supportsAudioInNativePackApi, false);
  assert.equal(bridgeJson.canDirectSendViaGateway, false);
});

test('zip-store and animated WebP ffconcat extractor produce valid archives and frame manifests', async (t) => {
  const zip = createStoredZip([
    { name: 'hello.txt', data: Buffer.from('world', 'utf8') },
  ]);
  assert.equal(zip.subarray(0, 4).readUInt32LE(0), 0x04034b50);
  assert.ok(zip.includes(Buffer.from('hello.txt', 'utf8')));

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-anmf-'));
  t.after(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  // Synthesize minimal 2-frame ANMF animated WebP and verify ffconcat extraction
  const vp8xPayload = Buffer.alloc(10);
  vp8xPayload[0] = 0x02;
  vp8xPayload[4] = 1; // width 2 -> w-1 = 1
  vp8xPayload[7] = 1; // height 2 -> h-1 = 1
  const chunk = (tag: string, body: Buffer) => {
    const out = Buffer.alloc(8 + body.length + (body.length & 1));
    out.write(tag, 0, 'ascii');
    out.writeUInt32LE(body.length, 4);
    body.copy(out, 8);
    return out;
  };
  const fakeVp8l = Buffer.from([0x2f, 0x01, 0x00, 0x00, 0x00, 0x00]);
  const makeAnmf = () => {
    const body = Buffer.alloc(16 + 8 + fakeVp8l.length);
    body[6] = 1;
    body[9] = 1;
    body[12] = 83;
    body[15] = 2; // dispose replace
    chunk('VP8L', fakeVp8l).copy(body, 16);
    return chunk('ANMF', body);
  };
  const inner = Buffer.concat([chunk('VP8X', vp8xPayload), chunk('ANIM', Buffer.alloc(6)), makeAnmf(), makeAnmf()]);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + inner.length, 4);
  riff.write('WEBP', 8, 'ascii');
  const fullAnimatedWebp = Buffer.concat([riff, inner]);

  const manifest = await extractAnimatedWebpToFfconcat(fullAnimatedWebp, workDir);
  assert.ok(manifest);
  const manifestText = await fs.readFile(manifest!, 'utf8');
  assert.match(manifestText, /ffconcat version 1\.0/);
  assert.match(manifestText, /frame-0000\.webp/);
  assert.match(manifestText, /frame-0001\.webp/);
  assert.match(manifestText, /duration 0\.083/);
});
