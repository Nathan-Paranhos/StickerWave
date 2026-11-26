import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GatewayCapabilitiesResponse,
  GatewayMetricsSnapshot,
  GatewayReadyResponse,
  StickerSendJobSummary,
  WhatsAppConnectionSnapshot,
  WhatsAppConnectionStatus,
} from '@stickerwave/contracts';
import {
  Activity,
  CheckCircle2,
  Eye,
  EyeOff,
  LogOut,
  Power,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useApp } from '../app/context';
import { Notice } from '../app/shared';
import {
  connectWhatsAppBot,
  disconnectWhatsAppBot,
  fetchGatewayAdminMetrics,
  fetchGatewayCapabilities,
  fetchGatewayReady,
  fetchGatewayRecentJobs,
  fetchWhatsAppAdminStatus,
  GatewayClientError,
  getLocalGatewayUrlOverride,
  publishPublicGatewayUrl,
  reconnectWhatsAppBot,
  resolveGatewayBaseUrl,
  setLocalGatewayUrlOverride,
  subscribeWhatsAppAdminEvents,
  verifyGatewayAdminSecret,
} from '../infrastructure/gateway';

const ADMIN_SECRET_STORAGE_KEY = 'sw_gw_admin_secret';

function readStoredAdminSecret(): string {
  try {
    return sessionStorage.getItem(ADMIN_SECRET_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveStoredAdminSecret(secret: string | null) {
  try {
    if (secret) sessionStorage.setItem(ADMIN_SECRET_STORAGE_KEY, secret);
    else sessionStorage.removeItem(ADMIN_SECRET_STORAGE_KEY);
  } catch {
    // sessionStorage unavailable
  }
}

const STATUS_BADGE_MAP: Record<WhatsAppConnectionStatus, { pt: string; en: string; tone: 'ok' | 'warn' | 'err' }> = {
  CONNECTED: { pt: 'Conectado', en: 'Connected', tone: 'ok' },
  WAITING_QR: { pt: 'Aguardando QR Code', en: 'Waiting for QR scan', tone: 'warn' },
  CONNECTING: { pt: 'Conectando', en: 'Connecting', tone: 'warn' },
  RECONNECTING: { pt: 'Reconectando', en: 'Reconnecting', tone: 'warn' },
  DISCONNECTED: { pt: 'Desconectado', en: 'Disconnected', tone: 'err' },
  LOGGED_OUT: { pt: 'Sessão encerrada', en: 'Logged out', tone: 'err' },
  ERROR: { pt: 'Erro', en: 'Error', tone: 'err' },
};

export function WhatsAppAdminPage() {
  const { copy, locale } = useApp();
  const [gatewayUrlInput, setGatewayUrlInput] = useState(() => getLocalGatewayUrlOverride() || '/gateway');
  const [publishUrlToSite, setPublishUrlToSite] = useState(false);
  const [secretInput, setSecretInput] = useState(readStoredAdminSecret);
  const [adminSecret, setAdminSecret] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const [snapshot, setSnapshot] = useState<WhatsAppConnectionSnapshot | null>(null);
  const [readyState, setReadyState] = useState<GatewayReadyResponse | null>(null);
  const [capabilities, setCapabilities] = useState<GatewayCapabilitiesResponse | null>(null);
  const [metrics, setMetrics] = useState<GatewayMetricsSnapshot | null>(null);
  const [jobs, setJobs] = useState<StickerSendJobSummary[]>([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const sseAbort = useRef<AbortController | null>(null);

  const loadDashboard = useCallback(async (token: string) => {
    try {
      const [statusSnap, readyInfo, capInfo, metricInfo, jobList] = await Promise.all([
        fetchWhatsAppAdminStatus(token),
        fetchGatewayReady().catch(() => null),
        fetchGatewayCapabilities().catch(() => null),
        fetchGatewayAdminMetrics(token),
        fetchGatewayRecentJobs(token, 20),
      ]);
      setSnapshot(statusSnap);
      if (readyInfo) setReadyState(readyInfo);
      if (capInfo) setCapabilities(capInfo);
      setMetrics(metricInfo);
      setJobs(jobList.jobs);
      setOpError(null);
    } catch (err) {
      if (err instanceof GatewayClientError && err.status === 401) {
        saveStoredAdminSecret(null);
        setAdminSecret(null);
        setAuthError(copy.waAdminInvalidSecret);
        return;
      }
      setOpError(err instanceof Error ? err.message : copy.waGatewayOffline);
    }
  }, [copy.waAdminInvalidSecret, copy.waGatewayOffline]);

  // Verify existing sessionStorage secret and discover configured gateway URL on mount
  useEffect(() => {
    let mounted = true;
    void resolveGatewayBaseUrl().then((resolved) => {
      if (!mounted) return;
      setGatewayUrlInput(resolved);
      if (resolved.startsWith('https://')) setPublishUrlToSite(true);
    });

    const initial = readStoredAdminSecret();
    if (!initial) return () => {
      mounted = false;
    };
    void verifyGatewayAdminSecret(initial)
      .then(() => {
        if (!mounted) return;
        setAdminSecret(initial);
        void loadDashboard(initial);
      })
      .catch(() => {
        if (!mounted) return;
        saveStoredAdminSecret(null);
        setAdminSecret(null);
      });
    return () => {
      mounted = false;
    };
  }, [loadDashboard]);

  // Keep live SSE subscription open while authenticated
  useEffect(() => {
    if (!adminSecret) return;
    const ctrl = new AbortController();
    sseAbort.current = ctrl;

    subscribeWhatsAppAdminEvents(
      adminSecret,
      (evt) => {
        if (evt.type === 'snapshot') {
          setSnapshot(evt.snapshot);
        } else if (evt.type === 'qr') {
          setSnapshot((prev) =>
            prev
              ? {
                  ...prev,
                  status: 'WAITING_QR',
                  qrCodeDataUrl: evt.qrCodeDataUrl,
                  qrExpiresAt: evt.qrExpiresAt,
                  qrGeneration: evt.qrGeneration,
                }
              : prev,
          );
        } else if (evt.type === 'status') {
          void loadDashboard(adminSecret);
        }
      },
      (err) => {
        setOpError(err.message);
      },
      ctrl.signal,
    );

    const poll = setInterval(() => {
      void fetchGatewayAdminMetrics(adminSecret).then(setMetrics).catch(() => undefined);
      void fetchGatewayRecentJobs(adminSecret, 20).then((r) => setJobs(r.jobs)).catch(() => undefined);
    }, 8_000);

    return () => {
      ctrl.abort();
      clearInterval(poll);
    };
  }, [adminSecret, loadDashboard]);

  async function handleAdminSignIn(e: React.FormEvent) {
    e.preventDefault();
    if (!secretInput.trim()) return;
    setAuthBusy(true);
    setAuthError(null);
    const urlTrimmed = gatewayUrlInput.trim() || '/gateway';
    const secret = secretInput.trim();
    try {
      setLocalGatewayUrlOverride(urlTrimmed === '/gateway' ? null : urlTrimmed);
      await verifyGatewayAdminSecret(secret);
      if (publishUrlToSite && urlTrimmed !== '/gateway') {
        await publishPublicGatewayUrl(urlTrimmed, secret);
      }
      saveStoredAdminSecret(secret);
      setAdminSecret(secret);
      await loadDashboard(secret);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : copy.waAdminInvalidSecret);
    } finally {
      setAuthBusy(false);
    }
  }

  function handleAdminSignOut() {
    sseAbort.current?.abort();
    saveStoredAdminSecret(null);
    setAdminSecret(null);
    setSnapshot(null);
    setMetrics(null);
    setJobs([]);
  }

  async function runConnectionAction(fn: (secret: string) => Promise<WhatsAppConnectionSnapshot>) {
    if (!adminSecret) return;
    setActionBusy(true);
    setOpError(null);
    try {
      const next = await fn(adminSecret);
      setSnapshot(next);
      await loadDashboard(adminSecret);
    } catch (err) {
      setOpError(err instanceof Error ? err.message : copy.waGatewayOffline);
    } finally {
      setActionBusy(false);
    }
  }

  if (!adminSecret) {
    return (
      <section className="wrap page auth-page">
        <div className="auth-card">
          <p className="eyebrow">
            <ShieldCheck size={16} />
            {copy.waAdminEyebrow}
          </p>
          <h1>{copy.waAdminTitle}</h1>
          <p className="page-intro">{copy.waAdminAuthSubtitle}</p>
          <form className="auth-form" onSubmit={(e) => void handleAdminSignIn(e)}>
            <label className="auth-field">
              <span>{copy.waAdminGatewayUrlLabel}</span>
              <input
                type="text"
                value={gatewayUrlInput}
                onChange={(e) => {
                  const val = e.target.value;
                  setGatewayUrlInput(val);
                  if (val.trim().startsWith('https://')) setPublishUrlToSite(true);
                }}
                placeholder="/gateway ou https://seu-gateway.onrender.com"
              />
              <small>{copy.waAdminGatewayUrlHint}</small>
            </label>
            {gatewayUrlInput.trim().startsWith('http') && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={publishUrlToSite}
                  onChange={(e) => setPublishUrlToSite(e.target.checked)}
                />
                <span>{copy.waAdminPublishSiteUrl}</span>
              </label>
            )}
            <label className="auth-field">
              <span>{copy.waAdminSecretLabel}</span>
              <div className="password-wrap">
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={secretInput}
                  onChange={(e) => setSecretInput(e.target.value)}
                  placeholder="GATEWAY_ADMIN_SECRET"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="password-eye"
                  aria-label={showSecret ? copy.hidePassword : copy.showPassword}
                  onClick={() => setShowSecret((v) => !v)}
                >
                  {showSecret ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              <small>{copy.waAdminSecretHint}</small>
            </label>
            {authError && <Notice error>{authError}</Notice>}
            <button type="submit" className="button button-green full" disabled={authBusy}>
              <ShieldCheck size={17} />
              {authBusy ? copy.checkingAccount : copy.waAdminUnlock}
            </button>
            <p className="auth-note">{copy.waAdminSetupTip}</p>
          </form>
        </div>
      </section>
    );
  }

  const badge = snapshot ? STATUS_BADGE_MAP[snapshot.status] : STATUS_BADGE_MAP.DISCONNECTED;

  return (
    <section className="wrap page wa-admin-page">
      <div className="wa-admin-header">
        <div>
          <p className="eyebrow">
            <Smartphone size={16} />
            {copy.waAdminEyebrow}
          </p>
          <h1>{copy.waAdminTitle}</h1>
          <p className="page-intro">{copy.waAdminSubtitle}</p>
        </div>
        <div className="button-row">
          <button type="button" className="button button-outline" onClick={() => void loadDashboard(adminSecret)}>
            <RefreshCw size={16} />
            {copy.waAdminRefresh}
          </button>
          <button type="button" className="button button-outline" onClick={handleAdminSignOut}>
            <LogOut size={16} />
            {copy.signOut}
          </button>
        </div>
      </div>

      {opError && <Notice error>{opError}</Notice>}

      <div className="wa-admin-grid">
        <article className="wa-card">
          <div className="wa-card-head">
            <h2>{copy.waAdminBotStatusTitle}</h2>
            <span className={`wa-badge wa-badge-${badge.tone}`}>
              {snapshot?.status === 'CONNECTED' ? <Wifi size={14} /> : <WifiOff size={14} />}
              {locale === 'pt' ? badge.pt : badge.en}
            </span>
          </div>

          <dl className="wa-meta-list">
            <div>
              <dt>{copy.waAdminConnectedNumber}</dt>
              <dd>{snapshot?.connectedPhoneMasked || copy.waAdminNone}</dd>
            </div>
            <div>
              <dt>{copy.waAdminBotName}</dt>
              <dd>{snapshot?.connectedPushName || copy.waAdminNone}</dd>
            </div>
            <div>
              <dt>{copy.waAdminSessionSaved}</dt>
              <dd>{snapshot?.sessionPersisted ? copy.waAdminEncryptedActive : copy.waAdminNoSession}</dd>
            </div>
            <div>
              <dt>{copy.waAdminConnectedSince}</dt>
              <dd>{snapshot?.connectedAt ? new Date(snapshot.connectedAt).toLocaleString(locale) : '—'}</dd>
            </div>
          </dl>

          {snapshot?.lastError && (
            <Notice error>
              {snapshot.lastErrorCode ? `[${snapshot.lastErrorCode}] ` : ''}
              {snapshot.lastError}
            </Notice>
          )}

          <div className="button-row wa-admin-actions">
            {snapshot?.status !== 'CONNECTED' && (
              <button
                type="button"
                className="button button-green"
                disabled={actionBusy}
                onClick={() => void runConnectionAction((s) => connectWhatsAppBot(s, false))}
              >
                <QrCode size={17} />
                {copy.waAdminConnectQr}
              </button>
            )}
            <button
              type="button"
              className="button button-outline"
              disabled={actionBusy}
              onClick={() => void runConnectionAction((s) => reconnectWhatsAppBot(s))}
            >
              <RefreshCw size={16} />
              {copy.waAdminReconnect}
            </button>
            <button
              type="button"
              className="button button-outline"
              disabled={actionBusy}
              onClick={() => void runConnectionAction((s) => connectWhatsAppBot(s, true))}
            >
              <QrCode size={16} />
              {copy.waAdminForceQr}
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={actionBusy}
              onClick={() => void runConnectionAction((s) => disconnectWhatsAppBot(s, true))}
            >
              <Power size={16} />
              {copy.waAdminDisconnectClear}
            </button>
          </div>
        </article>

        <article className="wa-card wa-qr-card">
          <div className="wa-card-head">
            <h2>{copy.waAdminQrTitle}</h2>
            {snapshot?.qrGeneration ? <small>QR #{snapshot.qrGeneration}</small> : null}
          </div>
          {snapshot?.status === 'WAITING_QR' && snapshot.qrCodeDataUrl ? (
            <div className="wa-qr-box">
              <img src={snapshot.qrCodeDataUrl} alt={copy.waAdminQrAlt} width={260} height={260} />
              <p>{copy.waAdminQrInstructions}</p>
              {snapshot.qrExpiresAt && (
                <small>
                  {copy.waAdminQrExpires}: {new Date(snapshot.qrExpiresAt).toLocaleTimeString(locale)}
                </small>
              )}
            </div>
          ) : snapshot?.status === 'CONNECTED' ? (
            <div className="wa-qr-placeholder">
              <CheckCircle2 size={42} />
              <p>{copy.waAdminAlreadyPaired}</p>
            </div>
          ) : (
            <div className="wa-qr-placeholder">
              <QrCode size={42} />
              <p>{copy.waAdminQrEmpty}</p>
            </div>
          )}
        </article>

        <article className="wa-card">
          <div className="wa-card-head">
            <h2>{copy.waAdminHealthTitle}</h2>
            <Activity size={18} />
          </div>
          <dl className="wa-meta-list">
            <div>
              <dt>FFmpeg / LibWebP / LibOpus</dt>
              <dd>
                {readyState?.ffmpegReady
                  ? `OK (${capabilities?.encoders.libwebp ? 'WebP' : '-'} + ${capabilities?.encoders.libopus ? 'Opus' : '-'})`
                  : copy.waAdminUnavailable}
              </dd>
            </div>
            <div>
              <dt>Protocolo Field #26</dt>
              <dd>
                {capabilities?.protocolField26Supported
                  ? `${capabilities.protocolMode} (Baileys ${capabilities.baileysVersion})`
                  : copy.waAdminUnavailable}
              </dd>
            </div>
            <div>
              <dt>Feature Flag ENABLE_SOUND_STICKERS</dt>
              <dd>{capabilities?.soundStickersEnabled ? 'ON' : 'OFF'}</dd>
            </div>
            <div>
              <dt>SQLite Persistente</dt>
              <dd>{readyState?.sqliteReady ? 'OK (WAL)' : copy.waAdminUnavailable}</dd>
            </div>
          </dl>
        </article>

        <article className="wa-card">
          <div className="wa-card-head">
            <h2>{copy.waAdminMetricsTitle}</h2>
          </div>
          <div className="wa-metric-grid">
            <div>
              <strong>{metrics?.totalJobs ?? 0}</strong>
              <span>{copy.waMetricTotal}</span>
            </div>
            <div>
              <strong>{(metrics?.queuedJobs ?? 0) + (metrics?.processingJobs ?? 0)}</strong>
              <span>{copy.waMetricActive}</span>
            </div>
            <div>
              <strong>{(metrics?.sentJobs ?? 0) + (metrics?.deliveredJobs ?? 0)}</strong>
              <span>{copy.waMetricDelivered}</span>
            </div>
            <div>
              <strong>{metrics?.failedJobs ?? 0}</strong>
              <span>{copy.waMetricFailed}</span>
            </div>
            <div>
              <strong>{metrics?.authorizedRecipients ?? 0}</strong>
              <span>{copy.waMetricOptIns}</span>
            </div>
            <div>
              <strong>{metrics?.averageProcessingMs ? `${metrics.averageProcessingMs} ms` : '—'}</strong>
              <span>{copy.waMetricAvgTime}</span>
            </div>
          </div>
        </article>
      </div>

      <article className="wa-card wa-jobs-card">
        <div className="wa-card-head">
          <h2>{copy.waAdminRecentJobs}</h2>
          <small>{copy.waAdminMaskedNotice}</small>
        </div>
        {jobs.length === 0 ? (
          <p className="page-intro">{copy.waAdminNoJobs}</p>
        ) : (
          <div className="wa-table-wrap">
            <table className="wa-jobs-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{copy.waColRecipient}</th>
                  <th>{copy.waColStatus}</th>
                  <th>{copy.waColSize}</th>
                  <th>{copy.waColStage}</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td><code>{job.id.slice(0, 8)}</code></td>
                    <td>{job.recipientMasked}</td>
                    <td><strong>{job.status}</strong> ({job.deliveryAckStatus})</td>
                    <td>
                      {job.webpBytes ? `${Math.round(job.webpBytes / 1024)} KB` : '—'} /{' '}
                      {job.oggBytes ? `${Math.round(job.oggBytes / 1024)} KB` : '—'}
                    </td>
                    <td>{job.errorCode ? `[${job.errorCode}] ${job.errorMessage}` : job.stageLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>
    </section>
  );
}
