import type {
  GatewayCapabilitiesResponse,
  GatewayHealthResponse,
  GatewayMetricsSnapshot,
  GatewayReadyResponse,
  PhoneValidationResult,
  RecipientAuthorizationChallenge,
  RecipientAuthorizationStatusResponse,
  StickerAudioOptions,
  StickerJobEvent,
  StickerSendJobSummary,
  StickerShapeOptions,
  WhatsAppConnectionEvent,
  WhatsAppConnectionSnapshot,
} from '@stickerwave/contracts';
import { projectDuration, SIZE, visualLayers, type Project, type StoredAsset } from '../core/project';
import { pcmWav } from '../core/wav';
import { webpAnimation } from '../core/webp-animation';
import { Composition } from './composition';
import { mixAudio } from './mix';

const DEFAULT_GATEWAY_BASE = '/gateway';

export function getGatewayBaseUrl(): string {
  const configured = (import.meta.env.VITE_WHATSAPP_GATEWAY_URL as string | undefined)?.trim();
  const base = configured || DEFAULT_GATEWAY_BASE;
  return base.replace(/\/+$/, '');
}

function getOptionalPublicToken(): string {
  return ((import.meta.env.VITE_WHATSAPP_GATEWAY_TOKEN as string | undefined) || '').trim();
}

export class GatewayClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'GatewayClientError';
  }
}

async function gwFetch<T>(path: string, init: RequestInit = {}, adminSecret?: string): Promise<T> {
  const url = `${getGatewayBaseUrl()}${path}`;
  const headers = new Headers(init.headers ?? {});
  if (adminSecret) {
    headers.set('Authorization', `Bearer ${adminSecret}`);
  } else {
    const publicToken = getOptionalPublicToken();
    if (publicToken) headers.set('X-Gateway-Token', publicToken);
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch {
    throw new GatewayClientError(0, 'GW-0000', 'Não foi possível conectar ao StickerWave WhatsApp Gateway.', true);
  }

  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.toLowerCase().includes('application/json');
  const payload = isJson ? ((await response.json().catch(() => null)) as Record<string, unknown> | null) : null;

  if (!response.ok) {
    const code = typeof payload?.code === 'string' ? payload.code : `GW-${response.status}`;
    const msg = typeof payload?.message === 'string' ? payload.message : `Erro no gateway (${response.status}).`;
    const retryable = Boolean(payload?.retryable);
    throw new GatewayClientError(response.status, code, msg, retryable);
  }

  if (!payload) {
    throw new GatewayClientError(response.status, 'GW-5000', 'Resposta inválida do WhatsApp Gateway.', true);
  }
  return payload as unknown as T;
}

export function fetchGatewayHealth(): Promise<GatewayHealthResponse> {
  return gwFetch<GatewayHealthResponse>('/health');
}

export function fetchGatewayReady(): Promise<GatewayReadyResponse> {
  const url = `${getGatewayBaseUrl()}/ready`;
  return fetch(url).then(async (res) => {
    const body = (await res.json().catch(() => null)) as GatewayReadyResponse | null;
    if (!body) throw new GatewayClientError(res.status, 'GW-5030', 'Gateway readiness check failed.', true);
    return body;
  });
}

export function fetchGatewayCapabilities(): Promise<GatewayCapabilitiesResponse> {
  return gwFetch<GatewayCapabilitiesResponse>('/api/v1/capabilities');
}

export function validatePhoneWithGateway(phone: string, defaultCountry: 'BR' | 'US' = 'BR'): Promise<PhoneValidationResult> {
  return gwFetch<PhoneValidationResult>('/api/v1/phones/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, defaultCountry }),
  });
}

