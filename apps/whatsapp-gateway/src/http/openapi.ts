import type { GatewayConfig } from '../config.js';

export function buildOpenApiDocument(config: GatewayConfig) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'StickerWave WhatsApp Gateway API',
      version: '1.0.0',
      description:
        'Standalone multimedia processing & Baileys WhatsApp Sound Sticker delivery gateway for StickerWave.',
    },
    servers: [{ url: config.publicBaseUrl }],
    components: {
      securitySchemes: {
        AdminBearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'GATEWAY_ADMIN_SECRET protecting central bot WhatsApp administration endpoints.',
        },
      },
    },
    paths: {
      '/health': {
        get: { summary: 'Liveness probe', responses: { '200': { description: 'Gateway alive' } } },
      },
      '/ready': {
        get: {
          summary: 'Readiness probe checking FFmpeg, SQLite, SoundStickerProtocol, and bot connection',
          responses: { '200': { description: 'Ready' }, '503': { description: 'Not ready' } },
        },
      },
      '/api/v1/capabilities': {
        get: {
          summary: 'Declared Cloud Media & Gateway capabilities, encoders, and limits',
          responses: { '200': { description: 'Capabilities snapshot' } },
        },
      },
      '/api/v1/media/convert': {
        post: {
          summary: 'Cloud FFmpeg processing (WebP 512x512, Ogg/Opus, MP4 Sticker Card with sound, or .wastickers pack)',
          responses: { '200': { description: 'Rendered media binary' } },
        },
      },
      '/api/stickers/process': {
        post: {
          summary: 'Process composition via StickerWave Core (EXIF 0x5741, static/animated/sound validation)',
          responses: { '200': { description: 'EncodedSoundSticker JSON summary + validated WebP/Ogg base64' } },
        },
      },
      '/api/stickers/add-to-whatsapp': {
        post: {
          summary: 'Evaluate platform bridge (Android/iOS/Web/PWA) and optionally enqueue WhatsApp relay',
          responses: { '200': { description: 'AddToWhatsAppResponse with bridge strategy and pack manifest or relay job' } },
        },
      },
      '/api/v1/admin/whatsapp/status': {
        get: { security: [{ AdminBearer: [] }], summary: 'Central bot WhatsApp connection status' },
      },
      '/api/v1/admin/whatsapp/qr': {
        get: { security: [{ AdminBearer: [] }], summary: 'Current pairing QR PNG data URL (if waiting scan)' },
      },
      '/api/v1/admin/whatsapp/connect': {
        post: { security: [{ AdminBearer: [] }], summary: 'Initiate or resume central WhatsApp connection' },
      },
      '/api/v1/admin/whatsapp/reconnect': {
        post: { security: [{ AdminBearer: [] }], summary: 'Force reconnect central WhatsApp socket' },
      },
      '/api/v1/admin/whatsapp/disconnect': {
        post: { security: [{ AdminBearer: [] }], summary: 'Disconnect and optionally wipe persisted session' },
      },
      '/api/v1/admin/whatsapp/events': {
        get: { security: [{ AdminBearer: [] }], summary: 'SSE stream of WhatsApp QR and state transitions' },
      },
      '/api/v1/admin/metrics': {
        get: { security: [{ AdminBearer: [] }], summary: 'Queue counters, latency metrics, authorized recipient total' },
      },
      '/api/v1/admin/jobs': {
        get: { security: [{ AdminBearer: [] }], summary: 'Recent masked sticker jobs queue and operational history' },
      },
      '/api/v1/phones/validate': {
        post: { summary: 'Normalize & validate recipient phone number using libphonenumber-js E.164' },
      },
      '/api/v1/recipients/authorization-request': {
        post: { summary: 'Issue opt-in confirmation challenge & wa.me link for recipient number' },
      },
      '/api/v1/recipients/authorization-status': {
        get: { summary: 'Check recipient opt-in authorization state' },
      },
      '/api/v1/recipients/authorization-confirm': {
        post: { summary: 'Confirm recipient authorization challenge with phone + code' },
      },
      '/api/v1/stickers/send': {
        post: {
          summary: 'Enqueue sound sticker build & WhatsApp delivery job (multipart/form-data)',
          parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
        },
      },
      '/api/v1/stickers/jobs/{jobId}': {
        get: { summary: 'Poll sound sticker job state' },
      },
      '/api/v1/stickers/jobs/{jobId}/events': {
        get: { summary: 'SSE live stream of sticker job processing & delivery progress' },
      },
      '/api/v1/stickers/jobs/{jobId}/cancel': {
        post: { summary: 'Cancel queued/processing job prior to upload/send' },
      },
    },
  };
}
