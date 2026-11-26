import { useEffect, useRef, useState } from 'react';
import {
  TERMINAL_JOB_STATUSES,
  type GatewayCapabilitiesResponse,
  type GatewayReadyResponse,
  type PhoneValidationResult,
  type RecipientAuthorizationChallenge,
  type StickerSendJobSummary,
} from '@stickerwave/contracts';
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Square,
  Volume2,
} from 'lucide-react';
import { audioTracks, visualLayers, type Project, type StoredAsset } from '../core/project';
import { Link, useApp } from '../app/context';
import { Modal, Notice } from '../app/shared';
import {
  cancelStickerJob,
  confirmRecipientAuthorizationCode,
  fetchGatewayCapabilities,
  fetchGatewayReady,
  GatewayClientError,
  getRecipientAuthorizationStatus,
  renderProjectMediaForGateway,
  requestRecipientAuthorization,
  sendSoundStickerJob,
  subscribeStickerJobEvents,
  validatePhoneWithGateway,
} from '../infrastructure/gateway';

const COUNTRY_PRESETS = [
  { code: 'BR', dial: '+55', label: 'Brasil (+55)' },
  { code: 'US', dial: '+1', label: 'EUA / Canadá (+1)' },
  { code: 'PT', dial: '+351', label: 'Portugal (+351)' },
  { code: 'AR', dial: '+54', label: 'Argentina (+54)' },
  { code: 'MX', dial: '+52', label: 'México (+52)' },
] as const;