export function requestRecipientAuthorization(phone: string): Promise<RecipientAuthorizationChallenge> {
  return gwFetch<RecipientAuthorizationChallenge>('/api/v1/recipients/authorization-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
}

export function getRecipientAuthorizationStatus(phone: string): Promise<RecipientAuthorizationStatusResponse> {
  return gwFetch<RecipientAuthorizationStatusResponse>(
    `/api/v1/recipients/authorization-status?phone=${encodeURIComponent(phone)}`,
  );
}

export function confirmRecipientAuthorizationCode(
  phone: string,
  code: string,
): Promise<RecipientAuthorizationStatusResponse> {
  return gwFetch<RecipientAuthorizationStatusResponse>('/api/v1/recipients/authorization-confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  });
}

export async function sendSoundStickerJob(params: {
  recipientPhone: string;
  visualBlob: Blob;
  visualName: string;
  audioBlob: Blob | null;
  audioName: string | null;
  shapeOptions?: Partial<StickerShapeOptions>;
  audioOptions?: StickerAudioOptions;
  accessibilityLabel?: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; deduplicated: boolean; job: StickerSendJobSummary }> {
  const form = new FormData();
  form.append('recipientPhone', params.recipientPhone);
  form.append('visual', params.visualBlob, params.visualName);
  if (params.audioBlob && params.audioName) {
    form.append('audio', params.audioBlob, params.audioName);
  }
  if (params.shapeOptions) {
    form.append('shapeOptions', JSON.stringify(params.shapeOptions));
  }
  if (params.audioOptions) {
    form.append('audioOptions', JSON.stringify(params.audioOptions));
  }
  if (params.accessibilityLabel) {
    form.append('accessibilityLabel', params.accessibilityLabel);
  }

  return gwFetch('/api/v1/stickers/send', {
    method: 'POST',
    headers: { 'Idempotency-Key': params.idempotencyKey },
    body: form,
    signal: params.signal,
  });
}

export function fetchStickerJob(jobId: string): Promise<StickerSendJobSummary> {
  return gwFetch<StickerSendJobSummary>(`/api/v1/stickers/jobs/${encodeURIComponent(jobId)}`);
}

export function cancelStickerJob(jobId: string): Promise<{ ok: true; job: StickerSendJobSummary }> {
  return gwFetch(`/api/v1/stickers/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
}

// --- Admin WhatsApp endpoints (Spec §12 canonical /api/v1/admin/* paths) ---
export function verifyGatewayAdminSecret(adminSecret: string): Promise<{ ok: boolean; authenticated: boolean }> {
  return gwFetch('/api/v1/admin/whatsapp/auth/verify', { method: 'POST' }, adminSecret);
}

export function fetchWhatsAppAdminStatus(adminSecret: string): Promise<WhatsAppConnectionSnapshot> {
  return gwFetch('/api/v1/admin/whatsapp/status', {}, adminSecret);
}

export function connectWhatsAppBot(adminSecret: string, forceNewQr = false): Promise<WhatsAppConnectionSnapshot> {
  return gwFetch(
    '/api/v1/admin/whatsapp/connect',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceNewQr }),
    },
    adminSecret,
  );
}

export function reconnectWhatsAppBot(adminSecret: string): Promise<WhatsAppConnectionSnapshot> {
  return gwFetch('/api/v1/admin/whatsapp/reconnect', { method: 'POST' }, adminSecret);
}

export function disconnectWhatsAppBot(adminSecret: string, clearSession = false): Promise<WhatsAppConnectionSnapshot> {
  return gwFetch(
    '/api/v1/admin/whatsapp/disconnect',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearSession }),
    },
    adminSecret,
  );
}

export function fetchGatewayAdminMetrics(adminSecret: string): Promise<GatewayMetricsSnapshot> {
  return gwFetch('/api/v1/admin/metrics', {}, adminSecret);
}

export function fetchGatewayRecentJobs(adminSecret: string, limit = 25): Promise<{ jobs: StickerSendJobSummary[] }> {
  return gwFetch(`/api/v1/admin/jobs?limit=${limit}`, {}, adminSecret);
}

async function consumeSseStream<T>(
  url: string,
  headers: HeadersInit,
  onEvent: (eventName: string, payload: T) => void,
  onError: (err: Error) => void,
  signal: AbortSignal,
): Promise<void> {
  try {
    const res = await fetch(url, { headers, signal });
    if (!res.ok || !res.body) {
      throw new GatewayClientError(res.status, `GW-${res.status}`, `Falha ao abrir stream SSE (${res.status}).`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = 'message';
    let dataLines: string[] = [];

    const flushEvent = () => {
      if (dataLines.length === 0) return;
      const raw = dataLines.join('\n');
      dataLines = [];
      try {
        const parsed = JSON.parse(raw) as T;
        onEvent(eventName, parsed);
      } catch {
        // ignore keepalive / malformed chunk
      }
      eventName = 'message';
    };

    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
        buffer = buffer.slice(newlineIdx + 1);
        if (line === '') {
          flushEvent();
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        }
        newlineIdx = buffer.indexOf('\n');
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export function subscribeWhatsAppAdminEvents(
  adminSecret: string,
  onEvent: (evt: WhatsAppConnectionEvent) => void,
  onError: (err: Error) => void,
  signal: AbortSignal,
): void {
  void consumeSseStream<WhatsAppConnectionEvent>(
    `${getGatewayBaseUrl()}/api/v1/admin/whatsapp/events`,
    { Authorization: `Bearer ${adminSecret}` },
    (_name, payload) => onEvent(payload),
    onError,
    signal,
  );
}

export function subscribeStickerJobEvents(
  jobId: string,
  onEvent: (evt: StickerJobEvent) => void,
  onError: (err: Error) => void,
  signal: AbortSignal,
): void {
  const token = getOptionalPublicToken();
  const headers: Record<string, string> = {};
  if (token) headers['X-Gateway-Token'] = token;

  void consumeSseStream<StickerJobEvent>(
    `${getGatewayBaseUrl()}/api/v1/stickers/jobs/${encodeURIComponent(jobId)}/events`,
    headers,
    (_name, payload) => onEvent(payload),
    onError,
    signal,
  );
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Falha ao serializar canvas.'))),
      mime,
      quality,
    );
  });
}

/**
 * Renders the Studio composition cleanly:
 * - Static sticker -> transparent 512x512 RGBA PNG (processed to WebP <= 100 KB in Gateway)
 * - Animated sticker -> sampled animated WebP frames (or original animated visual when single video/GIF)
 * - Mixed timeline audio -> lossless 48kHz WAV (processed to Ogg/Opus + waveform in Gateway)
 */
export async function renderProjectMediaForGateway(
  project: Project,
  assets: ReadonlyMap<string, StoredAsset>,
  signal: AbortSignal,
): Promise<{
  visualBlob: Blob;
  visualName: string;
  audioBlob: Blob | null;
  audioName: string | null;
}> {
  const composition = new Composition(signal);
  try {
    await composition.open(project, assets);
    const hasMotion = composition.hasMotion(project);

    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;

    let visualBlob: Blob;
    let visualName: string;

    if (!hasMotion) {
      await composition.prepare(project, 0, false);
      composition.draw(canvas, project, 0, false);
      visualBlob = await canvasToBlob(canvas, 'image/png');
      visualName = 'composition-static.png';
    } else {
      const durationMs = Math.min(10_000, Math.max(400, projectDuration(project, assets)));
      const fps = 12;
      const frameStepMs = Math.round(1000 / fps);
      const frames: { bytes: Uint8Array; duration: number }[] = [];
      let webpSupportedByCanvas = true;

      for (let t = 0; t < durationMs; t += frameStepMs) {
        signal.throwIfAborted();
        await composition.prepare(project, t, false);
        composition.draw(canvas, project, t, false);
        const frameBlob = await canvasToBlob(canvas, 'image/webp', 0.85);
        if (!frameBlob.type.includes('webp')) {
          webpSupportedByCanvas = false;
          break;
        }
        frames.push({
          bytes: new Uint8Array(await frameBlob.arrayBuffer()),
          duration: Math.min(frameStepMs, durationMs - t) || frameStepMs,
        });
      }

      if (webpSupportedByCanvas && frames.length >= 2) {
        visualBlob = webpAnimation(frames, SIZE, SIZE);
        visualName = 'composition-animated.webp';
      } else {
        // Fallback when browser lacks canvas WebP frame encoding (e.g. legacy Safari): send original animated asset
        const primaryAnimated = visualLayers(project).find(
          (l) => l.kind === 'media' && !project.hidden.includes(l.id) && assets.get(l.asset)?.blob,
        );
        if (!primaryAnimated || primaryAnimated.kind !== 'media') {
          await composition.prepare(project, 0, false);
          composition.draw(canvas, project, 0, false);
          visualBlob = await canvasToBlob(canvas, 'image/png');
          visualName = 'composition-static.png';
        } else {
          const asset = assets.get(primaryAnimated.asset)!;
          visualBlob = asset.blob;
          visualName = asset.name || 'animation.webm';
        }
      }
    }

    const mixedAudio = await mixAudio(project, assets, signal);
    let audioBlob: Blob | null = null;
    let audioName: string | null = null;
    if (mixedAudio) {
      const channels = Array.from({ length: mixedAudio.numberOfChannels }, (_, i) => mixedAudio.getChannelData(i));
      const wavBuf = pcmWav(channels, mixedAudio.sampleRate);
      audioBlob = new Blob([wavBuf], { type: 'audio/wav' });
      audioName = 'composition-mix.wav';
    }

    return { visualBlob, visualName, audioBlob, audioName };
  } finally {
    composition.close();
  }
}
