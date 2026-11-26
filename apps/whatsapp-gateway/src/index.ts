import { loadConfig, loadEnvFileIfPresent } from './config.js';
import { createGatewayRuntime } from './http/server.js';

loadEnvFileIfPresent();

const runtime = createGatewayRuntime(loadConfig());

async function main() {
  const { host, port } = await runtime.start();
  const ff = await runtime.ffmpeg.checkCapabilities();
  if (!ff.ready) {
    runtime.logger.warn('FFmpeg/FFprobe missing or lacks libwebp/libopus at startup.', {
      error: ff.error,
    });
  } else {
    runtime.logger.info('FFmpeg/FFprobe ready.', {
      ffmpegVersion: ff.versionLine,
      protocolMode: runtime.protocol.capability.mode,
      url: `http://${host}:${port}`,
    });
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    runtime.logger.info(`Received ${signal}, shutting down WhatsApp Gateway gracefully.`);
    void runtime.stop().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('Fatal error starting StickerWave WhatsApp Gateway:', err);
  process.exit(1);
});