export function SendToWhatsAppModal({
  project,
  assets,
  close,
  onFallbackLocalExport,
}: {
  project: Project;
  assets: ReadonlyMap<string, StoredAsset>;
  close: () => void;
  onFallbackLocalExport: () => void;
}) {
  const { copy } = useApp();
  const [country, setCountry] = useState<'BR' | 'US'>('BR');
  const [dialPrefix, setDialPrefix] = useState('+55');
  const [rawPhone, setRawPhone] = useState('');
  const [validation, setValidation] = useState<PhoneValidationResult | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [challenge, setChallenge] = useState<RecipientAuthorizationChallenge | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [capabilities, setCapabilities] = useState<GatewayCapabilitiesResponse | null>(null);
  const [ready, setReady] = useState<GatewayReadyResponse | null>(null);
  const [gatewayState, setGatewayState] = useState<'checking' | 'online' | 'unconfigured' | 'offline'>('checking');
  const [checkingPhone, setCheckingPhone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<StickerSendJobSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrls, setPreviewUrls] = useState<{ visual: string | null; audio: string | null }>({
    visual: null,
    audio: null,
  });
  const [playingAudio, setPlayingAudio] = useState(false);

  const renderAbort = useRef<AbortController | null>(null);
  const sseAbort = useRef<AbortController | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const renderedCacheRef = useRef<Awaited<ReturnType<typeof renderProjectMediaForGateway>> | null>(null);
  const idempKeyRef = useRef<string>('');

  async function checkGatewayConnection() {
    setGatewayState('checking');
    try {
      const [r, c] = await Promise.all([fetchGatewayReady(), fetchGatewayCapabilities().catch(() => null)]);
      setReady(r);
      setCapabilities(c);
      setGatewayState('online');
    } catch (err) {
      setReady(null);
      setCapabilities(null);
      const isNotFound = err instanceof GatewayClientError && (err.code === 'GW-4044' || err.status === 404);
      setGatewayState(isNotFound ? 'unconfigured' : 'offline');
    }
  }

  useEffect(() => {
    let active = true;
    const previewCtrl = new AbortController();
    let visualUrl: string | null = null;
    let audioUrl: string | null = null;

    void Promise.all([
      fetchGatewayReady().then(
        (r) => ({ ok: true as const, data: r }),
        (err) => ({ ok: false as const, err }),
      ),
      fetchGatewayCapabilities().catch(() => null),
    ]).then(([readyResult, caps]) => {
      if (!active) return;
      if (readyResult.ok) {
        setReady(readyResult.data);
        setCapabilities(caps);
        setGatewayState('online');
      } else {
        setReady(null);
        setCapabilities(null);
        const e = readyResult.err;
        const isNotFound = e instanceof GatewayClientError && (e.code === 'GW-4044' || e.status === 404);
        setGatewayState(isNotFound ? 'unconfigured' : 'offline');
      }
    });

    void renderProjectMediaForGateway(project, assets, previewCtrl.signal)
      .then((rendered) => {
        if (!active) return;
        renderedCacheRef.current = rendered;
        visualUrl = URL.createObjectURL(rendered.visualBlob);
        audioUrl = rendered.audioBlob ? URL.createObjectURL(rendered.audioBlob) : null;
        setPreviewUrls({ visual: visualUrl, audio: audioUrl });
      })
      .catch(() => undefined);

    return () => {
      active = false;
      previewCtrl.abort();
      renderAbort.current?.abort();
      sseAbort.current?.abort();
      audioElRef.current?.pause();
      if (visualUrl) URL.revokeObjectURL(visualUrl);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [project, assets]);

  useEffect(() => {
    if (!job || TERMINAL_JOB_STATUSES.has(job.status)) return;
    const ctrl = new AbortController();
    sseAbort.current = ctrl;

    subscribeStickerJobEvents(
      job.id,
      (evt) => {
        setJob(evt.job);
      },
      () => undefined,
      ctrl.signal,
    );

    return () => {
      ctrl.abort();
    };
  }, [job?.id]);

  function composePhoneInput(): string {
    const clean = rawPhone.trim();
    if (!clean) return '';
    return clean.startsWith('+') || clean.startsWith('00') ? clean : `${dialPrefix} ${clean}`;
  }

  async function handleValidateAndCheckAuth() {
    const candidate = composePhoneInput();
    if (!candidate) {
      setError(copy.waSendInvalidPhone);
      return;
    }
    setCheckingPhone(true);
    setError(null);
    setChallenge(null);
    try {
      const val = await validatePhoneWithGateway(candidate, country);
      setValidation(val);
      if (!val.valid || !val.e164) {
        setAuthorized(false);
        setError(val.reason || copy.waSendInvalidPhone);
        return;
      }
      const status = await getRecipientAuthorizationStatus(val.e164);
      setAuthorized(status.authorized);
      if (!status.authorized) {
        const issued = await requestRecipientAuthorization(val.e164);
        setChallenge(issued);
        setAuthorized(issued.authorized);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.waGatewayOffline);
    } finally {
      setCheckingPhone(false);
    }
  }

  async function handleCheckAuthPolling() {
    if (!validation?.e164) return;
    setCheckingPhone(true);
    setError(null);
    try {
      const status = await getRecipientAuthorizationStatus(validation.e164);
      setAuthorized(status.authorized);
      if (!status.authorized && manualCode.trim().length >= 4) {
        const confirmed = await confirmRecipientAuthorizationCode(validation.e164, manualCode.trim());
        setAuthorized(confirmed.authorized);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.waSendAuthNotConfirmed);
    } finally {
      setCheckingPhone(false);
    }
  }

  async function handleConfirmManualCode(e: React.FormEvent) {
    e.preventDefault();
    if (!validation?.e164 || !manualCode.trim()) return;
    setCheckingPhone(true);
    setError(null);
    try {
      const res = await confirmRecipientAuthorizationCode(validation.e164, manualCode.trim());
      setAuthorized(res.authorized);
      if (res.authorized) setChallenge(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.waSendAuthNotConfirmed);
    } finally {
      setCheckingPhone(false);
    }
  }

  async function handleSend() {
    if (!validation?.valid || !validation.e164) {
      setError(copy.waSendValidateFirst);
      return;
    }
    if (!authorized) {
      setError(copy.waSendAuthorizeFirst);
      return;
    }
    setSubmitting(true);
    setError(null);
    const ctrl = new AbortController();
    renderAbort.current = ctrl;

    try {
      if (!idempKeyRef.current) {
        idempKeyRef.current = crypto.randomUUID();
      }
      const rendered =
        renderedCacheRef.current ?? (await renderProjectMediaForGateway(project, assets, ctrl.signal));
      renderedCacheRef.current = rendered;
      if (!rendered.audioBlob) {
        throw new Error(copy.waSendAudioRequired);
      }

      const textOverlay = visualLayers(project)
        .filter((l) => !project.hidden.includes(l.id))
        .map((l) => (l.kind === 'text' ? l.style.content : ''))
        .filter(Boolean)
        .join(' ');

      const enqueued = await sendSoundStickerJob({
        recipientPhone: validation.e164,
        visualBlob: rendered.visualBlob,
        visualName: rendered.visualName,
        audioBlob: rendered.audioBlob,
        audioName: rendered.audioName,
        shapeOptions: {
          shape: project.stickerShape ?? 'square',
          borderWhite: Boolean(project.stickerBorder),
          background: project.background ?? null,
        },
        accessibilityLabel: textOverlay || project.name,
        idempotencyKey: idempKeyRef.current,
        signal: ctrl.signal,
      });

      setJob(enqueued.job);
    } catch (err) {
      const msg =
        err instanceof GatewayClientError
          ? `[${err.code}] ${err.message}`
          : err instanceof Error
            ? err.message
            : copy.waGatewayOffline;
      setError(msg);
      idempKeyRef.current = '';
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancelJob() {
    if (!job) return;
    try {
      const res = await cancelStickerJob(job.id);
      setJob(res.job);
      idempKeyRef.current = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.waGatewayOffline);
    }
  }

  const audioTrackCount = audioTracks(project).filter((t) => !t.style.muted).length;
  const gatewayMissing = gatewayState === 'unconfigured' || gatewayState === 'offline';
  const botDisabled = Boolean(capabilities && capabilities.whatsappBotEnabled === false);
  const botOffline = Boolean(!botDisabled && gatewayState === 'online' && ready && (!ready.ready || !ready.whatsappConnected));
  const featureDisabled = Boolean(capabilities && (!capabilities.soundStickersEnabled || capabilities.whatsappBotEnabled === false));
  const inputsDisabled = gatewayMissing || botDisabled;
  const canCancel = Boolean(
    job && !TERMINAL_JOB_STATUSES.has(job.status) && job.status !== 'UPLOADING' && job.status !== 'SENDING',
  );

  function togglePreviewAudio() {
    if (!previewUrls.audio) return;
    if (playingAudio && audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.currentTime = 0;
      setPlayingAudio(false);
      return;
    }
    const audio = audioElRef.current ?? new Audio(previewUrls.audio);
    audio.src = previewUrls.audio;
    audio.onended = () => setPlayingAudio(false);
    audioElRef.current = audio;
    void audio.play().then(() => setPlayingAudio(true)).catch(() => setPlayingAudio(false));
  }

  return (
    <Modal title={copy.waSendModalTitle} close={close} className="export-dialog wa-send-modal">
      <div className="wa-send-preview">
        {previewUrls.visual && <img src={previewUrls.visual} alt={copy.waSendPreviewVisualAlt} width={76} height={76} />}
        <div className="wa-send-preview-meta">
          <div className="wa-send-summary">
            <span className="wa-send-chip">
              <Volume2 size={15} />
              {project.name} · {audioTrackCount} {audioTrackCount === 1 ? 'faixa' : 'faixas'}
            </span>
            {gatewayState === 'online' && ready && (
              <span className={`wa-badge wa-badge-${ready.whatsappConnected ? 'ok' : 'warn'}`}>
                {ready.whatsappConnected ? copy.waSendBotOnline : copy.waSendBotOfflineBadge}
              </span>
            )}
            {gatewayState === 'checking' && (
              <span className="wa-badge wa-badge-warn">
                <Loader2 size={13} className="spin" />
                {copy.waSendCheckingGateway}
              </span>
            )}
            {gatewayMissing && (
              <span className="wa-badge wa-badge-err">{copy.waSendGatewayMissingBadge}</span>
            )}
          </div>
          {previewUrls.audio && (
            <button type="button" className="button button-outline button-small" onClick={togglePreviewAudio}>
              {playingAudio ? <Square size={14} /> : <Play size={14} />}
              {playingAudio ? copy.waSendStopAudio : copy.waSendPlayAudio}
            </button>
          )}
        </div>
      </div>

      <p className="inspector-note">{copy.waSendPrivacyNote}</p>

      {(gatewayMissing || botOffline || featureDisabled) && (
        <Notice error={!botDisabled}>
          <div>
            {botDisabled
              ? copy.waSendBotDisabled
              : featureDisabled
                ? copy.waSendFeatureDisabled
                : gatewayState === 'unconfigured'
                  ? copy.waSendGatewayNotConfigured
                  : gatewayState === 'offline'
                    ? copy.waGatewayOffline
                    : copy.waSendBotNotReady}
          </div>
          <div className="button-row" style={{ marginTop: 8 }}>
            <button type="button" className="button button-small button-outline" onClick={() => void checkGatewayConnection()}>
              <RefreshCw size={14} />
              {copy.retry}
            </button>
            {!botDisabled && (
              <Link className="button button-small button-outline" href="/whatsapp" onClick={close}>
                {copy.waSendOpenAdminSetup}
              </Link>
            )}
            <button type="button" className="button button-small button-green" onClick={onFallbackLocalExport}>
              {copy.waSendUseLocalExport}
            </button>
          </div>
        </Notice>
      )}

      {!audioTrackCount && <Notice error>{copy.waSendAudioRequired}</Notice>}

      <div className="wa-phone-row">
        <label className="auth-field">
          <span>{copy.waSendCountryLabel}</span>
          <select
            disabled={inputsDisabled}
            value={dialPrefix}
            onChange={(e) => {
              const dial = e.target.value;
              setDialPrefix(dial);
              setCountry(dial === '+1' ? 'US' : 'BR');
              setValidation(null);
              setAuthorized(false);
              setChallenge(null);
            }}
          >
            {COUNTRY_PRESETS.map((p) => (
              <option key={p.code} value={p.dial}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="auth-field">
          <span>{copy.waSendPhoneLabel}</span>
          <div className="wa-phone-input-group">
            <input
              type="tel"
              inputMode="tel"
              disabled={inputsDisabled}
              placeholder="11 99999-8888"
              value={rawPhone}
              onChange={(e) => {
                setRawPhone(e.target.value);
                setValidation(null);
                setAuthorized(false);
                setChallenge(null);
                idempKeyRef.current = '';
              }}
            />
            <button
              type="button"
              className="button button-outline"
              disabled={inputsDisabled || gatewayState === 'checking' || checkingPhone || !rawPhone.trim()}
              onClick={() => void handleValidateAndCheckAuth()}
            >
              {checkingPhone ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />}
              {copy.waSendVerifyButton}
            </button>
          </div>
          {validation?.valid && (
            <small>
              E.164: <strong>{validation.e164}</strong> ({validation.masked})
            </small>
          )}
        </label>
      </div>

      {validation?.valid && authorized && (
        <Notice>
          <span className="wa-inline-icon">
            <CheckCircle2 size={16} />
            {copy.waSendAuthorizedReady}
          </span>
        </Notice>
      )}

      {validation?.valid && !authorized && challenge && (
        <div className="wa-optin-box">
          <strong>{copy.waSendOptInTitle}</strong>
          <p>{challenge.instructions}</p>
          <div className="wa-code-banner">
            <code>{challenge.code}</code>
            {challenge.waMeUrl && (
              <a
                className="button button-green button-small"
                href={challenge.waMeUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={15} />
                {copy.waSendOpenWaOptIn}
              </a>
            )}
            <button
              type="button"
              className="button button-outline button-small"
              disabled={checkingPhone}
              onClick={() => void handleCheckAuthPolling()}
            >
              <RefreshCw size={14} />
              {copy.waSendRefreshAuth}
            </button>
          </div>
          <form className="wa-manual-confirm" onSubmit={(e) => void handleConfirmManualCode(e)}>
            <input
              type="text"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value.toUpperCase())}
              placeholder={copy.waSendManualCodePlaceholder}
              maxLength={12}
            />
            <button type="submit" className="button button-outline button-small" disabled={checkingPhone || !manualCode.trim()}>
              {copy.waSendConfirmCodeBtn}
            </button>
          </form>
        </div>
      )}

      {job && (
        <div className="wa-job-progress">
          <div className="wa-job-head">
            <strong>
              {job.status === 'SENT' || job.status === 'DELIVERED' ? (
                <CheckCircle2 size={16} />
              ) : job.status === 'FAILED' || job.status === 'CANCELLED' ? (
                <AlertCircle size={16} />
              ) : (
                <Loader2 size={16} className="spin" />
              )}
              {job.status} · {job.progress}%
            </strong>
            <span>{job.recipientMasked}</span>
          </div>
          <progress max={100} value={job.progress} className="wa-progress-bar" />
          <p>{job.stageLabel}</p>
          {job.webpBytes && job.oggBytes && (
            <small>
              WebP: {Math.round(job.webpBytes / 1024)} KB · Opus: {Math.round(job.oggBytes / 1024)} KB
              {job.waMessageId ? ` · WA ID: ${job.waMessageId.slice(0, 14)}` : ''}
            </small>
          )}
          {job.errorMessage && <Notice error>{job.errorCode ? `[${job.errorCode}] ` : ''}{job.errorMessage}</Notice>}
        </div>
      )}

      {error && <Notice error>{error}</Notice>}

      <div className="dialog-actions">
        {canCancel && (
          <button type="button" className="button button-danger" onClick={() => void handleCancelJob()}>
            <Ban size={16} />
            {copy.cancel}
          </button>
        )}
        <button
          type="button"
          className="button button-green"
          disabled={
            gatewayMissing ||
            submitting ||
            !validation?.valid ||
            !authorized ||
            !audioTrackCount ||
            botOffline ||
            featureDisabled ||
            Boolean(job && !TERMINAL_JOB_STATUSES.has(job.status))
          }
          onClick={() => void handleSend()}
        >
          <Send size={16} />
          {submitting ? copy.waSendSending : copy.waSendSubmitButton}
        </button>
      </div>
    </Modal>
  );
}
