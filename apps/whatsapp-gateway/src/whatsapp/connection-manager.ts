import { EventEmitter } from 'node:events';
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeWASocket,
  type AuthenticationState,
  type BaileysEventEmitter,
  type ConnectionState,
  type proto,
  type WAMessage,
  type WAMessageUpdate,
} from '@whiskeysockets/baileys';
import { proto as waProto } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import type {
  WhatsAppConnectionEvent,
  WhatsAppConnectionSnapshot,
  WhatsAppConnectionStatus,
} from '@stickerwave/contracts';
import type { GatewayConfig } from '../config.js';
import type { GatewayLogger } from '../logger.js';
import { maskJid, maskPhone } from '../utils/mask.js';
import { e164ToWhatsAppJid, normalizeJidDigits } from '../utils/phone.js';
import type { EncryptedSessionStore } from './session-store.js';
import { inspectRawStickerAudio, SoundStickerProtocol, type SoundStickerPayloadInput } from './sound-sticker-protocol.js';

export interface MinimalWASocket {
  ev: BaileysEventEmitter;
  user?: { id?: string; lid?: string; name?: string } | undefined;
  waUploadToServer: Parameters<typeof SoundStickerProtocol.prototype.sendSoundSticker>[0]['upload'];
  relayMessage: (jid: string, message: proto.IMessage, options: { messageId: string }) => Promise<string>;
  sendMessage?: (jid: string, content: { text: string }) => Promise<unknown>;
  onWhatsApp: (...phones: string[]) => Promise<Array<{ jid: string; exists: boolean }> | undefined>;
  logout: (msg?: string) => Promise<void>;
  end: (error?: Error) => void | Promise<void>;
}

export type WASocketFactory = (params: {
  auth: AuthenticationState;
  version: [number, number, number];
}) => MinimalWASocket;

export interface IncomingTextMessageEvent {
  senderJid: string;
  senderPhoneAltJid?: string;
  text: string;
  pushName?: string;
}

export interface DeliveryAckEvent {
  waMessageId: string;
  ack: 'server' | 'device' | 'read';
}

function extractTextFromWAMessage(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  if (typeof m.conversation === 'string' && m.conversation.trim()) return m.conversation;
  if (typeof m.extendedTextMessage?.text === 'string' && m.extendedTextMessage.text.trim()) {
    return m.extendedTextMessage.text;
  }
  return null;
}

function mapWaStatusToAck(status: number | null | undefined): DeliveryAckEvent['ack'] | null {
  if (status === undefined || status === null) return null;
  // WAMessageStatus: PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5
  if (status >= 4) return 'read';
  if (status === 3) return 'device';
  if (status === 2) return 'server';
  return null;
}

export class WhatsAppConnectionManager {
  private readonly emitter = new EventEmitter();
  private sock: MinimalWASocket | null = null;
  private connectInFlight: Promise<WhatsAppConnectionSnapshot> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualDisconnect = false;
  private shuttingDown = false;
  private status: WhatsAppConnectionStatus = 'DISCONNECTED';
  private qrCodeDataUrl: string | null = null;
  private qrExpiresAt: string | null = null;
  private qrGeneration = 0;
  private connectedPhoneDigits: string | null = null;
  private connectedPushName: string | null = null;
  private connectedAt: string | null = null;
  private lastError: string | null = null;
  private lastErrorCode: string | null = null;
  private reconnectAttempts = 0;
  private sessionPersisted = false;
  private updatedAt = new Date().toISOString();

  private readonly incomingHandlers = new Set<(evt: IncomingTextMessageEvent) => Promise<string | null | void>>();
  private readonly ackHandlers = new Set<(evt: DeliveryAckEvent) => void>();

  constructor(
    private readonly config: GatewayConfig,
    private readonly sessionStore: EncryptedSessionStore,
    private readonly protocol: SoundStickerProtocol,
    private readonly logger: GatewayLogger,
    private readonly socketFactory?: WASocketFactory,
    private readonly fetchVersionFn: typeof fetchLatestBaileysVersion = fetchLatestBaileysVersion,
  ) {}

