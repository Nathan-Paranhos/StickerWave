import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { proto } from '@whiskeysockets/baileys';
import { loadConfig } from './config.js';
import { CompositionPipeline } from './media/composition-pipeline.js';
import { FFmpegAdapter } from './media/ffmpeg-adapter.js';
import { SoundStickerProtocol } from './whatsapp/sound-sticker-protocol.js';

/**
 * Phase 2 PoC script:
 * Verifies real FFmpeg (libwebp + libopus), processes synthetic image & audio fixtures
 * into 512x512 WebP + 48kHz mono Ogg/Opus + 64-bar waveform, then validates Baileys
 * protobuf serialization with field 26 (AudioMessage) embedded inside StickerMessage.
 */
async function main() {
  const config = loadConfig();
  const ffmpeg = new FFmpegAdapter({ ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath });
  const caps = await ffmpeg.checkCapabilities();
  console.log('[PoC] FFmpeg capabilities:', JSON.stringify(caps));
  if (!caps.ready) {
    throw new Error(`FFmpeg PoC prerequisite failed: ${caps.error}`);
  }

  const protocol = new SoundStickerProtocol('7.0.0-rc14');
  console.log('[PoC] SoundStickerProtocol capability:', JSON.stringify(protocol.capability));

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-poc-'));
  try {
    const pngPath = path.join(tempDir, 'input.png');
    const wavPath = path.join(tempDir, 'input.wav');

    // Generate valid 300x300 RGBA test image and 1.2s 440Hz sine WAV via FFmpeg
    await ffmpeg.run([
      '-f', 'lavfi', '-i', 'color=c=#C9F45A@0.9:s=300x300,format=rgba', '-vframes', '1', pngPath,
    ]);
    await ffmpeg.run([
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wavPath,
    ]);

    const pipeline = new CompositionPipeline(ffmpeg, config);
    const result = await pipeline.process({
      visualBytes: await fs.readFile(pngPath),
      audioBytes: await fs.readFile(wavPath),
      shapeOptions: { shape: 'rounded', borderWhite: true, background: null },
      audioOptions: { normalizePeak: true },
    });

    console.log('[PoC] Processed WebP:', {
      bytes: result.webpBuffer.byteLength,
      width: result.visualInspection.width,
      height: result.visualInspection.height,
      hasAlpha: result.visualInspection.hasAlpha,
      animated: result.isAnimated,
    });
    console.log('[PoC] Processed Audio:', {
      bytes: result.oggBuffer.byteLength,
      durationSec: Number(result.durationSec.toFixed(3)),
      secondsField: result.secondsField,
      waveformBars: result.waveform.byteLength,
      waveformMax: Math.max(...result.waveform),
      codec: result.audioStats.codec,
      sampleRate: result.audioStats.sampleRate,
    });

    const stickerSha = crypto.createHash('sha256').update(result.webpBuffer).digest();
    const audioSha = crypto.createHash('sha256').update(result.oggBuffer).digest();
    const { encoded, verification } = protocol.serializeAndVerifySynthetic({
      sticker: {
        url: 'https://mmg.whatsapp.net/o1/v/t62.15575-24/poc-sticker',
        fileSha256: stickerSha,
        fileEncSha256: crypto.randomBytes(32),
        mediaKey: crypto.randomBytes(32),
        directPath: '/o1/v/t62.15575-24/poc-sticker',
        mimetype: 'image/webp',
        fileLength: result.webpBuffer.byteLength,
        width: 512,
        height: 512,
        isAnimated: result.isAnimated,
      },
      audio: {
        url: 'https://mmg.whatsapp.net/o1/v/t62.7118-24/poc-audio',
        fileSha256: audioSha,
        fileEncSha256: crypto.randomBytes(32),
        mediaKey: crypto.randomBytes(32),
        directPath: '/o1/v/t62.7118-24/poc-audio',
        mimetype: 'audio/ogg; codecs=opus',
        fileLength: result.oggBuffer.byteLength,
        seconds: result.secondsField,
        ptt: true,
        waveform: result.waveform,
      },
      seconds: result.secondsField,
      waveform: result.waveform,
    });

    const decodedOuter = proto.Message.decode(encoded);
    console.log('[PoC] Protobuf round-trip:', {
      outerMessageBytes: encoded.byteLength,
      hasOuterSticker: Boolean(decodedOuter.stickerMessage),
      embeddedAudioValid: verification.valid,
      embeddedAudioBytes: verification.embeddedAudioBytes,
      embeddedSeconds: verification.decodedAudio?.seconds,
    });

    if (!verification.valid) {
      throw new Error(`PoC protobuf check failed: ${verification.reason}`);
    }
    console.log('[PoC] SUCCESS: Media pipeline + SoundStickerProtocol field #26 verified.');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[PoC] FAILED:', err);
  process.exit(1);
});
