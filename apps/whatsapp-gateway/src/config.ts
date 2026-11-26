import fs from 'node:fs';
import path from 'node:path';

export interface GatewayConfig {
  nodeEnv: string;
  host: string;
  port: number;
  publicBaseUrl: string;
  allowedOrigins: string[];
  enableSoundStickers: boolean;
  enableWaBot: boolean;
  adminSecret: string;
  publicToken: string;
  sessionSecret: string;
  dataDir: string;
  sessionDir: string;
  dbPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  maxSeconds: number;
  hardMaxSeconds: number;
  maxFrames: number;
  maxStickerBytes: number;
  maxStaticStickerBytes: number;
  maxAudioBytes: number;
  maxVisualUploadBytes: number;
  maxAudioUploadBytes: number;
  audioKbps: number;
  audioLeadMs: number;
  maxParallelJobs: number;
  jobTimeoutMs: number;
  tmpRetentionCheckMs: number;
  botDisplayName: string;
  waBotPhoneHint: string;
  authorizationCodeTtlSec: number;
  autoAuthorizeDevNumbers: Set<string>;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  rateLimitSendPerPhonePerHour: number;
  logLevel: string;
  debugProtocol: boolean;
  verifyUpload: boolean;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

export function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

export function parseNumber(
  raw: string | undefined,
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const { min = -Infinity, max = Infinity } = bounds;
  const value = raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
  const resolved = Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, resolved));
}

export function loadEnvFileIfPresent(filePath = path.resolve(process.cwd(), '.env')): boolean {
  if (!fs.existsSync(filePath)) return false;
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(filePath);
    return true;
  }
  return false;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): GatewayConfig {
  const dataDir = path.resolve(cwd, env.DATA_DIR || './data');
  const sessionDir = path.resolve(cwd, env.SESSION_DIR || path.join(dataDir, 'session'));
  const dbPath = path.resolve(cwd, env.DB_PATH || path.join(dataDir, 'gateway.db'));
  const allowedOriginsRaw =
    env.ALLOWED_ORIGINS ||
    'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173,https://stickerwave.netlify.app';
  const autoNumbers = new Set(
    (env.AUTO_AUTHORIZE_DEV_NUMBERS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('+')),
  );

  return Object.freeze({
    nodeEnv: env.NODE_ENV || 'development',
    host: env.HOST || '127.0.0.1',
    port: parseNumber(env.PORT, 3001, { min: 0, max: 65535 }),
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://127.0.0.1:${env.PORT || 3001}`).replace(/\/+$/, ''),
    allowedOrigins: allowedOriginsRaw
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    enableSoundStickers: parseFlag(env.ENABLE_SOUND_STICKERS, true),
    enableWaBot: parseFlag(env.ENABLE_WA_BOT, false),
    adminSecret: env.GATEWAY_ADMIN_SECRET || 'dev-admin-secret-change-in-prod',
    publicToken: (env.GATEWAY_PUBLIC_TOKEN || '').trim(),
    sessionSecret: env.GATEWAY_SESSION_SECRET || 'dev-session-secret-change-in-prod-32b',
    dataDir,
    sessionDir,
    dbPath,
    ffmpegPath: (env.FFMPEG_PATH || '').trim(),
    ffprobePath: (env.FFPROBE_PATH || '').trim(),
    maxSeconds: parseNumber(env.MAX_SECONDS, 10, { min: 1, max: 30 }),
    hardMaxSeconds: parseNumber(env.HARD_MAX_SECONDS, 25, { min: 1, max: 60 }),
    maxFrames: parseNumber(env.MAX_FRAMES, 240, { min: 2, max: 1000 }),
    maxStickerBytes: parseNumber(env.MAX_STICKER_BYTES, 500 * 1024, { min: 50_000, max: 1_500_000 }),
    maxStaticStickerBytes: parseNumber(env.MAX_STATIC_STICKER_BYTES, 100 * 1024, { min: 20_000, max: 500_000 }),
    maxAudioBytes: parseNumber(env.MAX_AUDIO_BYTES, 512 * 1024, { min: 16_384, max: 2_000_000 }),
    maxVisualUploadBytes: parseNumber(env.MAX_VISUAL_UPLOAD_BYTES, 25 * 1024 * 1024, { min: 1024, max: 100 * 1024 * 1024 }),
    maxAudioUploadBytes: parseNumber(env.MAX_AUDIO_UPLOAD_BYTES, 20 * 1024 * 1024, { min: 1024, max: 50 * 1024 * 1024 }),
    audioKbps: parseNumber(env.AUDIO_KBPS, 32, { min: 12, max: 96 }),
    audioLeadMs: parseNumber(env.AUDIO_LEAD_MS, 100, { min: 0, max: 2000 }),
    maxParallelJobs: parseNumber(env.MAX_PARALLEL_JOBS, 2, { min: 1, max: 8 }),
    jobTimeoutMs: parseNumber(env.JOB_TIMEOUT_MS, 90_000, { min: 5_000, max: 300_000 }),
    tmpRetentionCheckMs: parseNumber(env.TMP_RETENTION_CHECK_MS, 300_000, { min: 10_000, max: 3_600_000 }),
    botDisplayName: env.BOT_DISPLAY_NAME || 'StickerWave Bot',
    waBotPhoneHint: (env.WA_BOT_PHONE_HINT || '').replace(/\D/g, ''),
    authorizationCodeTtlSec: parseNumber(env.AUTHORIZATION_CODE_TTL_SEC, 900, { min: 60, max: 86_400 }),
    autoAuthorizeDevNumbers: autoNumbers,
    rateLimitWindowMs: parseNumber(env.RATE_LIMIT_WINDOW_MS, 60_000, { min: 1_000, max: 3_600_000 }),
    rateLimitMaxRequests: parseNumber(env.RATE_LIMIT_MAX_REQUESTS, 60, { min: 5, max: 5_000 }),
    rateLimitSendPerPhonePerHour: parseNumber(env.RATE_LIMIT_SEND_PER_PHONE_PER_HOUR, 12, { min: 1, max: 500 }),
    logLevel: env.LOG_LEVEL || 'info',
    debugProtocol: parseFlag(env.DEBUG_PROTOCOL, false),
    verifyUpload: parseFlag(env.VERIFY_UPLOAD, false),
  });
}