  async init(): Promise<void> {
    this.sessionPersisted = await this.sessionStore.hasPersistedSession();
    if (this.sessionPersisted) {
      this.logger.info('Persisted encrypted WhatsApp session detected; reconnecting central bot.');
      void this.connect().catch((err) => {
        this.logger.warn('Auto-reconnect at startup did not finish immediately.', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  getBotPhoneDigits(): string | null {
    return this.connectedPhoneDigits || this.config.waBotPhoneHint || null;
  }

  getSnapshot(): WhatsAppConnectionSnapshot {
    return {
      status: this.status,
      connectedPhoneMasked: this.connectedPhoneDigits ? maskPhone(`+${this.connectedPhoneDigits}`) : null,
      connectedPushName: this.connectedPushName,
      botWaMePhone: this.getBotPhoneDigits(),
      qrCodeDataUrl: this.qrCodeDataUrl,
      qrExpiresAt: this.qrExpiresAt,
      qrGeneration: this.qrGeneration,
      lastError: this.lastError,
      lastErrorCode: this.lastErrorCode,
      reconnectAttempts: this.reconnectAttempts,
      sessionPersisted: this.sessionPersisted,
      connectedAt: this.connectedAt,
      updatedAt: this.updatedAt,
    };
  }

  subscribe(listener: (event: WhatsAppConnectionEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }

  onIncomingText(handler: (evt: IncomingTextMessageEvent) => Promise<string | null | void>): () => void {
    this.incomingHandlers.add(handler);
    return () => this.incomingHandlers.delete(handler);
  }

  onDeliveryAck(handler: (evt: DeliveryAckEvent) => void): () => void {
    this.ackHandlers.add(handler);
    return () => this.ackHandlers.delete(handler);
  }

  private emit(event: WhatsAppConnectionEvent): void {
    this.emitter.emit('event', event);
  }

  private setState(
    status: WhatsAppConnectionStatus,
    patch: Partial<{
      qrCodeDataUrl: string | null;
      qrExpiresAt: string | null;
      lastError: string | null;
      lastErrorCode: string | null;
      connectedAt: string | null;
    }> = {},
    reason?: string,
  ): void {
    this.status = status;
    this.updatedAt = new Date().toISOString();
    if ('qrCodeDataUrl' in patch) this.qrCodeDataUrl = patch.qrCodeDataUrl ?? null;
    if ('qrExpiresAt' in patch) this.qrExpiresAt = patch.qrExpiresAt ?? null;
    if ('lastError' in patch) this.lastError = patch.lastError ?? null;
    if ('lastErrorCode' in patch) this.lastErrorCode = patch.lastErrorCode ?? null;
    if ('connectedAt' in patch) this.connectedAt = patch.connectedAt ?? null;

    this.emit({ type: 'status', status, reason, timestamp: this.updatedAt });
    this.emit({ type: 'snapshot', snapshot: this.getSnapshot(), timestamp: this.updatedAt });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async connect(forceNewQr = false): Promise<WhatsAppConnectionSnapshot> {
    if (this.connectInFlight) return this.connectInFlight;
    if (this.status === 'CONNECTED' && this.sock && !forceNewQr) {
      return this.getSnapshot();
    }

    this.connectInFlight = (async () => {
      this.clearReconnectTimer();
      this.manualDisconnect = false;
      this.shuttingDown = false;

      if (this.sock) {
        await this.teardownSocket(forceNewQr);
      }
      if (forceNewQr) {
        await this.sessionStore.clearSession();
        this.sessionPersisted = false;
        this.connectedPhoneDigits = null;
        this.connectedPushName = null;
        this.qrGeneration = 0;
      }

      this.setState(
        'CONNECTING',
        { qrCodeDataUrl: null, qrExpiresAt: null, lastError: null, lastErrorCode: null },
        forceNewQr ? 'Reiniciando sessão via novo QR Code' : 'Conectando WebSocket Baileys',
      );

      const { state, saveCreds } = await this.sessionStore.createAuthState();
      let version: [number, number, number] = [2, 3000, 1025190524];
      if (!this.socketFactory) {
        try {
          const latest = await this.fetchVersionFn();
          version = latest.version;
        } catch (err) {
          this.logger.warn('Could not fetch latest WhatsApp Web version; using pinned fallback.', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const sock = this.socketFactory
        ? this.socketFactory({ auth: state, version })
        : (makeWASocket({
            version,
            auth: state,
            browser: Browsers.ubuntu('StickerWave Gateway'),
            markOnlineOnConnect: false,
            syncFullHistory: false,
            generateHighQualityLinkPreview: false,
            logger: (await import('pino')).default({ level: 'silent' }),
          }) as unknown as MinimalWASocket);

      this.sock = sock;
      this.bindSocketEvents(sock, state, saveCreds);
      return this.getSnapshot();
    })().finally(() => {
      this.connectInFlight = null;
    });

    return this.connectInFlight;
  }

  private bindSocketEvents(
    sock: MinimalWASocket,
    state: AuthenticationState,
    saveCreds: () => Promise<void>,
  ): void {
    sock.ev.on('creds.update', async (update) => {
      try {
        if (update && typeof update === 'object') {
          Object.assign(state.creds, update);
        }
        await saveCreds();
        this.sessionPersisted = await this.sessionStore.hasPersistedSession();
      } catch (err) {
        this.logger.error('Failed saving encrypted WhatsApp creds.', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      void this.handleConnectionUpdate(sock, update, state, saveCreds);
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        void this.handleIncomingMessage(sock, msg);
      }
    });

    sock.ev.on('messages.update', (updates: WAMessageUpdate[]) => {
      for (const u of updates) {
        const msgId = u.key?.id;
        const ack = mapWaStatusToAck(u.update?.status);
        if (msgId && ack) {
          for (const handler of this.ackHandlers) {
            handler({ waMessageId: msgId, ack });
          }
        }
      }
    });

    if (this.config.debugProtocol) {
      this.logger.info('Protocol debug inspection active for outgoing Sound Stickers.');
    }
  }

  private async handleConnectionUpdate(
    sock: MinimalWASocket,
    update: Partial<ConnectionState>,
    state?: AuthenticationState,
    saveCreds?: () => Promise<void>,
  ): Promise<void> {
    if (this.sock !== sock) return;

    if (update.qr) {
      try {
        const dataUrl = await QRCode.toDataURL(update.qr, { width: 320, margin: 2 });
        this.qrGeneration += 1;
        const expiresAt = new Date(Date.now() + 45_000).toISOString();
        this.setState(
          'WAITING_QR',
          { qrCodeDataUrl: dataUrl, qrExpiresAt: expiresAt, lastError: null, lastErrorCode: null },
          'Aguardando leitura do QR Code pelo administrador',
        );
        this.emit({
          type: 'qr',
          qrCodeDataUrl: dataUrl,
          qrExpiresAt: expiresAt,
          qrGeneration: this.qrGeneration,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        this.logger.error('QR generation failed.', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (update.connection === 'open') {
      const meId = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
      this.connectedPhoneDigits = meId ? normalizeJidDigits(meId) : this.config.waBotPhoneHint || null;
      this.connectedPushName = sock.user?.name || this.config.botDisplayName;
      if (state && !state.creds.me && sock.user?.id) {
        state.creds.me = { id: sock.user.id, name: sock.user.name };
        await saveCreds?.().catch(() => undefined);
      }
      this.sessionPersisted = true;
      this.reconnectAttempts = 0;
      this.setState(
        'CONNECTED',
        {
          qrCodeDataUrl: null,
          qrExpiresAt: null,
          lastError: null,
          lastErrorCode: null,
          connectedAt: new Date().toISOString(),
        },
        'WhatsApp central conectado',
      );
      this.logger.info('Central WhatsApp connection open.', {
        connectedPhoneMasked: this.connectedPhoneDigits ? maskPhone(`+${this.connectedPhoneDigits}`) : null,
      });
      return;
    }

    if (update.connection === 'close') {
      const boomErr = update.lastDisconnect?.error as { output?: { statusCode?: number }; message?: string } | undefined;
      const statusCode = boomErr?.output?.statusCode;
      const message = boomErr?.message || 'Socket closed';

      this.qrCodeDataUrl = null;
      this.qrExpiresAt = null;

      if (this.manualDisconnect || this.shuttingDown) {
        this.setState('DISCONNECTED', { qrCodeDataUrl: null, qrExpiresAt: null }, 'Desconectado pelo administrador');
        return;
      }

      if (statusCode === DisconnectReason.loggedOut) {
        await this.sessionStore.clearSession();
        this.sessionPersisted = false;
        this.connectedPhoneDigits = null;
        this.connectedPushName = null;
        this.setState(
          'LOGGED_OUT',
          {
            lastError: 'Sessão encerrada pelo WhatsApp ou celular principal. Gere um novo QR Code.',
            lastErrorCode: 'WA_LOGGED_OUT',
          },
          'Sessão revogada/desconectada no celular',
        );
        return;
      }

      // Exponential backoff reconnect (up to 30s)
      this.reconnectAttempts += 1;
      if (this.reconnectAttempts > 8) {
        this.setState(
          'ERROR',
          {
            lastError: `Falha após ${this.reconnectAttempts} tentativas de reconexão: ${message}`,
            lastErrorCode: String(statusCode || 'WA_RECONNECT_EXHAUSTED'),
          },
          'Limite de reconexões atingido',
        );
        return;
      }

      const delayMs = Math.min(30_000, 1500 * 2 ** (this.reconnectAttempts - 1));
      this.setState(
        'RECONNECTING',
        {
          lastError: message,
          lastErrorCode: String(statusCode || 'WA_CONN_CLOSED'),
        },
        `Reconectando em ${Math.round(delayMs / 1000)}s`,
      );
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => {
        void this.connect(false);
      }, delayMs);
    }
  }

  private async handleIncomingMessage(sock: MinimalWASocket, msg: WAMessage): Promise<void> {
    if (msg.key?.fromMe) return;
    const senderJid = msg.key?.remoteJid;
    if (!senderJid) return;

    if (this.config.debugProtocol && msg.message?.stickerMessage) {
      try {
        const rawBytes = waProto.Message.StickerMessage.encode(msg.message.stickerMessage).finish();
        const audioMeta = inspectRawStickerAudio(rawBytes);
        if (audioMeta) {
          this.logger.debug('Incoming sound sticker observed.', { from: maskJid(senderJid), seconds: audioMeta.decodedAudio.seconds });
        }
      } catch {
        // Never crash on incoming debug parse
      }
    }

    const text = extractTextFromWAMessage(msg);
    if (!text) return;

    for (const handler of this.incomingHandlers) {
      try {
        const replyText = await handler({
          senderJid,
          senderPhoneAltJid: msg.key?.remoteJidAlt,
          text,
          pushName: msg.pushName || undefined,
        });
        if (replyText && sock.sendMessage) {
          await sock.sendMessage(senderJid, { text: replyText }).catch(() => undefined);
        }
      } catch (err) {
        this.logger.warn('Incoming message handler error.', {
          sender: maskJid(senderJid),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async teardownSocket(logoutFromWa: boolean): Promise<void> {
    const oldSock = this.sock;
    this.sock = null;
    if (!oldSock) return;
    if (logoutFromWa) {
      await oldSock.logout().catch(() => undefined);
    }
    try {
      await oldSock.end(undefined);
    } catch {
      // ignore close errors
    }
  }

  async disconnect(clearSession = false): Promise<WhatsAppConnectionSnapshot> {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    await this.teardownSocket(clearSession);
    if (clearSession) {
      await this.sessionStore.clearSession();
      this.sessionPersisted = false;
      this.connectedPhoneDigits = null;
      this.connectedPushName = null;
    }
    this.setState(
      'DISCONNECTED',
      { qrCodeDataUrl: null, qrExpiresAt: null, lastError: null, lastErrorCode: null, connectedAt: null },
      clearSession ? 'Sessão encerrada e credenciais limpas' : 'Desconectado manualmente',
    );
    return this.getSnapshot();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearReconnectTimer();
    await this.teardownSocket(false);
  }

  async resolveRecipientChatJid(e164: string): Promise<string> {
    if (!this.sock || this.status !== 'CONNECTED') {
      throw new Error('WhatsApp bot is not connected.');
    }
    const fallbackJid = e164ToWhatsAppJid(e164);
    try {
      const checked = await this.sock.onWhatsApp(e164.replace(/\D/g, ''));
      if (Array.isArray(checked) && checked.length > 0) {
        const entry = checked[0]!;
        if (!entry.exists) {
          throw new Error('Recipient phone number is not registered on WhatsApp.');
        }
        return entry.jid || fallbackJid;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('not registered')) {
        throw err;
      }
      this.logger.debug('onWhatsApp check skipped/fallback to standard JID.', {
        recipient: maskPhone(e164),
      });
    }
    return fallbackJid;
  }

  async sendSoundStickerToRecipient(params: {
    e164: string;
    payload: SoundStickerPayloadInput;
  }): Promise<{ messageId: string; chatJid: string; embeddedAudioBytes: number }> {
    if (!this.sock || this.status !== 'CONNECTED') {
      throw new Error('WhatsApp bot is not connected.');
    }
    const chatJid = await this.resolveRecipientChatJid(params.e164);
    const ownJid =
      chatJid.endsWith('@lid') && this.sock.user?.lid
        ? this.sock.user.lid
        : this.sock.user?.id || `${this.connectedPhoneDigits || '0'}@s.whatsapp.net`;

    const result = await this.protocol.sendSoundSticker({
      chatJid,
      ownJid,
      payload: params.payload,
      upload: this.sock.waUploadToServer,
      relayMessage: (jid, message, options) => this.sock!.relayMessage(jid, message, options),
    });

    this.logger.info('Sound sticker relayed via WhatsApp bot.', {
      recipientMasked: maskPhone(params.e164),
      waMessageId: result.messageId,
      embeddedAudioBytes: result.verification.embeddedAudioBytes,
    });

    return {
      messageId: result.messageId,
      chatJid,
      embeddedAudioBytes: result.verification.embeddedAudioBytes ?? 0,
    };
  }
}
