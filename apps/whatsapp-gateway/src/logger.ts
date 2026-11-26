import pino from 'pino';
import { sanitizeLogString } from './utils/mask.js';

export interface GatewayLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): GatewayLogger;
}

const SENSITIVE_KEY_PATTERN = /(secret|token|password|apikey|api_key|mediakey|key|qr|auth|cookie|phone|e164|jid)/i;

function sanitizeMeta(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[max-depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeLogString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: sanitizeLogString(value.message) };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeMeta(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k) && !k.endsWith('Masked') && !k.endsWith('Hash') && k !== 'qrGeneration') {
        out[k] = typeof v === 'string' && v.startsWith('+') ? sanitizeLogString(v) : '<redacted>';
      } else {
        out[k] = sanitizeMeta(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export function createLogger(level = 'info', bindings: Record<string, unknown> = {}): GatewayLogger {
  const base = pino({
    level,
    base: { service: 'stickerwave-whatsapp-gateway', ...bindings },
    redact: {
      paths: ['secret', 'token', 'adminSecret', 'sessionSecret', 'qrCodeDataUrl', 'mediaKey'],
      censor: '<redacted>',
    },
  });

  const wrap = (logger: pino.Logger): GatewayLogger => ({
    info: (msg, meta) => logger.info(meta ? (sanitizeMeta(meta) as object) : {}, sanitizeLogString(msg)),
    warn: (msg, meta) => logger.warn(meta ? (sanitizeMeta(meta) as object) : {}, sanitizeLogString(msg)),
    error: (msg, meta) => logger.error(meta ? (sanitizeMeta(meta) as object) : {}, sanitizeLogString(msg)),
    debug: (msg, meta) => logger.debug(meta ? (sanitizeMeta(meta) as object) : {}, sanitizeLogString(msg)),
    child: (extra) => wrap(logger.child(sanitizeMeta(extra) as object)),
  });

  return wrap(base);
}
