import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  GatewayMetricsSnapshot,
  StickerJobStatus,
  StickerSendJobSummary,
} from '@stickerwave/contracts';
import { maskPhone } from '../utils/mask.js';

export interface StoredJobRow {
  id: string;
  idempotency_key: string | null;
  status: StickerJobStatus;
  progress: number;
  stage_label: string;
  recipient_masked: string;
  recipient_e164_hash: string;
  sound_stickers_enabled: number;
  sticker_animated: number;
  duration_ms: number | null;
  webp_bytes: number | null;
  ogg_bytes: number | null;
  wa_message_id: string | null;
  delivery_ack_status: 'none' | 'server' | 'device' | 'read';
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  processing_ms: number | null;
}

export interface AuthorizationRecord {
  e164_hash: string;
  e164_masked: string;
  authorized: number;
  authorized_at: string | null;
  pending_challenge_id: string | null;
  pending_code: string | null;
  pending_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export function hashRecipientE164(e164: string): string {
  return crypto.createHash('sha256').update(e164.trim()).digest('hex');
}

function rowToJobSummary(row: StoredJobRow): StickerSendJobSummary {
  return {
    id: row.id,
    status: row.status,
    progress: row.progress,
    stageLabel: row.stage_label,
    recipientMasked: row.recipient_masked,
    recipientE164Hash: row.recipient_e164_hash.slice(0, 16),
    soundStickersEnabled: Boolean(row.sound_stickers_enabled),
    stickerAnimated: Boolean(row.sticker_animated),
    durationMs: row.duration_ms,
    webpBytes: row.webp_bytes,
    oggBytes: row.ogg_bytes,
    waMessageId: row.wa_message_id,
    deliveryAckStatus: row.delivery_ack_status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export class GatewayDatabase {
  private readonly db: DatabaseSync;

  constructor(public readonly dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS sticker_jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        stage_label TEXT NOT NULL DEFAULT '',
        recipient_masked TEXT NOT NULL,
        recipient_e164_hash TEXT NOT NULL,
        sound_stickers_enabled INTEGER NOT NULL DEFAULT 1,
        sticker_animated INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        webp_bytes INTEGER,
        ogg_bytes INTEGER,
        wa_message_id TEXT,
        delivery_ack_status TEXT NOT NULL DEFAULT 'none',
        error_code TEXT,
        error_message TEXT,
        processing_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON sticker_jobs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_wa_msg_id ON sticker_jobs(wa_message_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON sticker_jobs(status);

      CREATE TABLE IF NOT EXISTS recipient_authorizations (
        e164_hash TEXT PRIMARY KEY,
        e164_masked TEXT NOT NULL,
        authorized INTEGER NOT NULL DEFAULT 0,
        authorized_at TEXT,
        pending_challenge_id TEXT,
        pending_code TEXT,
        pending_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auth_code ON recipient_authorizations(pending_code);

      CREATE TABLE IF NOT EXISTS send_rate_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient_e164_hash TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rate_phone_time ON send_rate_events(recipient_e164_hash, created_at_ms);

      CREATE TABLE IF NOT EXISTS gateway_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        target_masked TEXT,
        code TEXT,
        details_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  ping(): boolean {
    const row = this.db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    return row?.ok === 1;
  }

  /**
   * Startup crash recovery:
   * - Jobs interrupted in UPLOADING/SENDING transition to UNKNOWN (never re-sent blindly).
   * - Jobs interrupted earlier (QUEUED/PROCESSING_*) become FAILED so callers can retry safely.
   */
  recoverInterruptedJobs(): { markedUnknown: number; markedFailed: number } {
    const now = new Date().toISOString();
    const resUnknown = this.db
      .prepare(
        `UPDATE sticker_jobs
         SET status = 'UNKNOWN',
             stage_label = 'Gateway reiniciado durante transmissão; reenvio automático bloqueado para evitar duplicidade',
             error_code = 'GW-5002',
             error_message = 'Status indeterminado após reinício durante upload/envio.',
             updated_at = ?,
             completed_at = ?
         WHERE status IN ('UPLOADING', 'SENDING')`,
      )
      .run(now, now);

    const resFailed = this.db
      .prepare(
        `UPDATE sticker_jobs
         SET status = 'FAILED',
             stage_label = 'Interrompido antes do envio devido ao reinício do serviço',
             error_code = 'GW-5003',
             error_message = 'Job interrompido durante processamento local. Envie novamente.',
             updated_at = ?,
             completed_at = ?
         WHERE status IN ('QUEUED', 'VALIDATING', 'PROCESSING_VISUAL', 'PROCESSING_AUDIO', 'ENCODING')`,
      )
      .run(now, now);

    return {
      markedUnknown: Number(resUnknown.changes || 0),
      markedFailed: Number(resFailed.changes || 0),
    };
  }

  createJob(input: {
    id: string;
    idempotencyKey?: string | null;
    recipientE164: string;
    soundStickersEnabled: boolean;
  }): StickerSendJobSummary {
    const now = new Date().toISOString();
    const e164Hash = hashRecipientE164(input.recipientE164);
    const masked = maskPhone(input.recipientE164);

    this.db
      .prepare(
        `INSERT INTO sticker_jobs (
          id, idempotency_key, status, progress, stage_label,
          recipient_masked, recipient_e164_hash, sound_stickers_enabled,
          created_at, updated_at
        ) VALUES (?, ?, 'QUEUED', 5, 'Na fila de processamento', ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.idempotencyKey ?? null, masked, e164Hash, input.soundStickersEnabled ? 1 : 0, now, now);

    return this.getJobById(input.id)!;
  }

  getJobById(id: string): StickerSendJobSummary | null {
    const row = this.db.prepare('SELECT * FROM sticker_jobs WHERE id = ?').get(id) as StoredJobRow | undefined;
    return row ? rowToJobSummary(row) : null;
  }

  getJobByIdempotencyKey(key: string): StickerSendJobSummary | null {
    const row = this.db.prepare('SELECT * FROM sticker_jobs WHERE idempotency_key = ?').get(key) as
      | StoredJobRow
      | undefined;
    return row ? rowToJobSummary(row) : null;
  }

  getJobByWaMessageId(waMessageId: string): StickerSendJobSummary | null {
    const row = this.db.prepare('SELECT * FROM sticker_jobs WHERE wa_message_id = ?').get(waMessageId) as
      | StoredJobRow
      | undefined;
    return row ? rowToJobSummary(row) : null;
  }

  listRecentJobs(limit = 30): StickerSendJobSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM sticker_jobs ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit))) as unknown as StoredJobRow[];
    return rows.map(rowToJobSummary);
  }

  updateJob(
    id: string,
    patch: Partial<{
      status: StickerJobStatus;
      progress: number;
      stageLabel: string;
      stickerAnimated: boolean;
      durationMs: number | null;
      webpBytes: number | null;
      oggBytes: number | null;
      waMessageId: string | null;
      deliveryAckStatus: 'none' | 'server' | 'device' | 'read';
      errorCode: string | null;
      errorMessage: string | null;
      processingMs: number | null;
      completedAt: string | null;
    }>,
  ): StickerSendJobSummary | null {
    const current = this.db.prepare('SELECT * FROM sticker_jobs WHERE id = ?').get(id) as StoredJobRow | undefined;
    if (!current) return null;

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sticker_jobs SET
          status = ?,
          progress = ?,
          stage_label = ?,
          sticker_animated = ?,
          duration_ms = ?,
          webp_bytes = ?,
          ogg_bytes = ?,
          wa_message_id = ?,
          delivery_ack_status = ?,
          error_code = ?,
          error_message = ?,
          processing_ms = ?,
          updated_at = ?,
          completed_at = ?
        WHERE id = ?`,
      )
      .run(
        patch.status ?? current.status,
        patch.progress ?? current.progress,
        patch.stageLabel ?? current.stage_label,
        patch.stickerAnimated !== undefined ? (patch.stickerAnimated ? 1 : 0) : current.sticker_animated,
        patch.durationMs !== undefined ? patch.durationMs : current.duration_ms,
        patch.webpBytes !== undefined ? patch.webpBytes : current.webp_bytes,
        patch.oggBytes !== undefined ? patch.oggBytes : current.ogg_bytes,
        patch.waMessageId !== undefined ? patch.waMessageId : current.wa_message_id,
        patch.deliveryAckStatus ?? current.delivery_ack_status,
        patch.errorCode !== undefined ? patch.errorCode : current.error_code,
        patch.errorMessage !== undefined ? patch.errorMessage : current.error_message,
        patch.processingMs !== undefined ? patch.processingMs : current.processing_ms,
        now,
        patch.completedAt !== undefined ? patch.completedAt : current.completed_at,
        id,
      );

    return this.getJobById(id);
  }

  getAuthorizationByE164(e164: string): AuthorizationRecord | null {
    const hash = hashRecipientE164(e164);
    const row = this.db
      .prepare('SELECT * FROM recipient_authorizations WHERE e164_hash = ?')
      .get(hash) as AuthorizationRecord | undefined;
    return row ?? null;
  }

  upsertAuthorizationChallenge(input: {
    e164: string;
    challengeId: string;
    code: string;
    expiresAt: string;
  }): AuthorizationRecord {
    const hash = hashRecipientE164(input.e164);
    const masked = maskPhone(input.e164);
    const now = new Date().toISOString();
    const existing = this.getAuthorizationByE164(input.e164);

    if (existing) {
      this.db
        .prepare(
          `UPDATE recipient_authorizations
           SET pending_challenge_id = ?, pending_code = ?, pending_expires_at = ?, updated_at = ?
           WHERE e164_hash = ?`,
        )
        .run(input.challengeId, input.code, input.expiresAt, now, hash);
    } else {
      this.db
        .prepare(
          `INSERT INTO recipient_authorizations (
            e164_hash, e164_masked, authorized, pending_challenge_id, pending_code, pending_expires_at, created_at, updated_at
          ) VALUES (?, ?, 0, ?, ?, ?, ?, ?)`,
        )
        .run(hash, masked, input.challengeId, input.code, input.expiresAt, now, now);
    }

    return this.getAuthorizationByE164(input.e164)!;
  }

  markRecipientAuthorizedByE164(e164: string): AuthorizationRecord {
    const hash = hashRecipientE164(e164);
    const masked = maskPhone(e164);
    const now = new Date().toISOString();
    const existing = this.getAuthorizationByE164(e164);
    if (existing) {
      this.db
        .prepare(
          `UPDATE recipient_authorizations
           SET authorized = 1, authorized_at = ?, pending_code = NULL, pending_expires_at = NULL, updated_at = ?
           WHERE e164_hash = ?`,
        )
        .run(now, now, hash);
    } else {
      this.db
        .prepare(
          `INSERT INTO recipient_authorizations (
            e164_hash, e164_masked, authorized, authorized_at, created_at, updated_at
          ) VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(hash, masked, now, now, now);
    }
    return this.getAuthorizationByE164(e164)!;
  }

  findPendingChallengeByCode(code: string): AuthorizationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM recipient_authorizations WHERE pending_code = ?')
      .get(code.trim().toUpperCase()) as AuthorizationRecord | undefined;
    return row ?? null;
  }

  confirmChallengeByCode(code: string, matchedE164Hash?: string): AuthorizationRecord | null {
    const found = this.findPendingChallengeByCode(code);
    if (!found) return null;
    if (matchedE164Hash && found.e164_hash !== matchedE164Hash) {
      return null;
    }
    if (found.pending_expires_at && new Date(found.pending_expires_at).getTime() < Date.now()) {
      return null;
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE recipient_authorizations
         SET authorized = 1, authorized_at = ?, pending_code = NULL, pending_expires_at = NULL, updated_at = ?
         WHERE e164_hash = ?`,
      )
      .run(now, now, found.e164_hash);
    return this.db
      .prepare('SELECT * FROM recipient_authorizations WHERE e164_hash = ?')
      .get(found.e164_hash) as unknown as AuthorizationRecord;
  }

  revokeRecipientAuthorization(e164: string): boolean {
    const hash = hashRecipientE164(e164);
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE recipient_authorizations
         SET authorized = 0, authorized_at = NULL, pending_code = NULL, pending_expires_at = NULL, updated_at = ?
         WHERE e164_hash = ?`,
      )
      .run(now, hash);
    return Number(res.changes || 0) > 0;
  }

  countAndRecordPhoneSendAttempt(e164: string, maxPerHour: number): { allowed: boolean; countLastHour: number } {
    const hash = hashRecipientE164(e164);
    const nowMs = Date.now();
    const cutoffMs = nowMs - 3_600_000;
    this.db.prepare('DELETE FROM send_rate_events WHERE created_at_ms < ?').run(cutoffMs);
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM send_rate_events WHERE recipient_e164_hash = ? AND created_at_ms >= ?')
      .get(hash, cutoffMs) as { cnt: number };
    const current = Number(row.cnt || 0);
    if (current >= maxPerHour) {
      return { allowed: false, countLastHour: current };
    }
    this.db
      .prepare('INSERT INTO send_rate_events (recipient_e164_hash, created_at_ms) VALUES (?, ?)')
      .run(hash, nowMs);
    return { allowed: true, countLastHour: current + 1 };
  }

  recordAuditEvent(eventType: string, targetMasked: string | null, code: string | null, details?: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO gateway_audit_events (event_type, target_masked, code, details_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(eventType, targetMasked, code, details ? JSON.stringify(details) : null, new Date().toISOString());
  }

  getMetrics(uptimeSec: number): GatewayMetricsSnapshot {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS cnt FROM sticker_jobs GROUP BY status')
      .all() as Array<{ status: StickerJobStatus; cnt: number }>;
    const counts = new Map<StickerJobStatus, number>();
    let total = 0;
    for (const r of rows) {
      counts.set(r.status, Number(r.cnt));
      total += Number(r.cnt);
    }

    const avgRow = this.db
      .prepare('SELECT AVG(processing_ms) AS avg_ms FROM sticker_jobs WHERE processing_ms IS NOT NULL')
      .get() as { avg_ms: number | null };

    const authRow = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM recipient_authorizations WHERE authorized = 1')
      .get() as { cnt: number };

    const processingJobs =
      (counts.get('PROCESSING_VISUAL') ?? 0) +
      (counts.get('PROCESSING_AUDIO') ?? 0) +
      (counts.get('ENCODING') ?? 0) +
      (counts.get('UPLOADING') ?? 0) +
      (counts.get('SENDING') ?? 0);

    return {
      uptimeSec: Math.round(uptimeSec),
      totalJobs: total,
      queuedJobs: counts.get('QUEUED') ?? 0,
      processingJobs,
      sentJobs: counts.get('SENT') ?? 0,
      deliveredJobs: counts.get('DELIVERED') ?? 0,
      failedJobs: counts.get('FAILED') ?? 0,
      cancelledJobs: counts.get('CANCELLED') ?? 0,
      unknownJobs: counts.get('UNKNOWN') ?? 0,
      authorizedRecipients: Number(authRow.cnt || 0),
      averageProcessingMs: avgRow.avg_ms !== null ? Math.round(avgRow.avg_ms) : null,
    };
  }

  close(): void {
    this.db.close();
  }
}
