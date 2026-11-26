export type DiagnosticLogLevel = 'info' | 'warn' | 'error';

export interface DiagnosticLogEntry {
  ts: string;
  level: DiagnosticLogLevel;
  scope: string;
  event: string;
  code?: string;
  detail?: string;
  meta?: Record<string, string | number | boolean | null>;
}

const MAX_LOGS = 150;
const logBuffer: DiagnosticLogEntry[] = [];

function sanitizeText(raw: string): string {
  return raw.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]').slice(0, 220);
}

function sanitizeValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return sanitizeText(String(value));
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
  }
  return String(error);
}

function record(
  level: DiagnosticLogLevel,
  scope: string,
  event: string,
  options: {
    code?: string;
    detail?: unknown;
    meta?: Record<string, unknown>;
  } = {},
): DiagnosticLogEntry {
  const cleanMeta: Record<string, string | number | boolean | null> | undefined = options.meta
    ? Object.fromEntries(Object.entries(options.meta).map(([k, v]) => [k, sanitizeValue(v)]))
    : undefined;

  const entry: DiagnosticLogEntry = {
    ts: new Date().toISOString(),
    level,
    scope,
    event,
    ...(options.code ? { code: options.code } : {}),
    ...(options.detail !== undefined
      ? { detail: sanitizeText(typeof options.detail === 'string' ? options.detail : describeError(options.detail)) }
      : {}),
    ...(cleanMeta && Object.keys(cleanMeta).length > 0 ? { meta: cleanMeta } : {}),
  };

  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.splice(0, logBuffer.length - MAX_LOGS);
  }

  if (typeof window !== 'undefined') {
    const tag = `[StickerWave:${scope}] ${event}${entry.code ? ` [${entry.code}]` : ''}`;
    const payload = { ...(entry.detail ? { detail: entry.detail } : {}), ...(entry.meta ? { meta: entry.meta } : {}) };
    if (level === 'error') console.error(tag, payload);
    else if (level === 'warn') console.warn(tag, payload);
    else console.info(tag, payload);
  }

  return entry;
}

export const logInfo = (
  scope: string,
  event: string,
  meta?: Record<string, unknown>,
  detail?: unknown,
) => record('info', scope, event, { meta, detail });

export const logWarn = (
  scope: string,
  event: string,
  options?: { code?: string; detail?: unknown; meta?: Record<string, unknown> },
) => record('warn', scope, event, options);

export const logError = (
  scope: string,
  event: string,
  options?: { code?: string; detail?: unknown; meta?: Record<string, unknown> },
) => record('error', scope, event, options);

export function getDiagnosticLogs(): readonly DiagnosticLogEntry[] {
  return [...logBuffer];
}

export function clearDiagnosticLogs(): void {
  logBuffer.length = 0;
}

export function formatDiagnosticLogsText(limit = 40): string {
  const slice = logBuffer.slice(-limit);
  return slice
    .map(entry => {
      const head = `${entry.ts} [${entry.level.toUpperCase()}] ${entry.scope}:${entry.event}`;
      const code = entry.code ? ` (${entry.code})` : '';
      const detail = entry.detail ? ` — ${entry.detail}` : '';
      const meta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : '';
      return `${head}${code}${detail}${meta}`;
    })
    .join('\n');
}
