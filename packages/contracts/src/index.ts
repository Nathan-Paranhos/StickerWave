/**
 * Shared API & Domain contracts between StickerWave frontend and StickerWave WhatsApp Gateway.
 * Pure TypeScript + runtime constants (compatible with Vite browser bundle and Node 24+).
 */

export const WHATSAPP_CONNECTION_STATUSES = [
  'DISCONNECTED',
  'CONNECTING',
  'WAITING_QR',
  'CONNECTED',
  'RECONNECTING',
  'LOGGED_OUT',
  'ERROR',
] as const;

export type WhatsAppConnectionStatus = (typeof WHATSAPP_CONNECTION_STATUSES)[number];

export const STICKER_JOB_STATUSES = [
  'QUEUED',
  'VALIDATING',
  'PROCESSING_VISUAL',
  'PROCESSING_AUDIO',
  'ENCODING',
  'UPLOADING',
  'SENDING',
  'SENT',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
  'UNKNOWN',
] as const;

export type StickerJobStatus = (typeof STICKER_JOB_STATUSES)[number];

export const TERMINAL_JOB_STATUSES: ReadonlySet<StickerJobStatus> = new Set([
  'SENT',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
  'UNKNOWN',
]);

export const GATEWAY_ERROR_CODES = {
  UNAUTHORIZED_ADMIN: 'GW-4010',
  FORBIDDEN_ORIGIN: 'GW-4030',
  RECIPIENT_NOT_AUTHORIZED: 'GW-4031',
  INVALID_PHONE: 'GW-4001',
  INVALID_MEDIA: 'GW-4002',
  INVALID_COMPOSITION: 'GW-4003',
  MEDIA_TOO_LARGE: 'GW-4130',
  DURATION_EXCEEDED: 'GW-4220',
  AUDIO_EXTRACTION_FAILED: 'GW-4221',
  FFMPEG_FAILED: 'GW-5001',
  PROTOCOL_UNSUPPORTED: 'GW-5010',
  WHATSAPP_NOT_CONNECTED: 'GW-5030',
  SOUND_STICKERS_DISABLED: 'GW-5031',
  RATE_LIMITED: 'GW-4290',
  JOB_NOT_FOUND: 'GW-4040',
  JOB_NOT_CANCELLABLE: 'GW-4090',
  TIMEOUT: 'GW-5040',
} as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[keyof typeof GATEWAY_ERROR_CODES];

/**
 * Official WhatsApp sticker limits vs StickerWave experimental sound-sticker limits.
 * Keeping both explicit avoids conflating third-party sticker pack rules with community
 * embedded-audio sound sticker capabilities (see docs/protocol/sound-stickers.md).
 */
export const STICKER_LIMITS_PROFILE = {
  official: {
    canvasSizePx: 512,
    staticMaxBytes: 100 * 1024,
    animatedMaxBytes: 500 * 1024,
    animatedMaxDurationMs: 10_000,
    animatedMinFrameDurationMs: 8,
    trayIconSizePx: 96,
    trayIconMaxBytes: 50 * 1024,
  },
  experimentalSoundSticker: {
    canvasSizePx: 512,
    defaultDurationMs: 5_000,
    maxDurationMs: 10_000,
    gatewayHardMaxDurationMs: 25_000,
    maxAnimatedWebpBytes: 500 * 1024,
    maxStaticWebpBytes: 100 * 1024,
    maxAudioBytes: 512 * 1024,
    audioSampleRateHz: 48_000,
    audioChannels: 1,
    defaultAudioKbps: 32,
    audioLeadMs: 100,
    maxFrames: 240,
    maxVisualUploadBytes: 25 * 1024 * 1024,
    maxAudioUploadBytes: 20 * 1024 * 1024,
  },
} as const;

