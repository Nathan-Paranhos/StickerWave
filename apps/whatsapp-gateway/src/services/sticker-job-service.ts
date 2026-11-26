import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  GATEWAY_ERROR_CODES,
  TERMINAL_JOB_STATUSES,
  type StickerAudioOptions,
  type StickerJobEvent,
  type StickerSendJobSummary,
  type StickerShapeOptions,
} from '@stickerwave/contracts';
import type { GatewayConfig } from '../config.js';
import type { GatewayLogger } from '../logger.js';
import type { CompositionPipeline } from '../media/composition-pipeline.js';
import type { GatewayDatabase } from '../storage/database.js';
import { maskPhone } from '../utils/mask.js';
import type { WhatsAppConnectionManager } from '../whatsapp/connection-manager.js';
import type { AuthorizationService } from './authorization-service.js';

export interface EnqueueStickerJobInput {
  idempotencyKey?: string;
  recipientPhone: string;
  visualBytes: Buffer;
  visualName?: string;
  audioBytes?: Buffer | null;
  audioName?: string;
  shapeOptions?: Partial<StickerShapeOptions>;
  audioOptions?: StickerAudioOptions;
  accessibilityLabel?: string;
  emojis?: string[];
  packName?: string;
}

export class JobDomainError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'JobDomainError';
  }
}

interface QueuedExecution {
  jobId: string;
  recipientE164: string;
  input: EnqueueStickerJobInput;
  abortController: AbortController;
  started: boolean;
}

export class StickerJobService {
  private readonly emitter = new EventEmitter();
  private readonly pendingQueue: QueuedExecution[] = [];
  private readonly activeJobs = new Map<string, QueuedExecution>();
  private activeCount = 0;

  constructor(
    private readonly config: GatewayConfig,
    private readonly db: GatewayDatabase,
    private readonly pipeline: CompositionPipeline,
    private readonly wa: WhatsAppConnectionManager,
    private readonly authService: AuthorizationService,
    private readonly logger: GatewayLogger,
  ) {
    this.wa.onDeliveryAck(({ waMessageId, ack }) => {
      const existing = this.db.getJobByWaMessageId(waMessageId);
      if (!existing) return;
      const nextStatus = ack === 'device' || ack === 'read' ? 'DELIVERED' : existing.status;
      const updated = this.db.updateJob(existing.id, {
        status: nextStatus,
        progress: nextStatus === 'DELIVERED' ? 100 : existing.progress,
        stageLabel:
          ack === 'read'
            ? 'Figurinha entregue e reproduzida/visualizada'
            : ack === 'device'
              ? 'Figurinha entregue no WhatsApp do destinatário'
              : 'Aceita pelos servidores do WhatsApp',
        deliveryAckStatus: ack,
        completedAt: existing.completedAt ?? new Date().toISOString(),
      });
      if (updated) this.emitJob(updated);
    });
  }

