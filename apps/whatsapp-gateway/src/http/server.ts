import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import {
  CLOUD_MEDIA_FORMATS,
  GATEWAY_ERROR_CODES,
  STICKER_LIMITS_PROFILE,
  type ClientPlatformTarget,
  type CloudMediaFormat,
  type GatewayCapabilitiesResponse,
  type GatewayHealthResponse,
  type GatewayReadyResponse,
  type SoundStickerProtocolStrategy,
  type StickerAudioOptions,
  type StickerShapeOptions,
} from '@stickerwave/contracts';
import { z } from 'zod';
import { loadConfig, type GatewayConfig } from '../config.js';
import { createLogger, type GatewayLogger } from '../logger.js';
import { CompositionPipeline } from '../media/composition-pipeline.js';
import { FFmpegAdapter } from '../media/ffmpeg-adapter.js';
import { AuthorizationService } from '../services/authorization-service.js';
import { JobDomainError, StickerJobService } from '../services/sticker-job-service.js';
import { GatewayDatabase } from '../storage/database.js';
import { EncryptedSessionStore } from '../whatsapp/session-store.js';
import { SoundStickerProtocol } from '../whatsapp/sound-sticker-protocol.js';
import { StickerImportBridge } from '../whatsapp/sticker-import-bridge.js';
import { WhatsAppConnectionManager, type WASocketFactory } from '../whatsapp/connection-manager.js';
import { buildOpenApiDocument } from './openapi.js';
import {
  applySecurityAndCorsHeaders,
  getClientIp,
  parseMultipartBody,
  readRawBody,
  SlidingWindowRateLimiter,
  verifyAdminAuth,
  verifyOptionalPublicToken,
} from './security.js';

const GATEWAY_VERSION = '1.0.0';

const phoneSchema = z.object({
  phone: z.string().min(4).max(32),
  defaultCountry: z.enum(['BR', 'US']).optional(),
});

const confirmChallengeSchema = z.object({
  phone: z.string().min(4).max(32),
  code: z.string().trim().min(4).max(12),
});

const shapeOptionsSchema = z
  .object({
    shape: z.enum(['square', 'rounded', 'circle']).optional(),
    borderWhite: z.boolean().optional(),
    background: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
  })
  .optional();

const audioOptionsSchema = z
  .object({
    trimStartMs: z.number().min(0).max(60_000).optional(),
    trimEndMs: z.number().min(0).max(60_000).optional(),
    timelineOffsetMs: z.number().min(0).max(25_000).optional(),
    volume: z.number().min(0).max(3).optional(),
    fadeInMs: z.number().min(0).max(5_000).optional(),
    fadeOutMs: z.number().min(0).max(5_000).optional(),
    normalizePeak: z.boolean().optional(),
    useVideoAudioFallback: z.boolean().optional(),
    targetDurationMs: z.number().min(200).max(25_000).optional(),
  })
  .optional();

export interface GatewayRuntime {
  config: GatewayConfig;
  logger: GatewayLogger;
  db: GatewayDatabase;
  ffmpeg: FFmpegAdapter;
  protocol: SoundStickerProtocol;
  wa: WhatsAppConnectionManager;
  authService: AuthorizationService;
  jobService: StickerJobService;
  server: http.Server;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown, headOnly = false): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(headOnly ? undefined : payload);
}

function sendError(res: ServerResponse, statusCode: number, code: string, message: string, retryable = false): void {
  sendJson(res, statusCode, { ok: false, code, message, retryable });
}

async function readJsonBody<T>(req: IncomingMessage, maxBytes = 64 * 1024): Promise<T> {
  const raw = await readRawBody(req, maxBytes);
  if (raw.byteLength === 0) return {} as T;
  return JSON.parse(raw.toString('utf8')) as T;
}

function normalizeApiPath(rawPathname: string): string {
  if (rawPathname.startsWith('/api/v1/')) return rawPathname;
  if (rawPathname.startsWith('/api/')) return `/api/v1/${rawPathname.slice('/api/'.length)}`;
  return rawPathname;
}