export interface GatewayErrorEnvelope {
  ok: false;
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface WhatsAppConnectionSnapshot {
  status: WhatsAppConnectionStatus;
  connectedPhoneMasked: string | null;
  connectedPushName: string | null;
  botWaMePhone: string | null;
  qrCodeDataUrl: string | null;
  qrExpiresAt: string | null;
  qrGeneration: number;
  lastError: string | null;
  lastErrorCode: string | null;
  reconnectAttempts: number;
  sessionPersisted: boolean;
  connectedAt: string | null;
  updatedAt: string;
}

export type WhatsAppConnectionEvent =
  | { type: 'snapshot'; snapshot: WhatsAppConnectionSnapshot; timestamp: string }
  | { type: 'qr'; qrCodeDataUrl: string; qrExpiresAt: string; qrGeneration: number; timestamp: string }
  | { type: 'status'; status: WhatsAppConnectionStatus; reason?: string; timestamp: string }
  | { type: 'error'; code: string; message: string; timestamp: string };

export interface StickerShapeOptions {
  shape: 'square' | 'rounded' | 'circle';
  borderWhite: boolean;
  background: string | null;
}

export interface StickerAudioOptions {
  trimStartMs?: number;
  trimEndMs?: number;
  timelineOffsetMs?: number;
  volume?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  normalizePeak?: boolean;
  useVideoAudioFallback?: boolean;
  targetDurationMs?: number;
}

export interface StickerSendJobSummary {
  id: string;
  status: StickerJobStatus;
  progress: number;
  stageLabel: string;
  recipientMasked: string;
  recipientE164Hash?: string;
  soundStickersEnabled: boolean;
  stickerAnimated: boolean;
  durationMs: number | null;
  webpBytes: number | null;
  oggBytes: number | null;
  waMessageId: string | null;
  deliveryAckStatus: 'none' | 'server' | 'device' | 'read';
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface StickerJobEvent {
  type: 'job';
  job: StickerSendJobSummary;
  timestamp: string;
}

export interface PhoneValidationResult {
  valid: boolean;
  e164: string | null;
  masked: string | null;
  countryCode: string | null;
  nationalNumber: string | null;
  reason?: string;
}

export interface RecipientAuthorizationChallenge {
  challengeId: string;
  recipientMasked: string;
  e164: string;
  code: string;
  expiresAt: string;
  authorized: boolean;
  botNumberConfigured: boolean;
  waMeUrl: string | null;
  prefilledMessage: string;
  instructions: string;
}

export interface RecipientAuthorizationStatusResponse {
  e164: string;
  masked: string;
  authorized: boolean;
  authorizedAt: string | null;
  pendingChallengeCode: string | null;
  pendingExpiresAt: string | null;
  waMeUrl: string | null;
  prefilledMessage: string | null;
}

export interface GatewayMetricsSnapshot {
  uptimeSec: number;
  totalJobs: number;
  queuedJobs: number;
  processingJobs: number;
  sentJobs: number;
  deliveredJobs: number;
  failedJobs: number;
  cancelledJobs: number;
  unknownJobs: number;
  authorizedRecipients: number;
  averageProcessingMs: number | null;
}

export const CLOUD_MEDIA_FORMATS = ['webp', 'opus', 'mp4', 'wastickers'] as const;
export type CloudMediaFormat = (typeof CLOUD_MEDIA_FORMATS)[number];

export interface GatewayCapabilitiesResponse {
  cloudMediaEnabled?: boolean;
  cloudFormats?: CloudMediaFormat[];
  whatsappBotEnabled?: boolean;
  soundStickersEnabled: boolean;
  ffmpegVersion: string | null;
  encoders: {
    libwebp: boolean;
    libopus: boolean;
    libx264?: boolean;
  };
  baileysVersion: string;
  protocolField26Supported: boolean;
  protocolMode: 'native' | 'patched-encoder' | 'unsupported';
  limits: typeof STICKER_LIMITS_PROFILE;
  maxParallelJobs: number;
}

export interface GatewayHealthResponse {
  ok: boolean;
  service: 'stickerwave-whatsapp-gateway';
  version: string;
  timestamp: string;
  uptimeSec: number;
}

export interface GatewayReadyResponse {
  ready: boolean;
  ffmpegReady: boolean;
  sqliteReady: boolean;
  protocolReady: boolean;
  whatsappBotEnabled?: boolean;
  whatsappConnected: boolean;
  whatsappStatus: WhatsAppConnectionStatus;
  soundStickersEnabled: boolean;
  reasons: string[];
}