  subscribeJob(jobId: string, listener: (event: StickerJobEvent) => void): () => void {
    const channel = `job:${jobId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  private emitJob(job: StickerSendJobSummary): void {
    const event: StickerJobEvent = { type: 'job', job, timestamp: new Date().toISOString() };
    this.emitter.emit(`job:${job.id}`, event);
    this.emitter.emit('all', event);
  }

  getJob(jobId: string): StickerSendJobSummary | null {
    return this.db.getJobById(jobId);
  }

  listRecentJobs(limit = 30): StickerSendJobSummary[] {
    return this.db.listRecentJobs(limit);
  }

  enqueue(input: EnqueueStickerJobInput): { job: StickerSendJobSummary; deduplicated: boolean } {
    if (!this.config.enableSoundStickers) {
      throw new JobDomainError(
        503,
        GATEWAY_ERROR_CODES.SOUND_STICKERS_DISABLED,
        'O envio de figurinhas sonoras está temporariamente desativado via feature flag.',
        true,
      );
    }

    const phoneValidation = this.authService.validatePhone(input.recipientPhone);
    if (!phoneValidation.valid || !phoneValidation.e164) {
      throw new JobDomainError(
        400,
        GATEWAY_ERROR_CODES.INVALID_PHONE,
        phoneValidation.reason || 'Número de WhatsApp inválido. Informe no padrão internacional E.164 (ex.: +5511999998888).',
      );
    }
    const e164 = phoneValidation.e164;

    if (input.idempotencyKey) {
      const existing = this.db.getJobByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        return { job: existing, deduplicated: true };
      }
    }

    if (!this.authService.isAuthorized(e164)) {
      throw new JobDomainError(
        403,
        GATEWAY_ERROR_CODES.RECIPIENT_NOT_AUTHORIZED,
        'O número de destino precisa autorizar o recebimento enviando o código de verificação ao bot central.',
      );
    }

    const waSnap = this.wa.getSnapshot();
    if (waSnap.status !== 'CONNECTED') {
      throw new JobDomainError(
        503,
        GATEWAY_ERROR_CODES.WHATSAPP_NOT_CONNECTED,
        `O WhatsApp central do bot não está conectado no momento (estado: ${waSnap.status}).`,
        true,
      );
    }

    const rate = this.db.countAndRecordPhoneSendAttempt(e164, this.config.rateLimitSendPerPhonePerHour);
    if (!rate.allowed) {
      throw new JobDomainError(
        429,
        GATEWAY_ERROR_CODES.RATE_LIMITED,
        'Limite horário de envios para este número foi atingido. Aguarde antes de enviar outra figurinha.',
        true,
      );
    }

    const jobId = crypto.randomUUID();
    const job = this.db.createJob({
      id: jobId,
      idempotencyKey: input.idempotencyKey ?? null,
      recipientE164: e164,
      soundStickersEnabled: this.config.enableSoundStickers,
    });
    this.emitJob(job);

    const exec: QueuedExecution = {
      jobId,
      recipientE164: e164,
      input,
      abortController: new AbortController(),
      started: false,
    };
    this.pendingQueue.push(exec);
    this.activeJobs.set(jobId, exec);
    queueMicrotask(() => this.pumpQueue());

    return { job, deduplicated: false };
  }

  cancelJob(jobId: string): StickerSendJobSummary {
    const current = this.db.getJobById(jobId);
    if (!current) {
      throw new JobDomainError(404, GATEWAY_ERROR_CODES.JOB_NOT_FOUND, 'Job não encontrado.');
    }
    if (TERMINAL_JOB_STATUSES.has(current.status) || current.status === 'UPLOADING' || current.status === 'SENDING') {
      throw new JobDomainError(
        409,
        GATEWAY_ERROR_CODES.JOB_NOT_CANCELLABLE,
        `Job no estado "${current.status}" não pode mais ser cancelado.`,
      );
    }

    const exec = this.activeJobs.get(jobId);
    if (exec) {
      exec.abortController.abort(new Error('Cancelled by caller.'));
      const qIdx = this.pendingQueue.indexOf(exec);
      if (qIdx >= 0) this.pendingQueue.splice(qIdx, 1);
      this.activeJobs.delete(jobId);
    }

    const updated = this.db.updateJob(jobId, {
      status: 'CANCELLED',
      stageLabel: 'Envio cancelado antes da transmissão ao WhatsApp',
      completedAt: new Date().toISOString(),
    })!;
    this.emitJob(updated);
    return updated;
  }

  private pumpQueue(): void {
    while (this.activeCount < this.config.maxParallelJobs && this.pendingQueue.length > 0) {
      const next = this.pendingQueue.shift()!;
      if (next.abortController.signal.aborted) {
        this.activeJobs.delete(next.jobId);
        continue;
      }
      this.activeCount += 1;
      next.started = true;
      void this.runExecution(next).finally(() => {
        this.activeCount -= 1;
        this.activeJobs.delete(next.jobId);
        this.pumpQueue();
      });
    }
  }

  private updateAndEmit(
    jobId: string,
    patch: Parameters<GatewayDatabase['updateJob']>[1],
  ): StickerSendJobSummary | null {
    const updated = this.db.updateJob(jobId, patch);
    if (updated) this.emitJob(updated);
    return updated;
  }

  private async runExecution(exec: QueuedExecution): Promise<void> {
    const startedMs = Date.now();
    const timeoutHandle = setTimeout(() => {
      exec.abortController.abort(new Error(`Timeout after ${this.config.jobTimeoutMs}ms`));
    }, this.config.jobTimeoutMs);

    try {
      const processed = await this.pipeline.process({
        visualBytes: exec.input.visualBytes,
        visualOriginalName: exec.input.visualName,
        audioBytes: exec.input.audioBytes,
        audioOriginalName: exec.input.audioName,
        shapeOptions: exec.input.shapeOptions,
        audioOptions: exec.input.audioOptions,
        metadata: {
          packName: exec.input.packName || 'StickerWave',
          packPublisher: 'Nathan Paranhos',
          emojis: exec.input.emojis?.length ? exec.input.emojis : ['🔊'],
        },
        signal: exec.abortController.signal,
        onStage: (stage, progress, stageLabel) => {
          if (!exec.abortController.signal.aborted) {
            this.updateAndEmit(exec.jobId, { status: stage, progress, stageLabel });
          }
        },
      });

      if (exec.abortController.signal.aborted) return;

      this.updateAndEmit(exec.jobId, {
        status: 'UPLOADING',
        progress: 75,
        stageLabel: 'Enviando mídias criptografadas ao WhatsApp',
        stickerAnimated: processed.isAnimated,
        durationMs: processed.durationMs,
        webpBytes: processed.webpBuffer.byteLength,
        oggBytes: processed.oggBuffer.byteLength,
      });

      this.updateAndEmit(exec.jobId, {
        status: 'SENDING',
        progress: 90,
        stageLabel: 'Transmitindo figurinha sonora pelo protocolo WhatsApp',
      });

      const sent = await this.wa.sendSoundStickerToRecipient({
        e164: exec.recipientE164,
        payload: {
          webpBuffer: processed.webpBuffer,
          oggBuffer: processed.oggBuffer,
          isAnimated: processed.isAnimated,
          seconds: processed.secondsField,
          waveform: processed.waveform,
          emojis: exec.input.emojis,
          accessibilityLabel: exec.input.accessibilityLabel,
        },
      });

      this.updateAndEmit(exec.jobId, {
        status: 'SENT',
        progress: 100,
        stageLabel: 'Figurinha sonora enviada ao WhatsApp',
        waMessageId: sent.messageId,
        deliveryAckStatus: 'server',
        processingMs: Date.now() - startedMs,
        completedAt: new Date().toISOString(),
      });
    } catch (err) {
      const current = this.db.getJobById(exec.jobId);
      if (current?.status === 'CANCELLED') return;

      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.toLowerCase().includes('timeout');
      const code = isTimeout
        ? GATEWAY_ERROR_CODES.TIMEOUT
        : message.includes('signature') || message.includes('Unsupported')
          ? GATEWAY_ERROR_CODES.INVALID_MEDIA
          : message.includes('connected')
            ? GATEWAY_ERROR_CODES.WHATSAPP_NOT_CONNECTED
            : message.includes('not registered')
              ? GATEWAY_ERROR_CODES.INVALID_PHONE
              : GATEWAY_ERROR_CODES.FFMPEG_FAILED;

      this.logger.warn('Sticker send job failed.', {
        jobId: exec.jobId,
        recipientMasked: maskPhone(exec.recipientE164),
        code,
        error: message,
      });

      this.updateAndEmit(exec.jobId, {
        status: 'FAILED',
        stageLabel: 'Falha no processamento ou envio',
        errorCode: code,
        errorMessage: message.slice(0, 300),
        processingMs: Date.now() - startedMs,
        completedAt: new Date().toISOString(),
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