async function parseStickerMultipartRequest(req: IncomingMessage, config: GatewayConfig) {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new JobDomainError(415, GATEWAY_ERROR_CODES.INVALID_MEDIA, 'Envie a composição via multipart/form-data.');
  }

  const maxMultipartBytes = config.maxVisualUploadBytes + config.maxAudioUploadBytes + 512 * 1024;
  const rawBody = await readRawBody(req, maxMultipartBytes);
  const { fields, files } = parseMultipartBody(rawBody, contentType);

  if (fields.visualUrl || fields.audioUrl) {
    throw new JobDomainError(
      400,
      GATEWAY_ERROR_CODES.INVALID_MEDIA,
      'URLs externas não são aceitas diretamente pelo servidor; envie os bytes da mídia.',
    );
  }

  const shapeOptions = fields.shapeOptions
    ? (shapeOptionsSchema.parse(JSON.parse(fields.shapeOptions)) as Partial<StickerShapeOptions>)
    : undefined;
  const audioOptions = fields.audioOptions
    ? (audioOptionsSchema.parse(JSON.parse(fields.audioOptions)) as StickerAudioOptions)
    : undefined;

  return { fields, files, shapeOptions, audioOptions };
}

function writeSseEvent(res: ServerResponse, eventName: string, data: unknown): void {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createGatewayRuntime(
  customConfig?: Partial<GatewayConfig>,
  deps: {
    socketFactory?: WASocketFactory;
    ffmpegAdapter?: FFmpegAdapter;
    skipStartupReconnect?: boolean;
  } = {},
): GatewayRuntime {
  const baseConfig = loadConfig();
  const config: GatewayConfig = Object.freeze({ ...baseConfig, ...(customConfig ?? {}) });
  const startedAt = Date.now();
  const logger = createLogger(config.logLevel);
  const db = new GatewayDatabase(config.dbPath);
  const recovery = db.recoverInterruptedJobs();
  if (recovery.markedUnknown > 0 || recovery.markedFailed > 0) {
    logger.warn('Recovered interrupted jobs after restart.', recovery);
  }

  const ffmpeg = deps.ffmpegAdapter ?? new FFmpegAdapter({ ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath });
  const protocol = new SoundStickerProtocol('7.0.0-rc14', config.soundStickerProtocol);
  const sessionStore = new EncryptedSessionStore(config.sessionDir, config.sessionSecret);
  const wa = new WhatsAppConnectionManager(config, sessionStore, protocol, logger, deps.socketFactory);
  const authService = new AuthorizationService(db, config, logger, () => wa.getBotPhoneDigits());
  const pipeline = new CompositionPipeline(ffmpeg, config);
  const importBridge = new StickerImportBridge();
  const jobService = new StickerJobService(config, db, pipeline, wa, authService, logger);

  // Wire central bot incoming WhatsApp text -> opt-in verification listener
  wa.onIncomingText(async (evt) => {
    const handled = authService.handleIncomingWhatsAppAuthorization(evt);
    return handled.confirmed ? handled.replyText ?? null : null;
  });

  const ipLimiter = new SlidingWindowRateLimiter(config.rateLimitWindowMs, config.rateLimitMaxRequests);
  const sseStreams = new Set<ServerResponse>();
  const sseIntervals = new Set<ReturnType<typeof setInterval>>();

  const server = http.createServer(async (req, res) => {
    const cors = applySecurityAndCorsHeaders(req, res, config);
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = normalizeApiPath(reqUrl.pathname);
    const method = (req.method || 'GET').toUpperCase();

    if (cors.origin && !cors.originAllowed) {
      sendError(res, 403, GATEWAY_ERROR_CODES.FORBIDDEN_ORIGIN, 'Origem não permitida pela política CORS do gateway.');
      return;
    }

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health and readiness probes stay exempt from tight client rate limits (HEAD supported for external uptime monitors)
    if ((method === 'GET' || method === 'HEAD') && pathname === '/health') {
      const body: GatewayHealthResponse = {
        ok: true,
        service: 'stickerwave-whatsapp-gateway',
        version: GATEWAY_VERSION,
        timestamp: new Date().toISOString(),
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      };
      sendJson(res, 200, body, method === 'HEAD');
      return;
    }

    if (method === 'GET' && pathname === '/ready') {
      const ff = await ffmpeg.checkCapabilities();
      const sqliteReady = db.ping();
      const protocolReady = protocol.capability.mode !== 'unsupported';
      const waSnap = wa.getSnapshot();
      const whatsappConnected = config.enableWaBot && waSnap.status === 'CONNECTED';
      const reasons: string[] = [];
      if (!ff.ready) reasons.push(ff.error || 'FFmpeg indisponível');
      if (!sqliteReady) reasons.push('SQLite indisponível');
      if (config.enableWaBot && !protocolReady) reasons.push('Protocolo Baileys incompatível');
      if (config.enableWaBot && !whatsappConnected) reasons.push(`WhatsApp bot em estado ${waSnap.status}`);

      const ready = ff.ready && sqliteReady && (!config.enableWaBot || protocolReady);
      const body: GatewayReadyResponse = {
        ready,
        ffmpegReady: ff.ready,
        sqliteReady,
        protocolReady,
        whatsappBotEnabled: config.enableWaBot,
        whatsappConnected,
        whatsappStatus: waSnap.status,
        soundStickersEnabled: config.enableSoundStickers,
        reasons,
      };
      sendJson(res, ready ? 200 : 503, body);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/openapi.json') {
      sendJson(res, 200, buildOpenApiDocument(config));
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/capabilities') {
      const ff = await ffmpeg.checkCapabilities();
      const body: GatewayCapabilitiesResponse = {
        cloudMediaEnabled: ff.ready,
        cloudFormats: [...CLOUD_MEDIA_FORMATS],
        whatsappBotEnabled: config.enableWaBot,
        soundStickersEnabled: config.enableSoundStickers,
        ffmpegVersion: ff.versionLine,
        encoders: {
          libwebp: ff.encoders.libwebp,
          libopus: ff.encoders.libopus || ff.encoders.opusExperimental,
          libx264: ff.encoders.libx264,
        },
        baileysVersion: protocol.capability.baileysVersion,
        protocolField26Supported: protocol.capability.mode !== 'unsupported',
        protocolStrategy: protocol.capability.strategy,
        supportedProtocolStrategies: protocol.capability.supportedStrategies,
        protocolMode: protocol.capability.mode,
        limits: STICKER_LIMITS_PROFILE,
        maxParallelJobs: config.maxParallelJobs,
        authorCredit: {
          name: 'Nathan Paranhos',
          url: 'https://nathan-paranhos.com.br/',
        },
      };
      sendJson(res, 200, body);
      return;
    }

    // Apply rate limit to API traffic
    const rateCheck = ipLimiter.consume(getClientIp(req));
    if (!rateCheck.allowed) {
      res.setHeader('Retry-After', String(rateCheck.retryAfterSec));
      sendError(res, 429, GATEWAY_ERROR_CODES.RATE_LIMITED, 'Muitas requisições ao gateway. Aguarde alguns instantes.', true);
      return;
    }

    // --- Admin Routes (/api/v1/admin/whatsapp/*, /api/v1/admin/metrics|jobs, plus /api/v1/whatsapp/* aliases) ---
    const isAdminRoute =
      pathname.startsWith('/api/v1/admin/') || pathname.startsWith('/api/v1/whatsapp/');
    if (isAdminRoute) {
      const authErr = verifyAdminAuth(req, config);
      if (authErr) {
        sendError(res, authErr.statusCode, authErr.code, authErr.message);
        return;
      }

      const adminSubPath = pathname.startsWith('/api/v1/admin/')
        ? pathname.slice('/api/v1/admin'.length)
        : pathname.slice('/api/v1'.length);

      if (method === 'POST' && adminSubPath === '/whatsapp/auth/verify') {
        sendJson(res, 200, { ok: true, authenticated: true });
        return;
      }
      if (method === 'GET' && adminSubPath === '/whatsapp/status') {
        sendJson(res, 200, wa.getSnapshot());
        return;
      }
      if (method === 'GET' && adminSubPath === '/whatsapp/qr') {
        const snap = wa.getSnapshot();
        sendJson(res, 200, {
          status: snap.status,
          qrCodeDataUrl: snap.qrCodeDataUrl,
          qrExpiresAt: snap.qrExpiresAt,
          qrGeneration: snap.qrGeneration,
        });
        return;
      }
      if (method === 'POST' && adminSubPath === '/whatsapp/connect') {
        if (!config.enableWaBot) {
          sendError(res, 503, GATEWAY_ERROR_CODES.SOUND_STICKERS_DISABLED, 'Bot WhatsApp desativado neste servidor (modo Cloud Media ativo).');
          return;
        }
        const body = await readJsonBody<{ forceNewQr?: boolean }>(req).catch(() => ({} as { forceNewQr?: boolean }));
        const snap = await wa.connect(Boolean(body.forceNewQr));
        sendJson(res, 200, snap);
        return;
      }
      if (method === 'POST' && adminSubPath === '/whatsapp/reconnect') {
        if (!config.enableWaBot) {
          sendError(res, 503, GATEWAY_ERROR_CODES.SOUND_STICKERS_DISABLED, 'Bot WhatsApp desativado neste servidor (modo Cloud Media ativo).');
          return;
        }
        const snap = await wa.connect(false);
        sendJson(res, 200, snap);
        return;
      }
      if (method === 'POST' && adminSubPath === '/whatsapp/disconnect') {
        const body = await readJsonBody<{ clearSession?: boolean }>(req).catch(() => ({} as { clearSession?: boolean }));
        const snap = await wa.disconnect(Boolean(body.clearSession));
        sendJson(res, 200, snap);
        return;
      }
      if (method === 'GET' && (adminSubPath === '/metrics' || adminSubPath === '/whatsapp/metrics')) {
        sendJson(res, 200, db.getMetrics((Date.now() - startedAt) / 1000));
        return;
      }
      if (method === 'GET' && (adminSubPath === '/jobs' || adminSubPath === '/whatsapp/jobs')) {
        const limit = Number(reqUrl.searchParams.get('limit') || 30);
        sendJson(res, 200, { jobs: jobService.listRecentJobs(limit) });
        return;
      }
      if (method === 'GET' && adminSubPath === '/whatsapp/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        sseStreams.add(res);
        writeSseEvent(res, 'snapshot', { type: 'snapshot', snapshot: wa.getSnapshot(), timestamp: new Date().toISOString() });
        const unsub = wa.subscribe((evt) => {
          writeSseEvent(res, evt.type, evt);
        });
        const heartbeat = setInterval(() => {
          res.write(': ping\n\n');
        }, 15_000);
        sseIntervals.add(heartbeat);
        req.on('close', () => {
          clearInterval(heartbeat);
          sseIntervals.delete(heartbeat);
          sseStreams.delete(res);
          unsub();
        });
        return;
      }
    }

    // Optional public token guard for non-admin client endpoints when configured
    const publicErr = verifyOptionalPublicToken(req, config);
    if (publicErr) {
      sendError(res, publicErr.statusCode, publicErr.code, publicErr.message);
      return;
    }

    // --- Cloud Media Processing Endpoint (public via CORS + rate limiter; no WhatsApp bot needed) ---
    if (method === 'POST' && pathname === '/api/v1/media/convert') {
      const contentType = String(req.headers['content-type'] || '');
      if (!contentType.toLowerCase().includes('multipart/form-data')) {
        sendError(res, 415, GATEWAY_ERROR_CODES.INVALID_MEDIA, 'Envie a composição via multipart/form-data.');
        return;
      }

      try {
        const maxMultipartBytes = config.maxVisualUploadBytes + config.maxAudioUploadBytes + 512 * 1024;
        const rawBody = await readRawBody(req, maxMultipartBytes);
        const { fields, files } = parseMultipartBody(rawBody, contentType);

        if (fields.visualUrl || fields.audioUrl) {
          sendError(
            res,
            400,
            GATEWAY_ERROR_CODES.INVALID_MEDIA,
            'URLs externas não são aceitas diretamente pelo servidor; envie os bytes da mídia.',
          );
          return;
        }

        const requestedFormat = (fields.format || 'webp').trim() as CloudMediaFormat;
        if (!CLOUD_MEDIA_FORMATS.includes(requestedFormat)) {
          sendError(res, 400, GATEWAY_ERROR_CODES.INVALID_COMPOSITION, `Formato não suportado: ${requestedFormat}`);
          return;
        }

        let shapeOptions: Partial<StickerShapeOptions> | undefined;
        if (fields.shapeOptions) {
          shapeOptions = shapeOptionsSchema.parse(JSON.parse(fields.shapeOptions));
        }
        let audioOptions: StickerAudioOptions | undefined;
        if (fields.audioOptions) {
          audioOptions = audioOptionsSchema.parse(JSON.parse(fields.audioOptions));
        }

        const rendered = await pipeline.renderCloudMedia({
          format: requestedFormat,
          visualBytes: files.visual?.data ?? null,
          audioBytes: files.audio?.data ?? null,
          title: fields.title,
          shapeOptions,
          audioOptions,
        });

        res.writeHead(200, {
          'Content-Type': rendered.mimeType,
          'Content-Length': rendered.buffer.byteLength,
          'Content-Disposition': `attachment; filename="stickerwave.${rendered.extension}"`,
          'X-Sticker-Animated': rendered.isAnimated ? 'true' : 'false',
          'X-Sticker-Duration-Ms': String(rendered.durationMs),
          'X-Sticker-Bytes': String(rendered.buffer.byteLength),
          'X-Sticker-Cloud-Engine': 'stickerwave-ffmpeg',
        });
        res.end(rendered.buffer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('PAYLOAD_TOO_LARGE')) {
          sendError(res, 413, GATEWAY_ERROR_CODES.MEDIA_TOO_LARGE, 'Payload de mídia excedeu o limite máximo permitido.');
          return;
        }
        sendError(res, 400, GATEWAY_ERROR_CODES.INVALID_COMPOSITION, `Falha no processamento Cloud FFmpeg: ${msg}`);
      }
      return;
    }

    // --- Phone validation & recipient opt-in authorization ---
    if (method === 'POST' && pathname === '/api/v1/phones/validate') {
      try {
        const parsed = phoneSchema.parse(await readJsonBody(req));
        sendJson(res, 200, authService.validatePhone(parsed.phone, parsed.defaultCountry ?? 'BR'));
      } catch {
        sendError(res, 400, GATEWAY_ERROR_CODES.INVALID_PHONE, 'Dados de telefone inválidos.');
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/recipients/authorization-request') {
      if (!config.enableWaBot) {
        sendError(res, 503, GATEWAY_ERROR_CODES.SOUND_STICKERS_DISABLED, 'Bot WhatsApp desativado neste servidor (modo Cloud Media ativo).');
        return;
      }
      try {
        const parsed = phoneSchema.parse(await readJsonBody(req));
        const { validation, challenge } = authService.requestAuthorizationChallenge(parsed.phone);
        if (!validation.valid || !challenge) {
          sendError(res, 400, GATEWAY_ERROR_CODES.INVALID_PHONE, validation.reason || 'Número inválido.');
          return;
        }
        sendJson(res, 200, challenge);
      } catch {
        sendError(res, 400, GATEWAY_ERROR_CODES.INVALID_PHONE, 'Solicitação de autorização inválida.');
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/recipients/authorization-status') {
      const phone = reqUrl.searchParams.get('phone') || '';
      const validation = authService.validatePhone(phone);
      if (!validation.valid || !validation.e164) {
        sendError(res, 400, GATEWAY_ERROR_CODES.INVALID_PHONE, validation.reason || 'Número inválido.');
        return;
      }
      sendJson(res, 200, authService.getStatus(validation.e164));
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/recipients/authorization-confirm') {
      try {
        const parsed = confirmChallengeSchema.parse(await readJsonBody(req));
        const validation = authService.validatePhone(parsed.phone);
        if (!validation.valid || !validation.e164) {
          sendError(res, 400, GATEWAY_ERROR_CODES.INVALID_PHONE, validation.reason || 'Número inválido.');
          return;
        }
        const resConfirm = authService.confirmByPhoneAndCode(validation.e164, parsed.code);
        if (!resConfirm.confirmed) {
          sendError(res, 400, GATEWAY_ERROR_CODES.RECIPIENT_NOT_AUTHORIZED, 'Código de verificação inválido ou expirado.');
          return;
        }
        sendJson(res, 200, resConfirm.status);
      } catch {
        sendError(res, 400, GATEWAY_ERROR_CODES.INVALID_PHONE, 'Payload de confirmação inválido.');
      }
      return;
    }

    if (method === 'DELETE' && pathname === '/api/v1/recipients/authorization') {
      const phone = reqUrl.searchParams.get('phone') || '';
      const validation = authService.validatePhone(phone);
      if (!validation.valid || !validation.e164) {
        sendError(res, 400, GATEWAY_ERROR_CODES.INVALID_PHONE, validation.reason || 'Número inválido.');
        return;
      }
      const revoked = authService.revoke(validation.e164);
      sendJson(res, 200, { ok: true, revoked, masked: validation.masked });
      return;
    }

    // --- StickerWave Core Process Endpoint (static / animated / sound -> validated WebP+EXIF+Ogg) ---
    if (method === 'POST' && pathname === '/api/v1/stickers/process') {
      try {
        const { fields, files, shapeOptions, audioOptions } = await parseStickerMultipartRequest(req, config);
        const visualPart = files.visual;
        if (!visualPart || visualPart.data.byteLength === 0) {
          sendError(res, 400, GATEWAY_ERROR_CODES.INVALID_MEDIA, 'Arquivo visual obrigatório ausente (campo "visual").');
          return;
        }
        const protocolStrategy: SoundStickerProtocolStrategy =
          fields.protocolStrategy === 'sticker-26' ? 'sticker-26' : config.soundStickerProtocol;
        const emojis = fields.emojis
          ? fields.emojis
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        const result = await pipeline.processInternalSticker({
          visualBytes: visualPart.data,
          visualOriginalName: visualPart.filename,
          audioBytes: files.audio?.data ?? null,
          audioOriginalName: files.audio?.filename,
          shapeOptions,
          audioOptions,
          protocolStrategy,
          metadata: {
            packName: fields.packName || fields.title || 'StickerWave',
            packPublisher: fields.packPublisher || 'Nathan Paranhos',
            emojis,
          },
        });
        sendJson(res, 200, { ok: true, sticker: result.encodedSticker });
      } catch (err) {
        if (err instanceof JobDomainError) {
          sendError(res, err.statusCode, err.code, err.message, err.retryable);
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('PAYLOAD_TOO_LARGE')) {
          sendError(res, 413, GATEWAY_ERROR_CODES.MEDIA_TOO_LARGE, 'Payload de mídia excedeu o limite máximo permitido.');
          return;
        }
        sendError(res, 400, GATEWAY_ERROR_CODES.INVALID_COMPOSITION, `Falha ao processar figurinha: ${msg}`);
      }
      return;
    }

    // --- Sticker Import Bridge Endpoint (Add to WhatsApp evaluation + optional authorized relay) ---
    if (method === 'POST' && pathname === '/api/v1/stickers/add-to-whatsapp') {
      try {
        const { fields, files, shapeOptions, audioOptions } = await parseStickerMultipartRequest(req, config);
        const visualPart = files.visual;
        if (!visualPart || visualPart.data.byteLength === 0) {
          sendError(res, 400, GATEWAY_ERROR_CODES.INVALID_MEDIA, 'Arquivo visual obrigatório ausente (campo "visual").');
          return;
        }
        const platformRaw = String(fields.platform || 'web').toLowerCase();
        const platform: ClientPlatformTarget =
          platformRaw === 'android' || platformRaw === 'ios' || platformRaw === 'pwa' ? platformRaw : 'web';
        const protocolStrategy: SoundStickerProtocolStrategy =
          fields.protocolStrategy === 'sticker-26' ? 'sticker-26' : config.soundStickerProtocol;
        const emojis = fields.emojis
          ? fields.emojis
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        const metadata = {
          packName: fields.packName || fields.title || 'StickerWave',
          packPublisher: fields.packPublisher || 'Nathan Paranhos',
          emojis,
        };

        const processed = await pipeline.processInternalSticker({
          visualBytes: visualPart.data,
          visualOriginalName: visualPart.filename,
          audioBytes: files.audio?.data ?? null,
          audioOriginalName: files.audio?.filename,
          shapeOptions,
          audioOptions,
          protocolStrategy,
          metadata,
        });

        const waSnap = wa.getSnapshot();
        const waConnected = config.enableWaBot && waSnap.status === 'CONNECTED';
        let dispatchedJob = null;

        const recipientPhone = (fields.recipientPhone || '').trim();
        if (recipientPhone && waConnected && processed.oggBuffer) {
          const phoneValidation = authService.validatePhone(recipientPhone);
          if (phoneValidation.valid && phoneValidation.e164 && authService.isAuthorized(phoneValidation.e164)) {
            const enqueued = jobService.enqueue({
              idempotencyKey: fields.idempotencyKey?.trim() || undefined,
              recipientPhone,
              visualBytes: visualPart.data,
              visualName: visualPart.filename,
              audioBytes: files.audio?.data ?? null,
              audioName: files.audio?.filename,
              shapeOptions,
              audioOptions,
              emojis,
              packName: metadata.packName,
              accessibilityLabel: fields.accessibilityLabel?.slice(0, 250),
            });
            dispatchedJob = enqueued.job;
          }
        }

        const bridgeResult = importBridge.resolveAddToWhatsApp({
          platform,
          encodedSticker: processed.encodedSticker,
          metadata,
          waConnected,
          waBotEnabled: config.enableWaBot,
          botPhoneHint: wa.getBotPhoneDigits() || config.waBotPhoneHint,
          dispatchedJob,
        });
        sendJson(res, 200, bridgeResult);
      } catch (err) {
        if (err instanceof JobDomainError) {
          sendError(res, err.statusCode, err.code, err.message, err.retryable);
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('PAYLOAD_TOO_LARGE')) {
          sendError(res, 413, GATEWAY_ERROR_CODES.MEDIA_TOO_LARGE, 'Payload de mídia excedeu o limite máximo permitido.');
          return;
        }
        sendError(res, 400, GATEWAY_ERROR_CODES.INVALID_COMPOSITION, `Erro na ponte de importação: ${msg}`);
      }
      return;
    }

    // --- Sound Sticker Send & Job Endpoints ---
    if (method === 'POST' && pathname === '/api/v1/stickers/send') {
      if (!config.enableWaBot) {
        sendError(res, 503, GATEWAY_ERROR_CODES.SOUND_STICKERS_DISABLED, 'Bot WhatsApp desativado neste servidor (modo Cloud Media ativo).');
        return;
      }
      const contentType = String(req.headers['content-type'] || '');
      if (!contentType.toLowerCase().includes('multipart/form-data')) {
        sendError(res, 415, GATEWAY_ERROR_CODES.INVALID_MEDIA, 'Envie a composição via multipart/form-data.');
        return;
      }

      try {
        const maxMultipartBytes = config.maxVisualUploadBytes + config.maxAudioUploadBytes + 512 * 1024;
        const rawBody = await readRawBody(req, maxMultipartBytes);
        const { fields, files } = parseMultipartBody(rawBody, contentType);

        if (fields.visualUrl || fields.audioUrl) {
          sendError(
            res,
            400,
            GATEWAY_ERROR_CODES.INVALID_MEDIA,
            'URLs externas não são aceitas diretamente pelo gateway; envie os bytes da mídia.',
          );
          return;
        }

        const visualPart = files.visual;
        if (!visualPart || visualPart.data.byteLength === 0) {
          sendError(res, 400, GATEWAY_ERROR_CODES.INVALID_MEDIA, 'Arquivo visual obrigatório ausente (campo "visual").');
          return;
        }

        let shapeOptions: Partial<StickerShapeOptions> | undefined;
        if (fields.shapeOptions) {
          shapeOptions = shapeOptionsSchema.parse(JSON.parse(fields.shapeOptions));
        }
        let audioOptions: StickerAudioOptions | undefined;
        if (fields.audioOptions) {
          audioOptions = audioOptionsSchema.parse(JSON.parse(fields.audioOptions));
        }

        const headerIdemp =
          (typeof req.headers['idempotency-key'] === 'string' && req.headers['idempotency-key'].trim()) ||
          fields.idempotencyKey?.trim() ||
          undefined;

        const { job, deduplicated } = jobService.enqueue({
          idempotencyKey: headerIdemp,
          recipientPhone: fields.recipientPhone || '',
          visualBytes: visualPart.data,
          visualName: visualPart.filename,
          audioBytes: files.audio?.data ?? null,
          audioName: files.audio?.filename,
          shapeOptions,
          audioOptions,
          accessibilityLabel: fields.accessibilityLabel?.slice(0, 250),
        });

        sendJson(res, deduplicated ? 200 : 202, { ok: true, deduplicated, job });
      } catch (err) {
        if (err instanceof JobDomainError) {
          sendError(res, err.statusCode, err.code, err.message, err.retryable);
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('PAYLOAD_TOO_LARGE')) {
          sendError(res, 413, GATEWAY_ERROR_CODES.MEDIA_TOO_LARGE, 'Payload de mídia excedeu o limite máximo permitido.');
          return;
        }
        sendError(res, 400, GATEWAY_ERROR_CODES.INVALID_COMPOSITION, `Erro na validação do envio: ${msg}`);
      }
      return;
    }

    const jobEventsMatch = pathname.match(/^\/api\/v1\/stickers\/jobs\/([0-9a-f-]+)\/events$/i);
    if (method === 'GET' && jobEventsMatch) {
      const jobId = jobEventsMatch[1]!;
      const job = jobService.getJob(jobId);
      if (!job) {
        sendError(res, 404, GATEWAY_ERROR_CODES.JOB_NOT_FOUND, 'Job não encontrado.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      sseStreams.add(res);
      writeSseEvent(res, 'job', { type: 'job', job, timestamp: new Date().toISOString() });
      const unsub = jobService.subscribeJob(jobId, (evt) => {
        writeSseEvent(res, 'job', evt);
      });
      const heartbeat = setInterval(() => {
        res.write(': ping\n\n');
      }, 15_000);
      sseIntervals.add(heartbeat);
      req.on('close', () => {
        clearInterval(heartbeat);
        sseIntervals.delete(heartbeat);
        sseStreams.delete(res);
        unsub();
      });
      return;
    }

    const jobCancelMatch = pathname.match(/^\/api\/v1\/stickers\/jobs\/([0-9a-f-]+)\/cancel$/i);
    if (method === 'POST' && jobCancelMatch) {
      try {
        const job = jobService.cancelJob(jobCancelMatch[1]!);
        sendJson(res, 200, { ok: true, job });
      } catch (err) {
        if (err instanceof JobDomainError) {
          sendError(res, err.statusCode, err.code, err.message, err.retryable);
          return;
        }
        sendError(res, 500, GATEWAY_ERROR_CODES.FFMPEG_FAILED, 'Falha ao cancelar job.');
      }
      return;
    }

    const jobStatusMatch = pathname.match(/^\/api\/v1\/stickers\/jobs\/([0-9a-f-]+)$/i);
    if (method === 'GET' && jobStatusMatch) {
      const job = jobService.getJob(jobStatusMatch[1]!);
      if (!job) {
        sendError(res, 404, GATEWAY_ERROR_CODES.JOB_NOT_FOUND, 'Job não encontrado.');
        return;
      }
      sendJson(res, 200, job);
      return;
    }

    sendError(res, 404, 'GW-4040', 'Endpoint não encontrado no WhatsApp Gateway.');
  });

  return {
    config,
    logger,
    db,
    ffmpeg,
    protocol,
    wa,
    authService,
    jobService,
    server,
    async start() {
      if (config.enableWaBot && !deps.skipStartupReconnect) {
        await wa.init();
      }
      await new Promise<void>((resolve) => {
        server.listen(config.port, config.host, () => resolve());
      });
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : config.port;
      logger.info('StickerWave WhatsApp Gateway listening.', {
        host: config.host,
        port: actualPort,
        enableSoundStickers: config.enableSoundStickers,
        protocolMode: protocol.capability.mode,
      });
      return { host: config.host, port: actualPort };
    },
    async stop() {
      await wa.shutdown();
      for (const timer of sseIntervals) clearInterval(timer);
      sseIntervals.clear();
      for (const stream of sseStreams) {
        try {
          stream.end();
        } catch {
          // ignore
        }
      }
      sseStreams.clear();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}
