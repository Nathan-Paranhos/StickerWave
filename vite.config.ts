import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const gatewayTarget = process.env.GATEWAY_URL || 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@stickerwave/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4173',
      '/gateway': {
        target: gatewayTarget,
        changeOrigin: true,
        rewrite: path => path.replace(/^\/gateway/, ''),
      },
    },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', assetsInlineLimit: 0 },
});
