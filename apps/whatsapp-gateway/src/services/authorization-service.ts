import crypto from 'node:crypto';
import type {
  PhoneValidationResult,
  RecipientAuthorizationChallenge,
  RecipientAuthorizationStatusResponse,
} from '@stickerwave/contracts';
import type { GatewayConfig } from '../config.js';
import type { GatewayLogger } from '../logger.js';
import { hashRecipientE164, type GatewayDatabase } from '../storage/database.js';
import { maskPhone } from '../utils/mask.js';
import { buildWaMeAuthorizeUrl, normalizeJidDigits, validateRecipientPhone } from '../utils/phone.js';

const CHALLENGE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateChallengeCode(length = 6): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CHALLENGE_ALPHABET[bytes[i]! % CHALLENGE_ALPHABET.length];
  }
  return out;
}

export class AuthorizationService {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly config: GatewayConfig,
    private readonly logger: GatewayLogger,
    private readonly getBotPhoneDigits: () => string | null,
  ) {}

  validatePhone(raw: string, defaultCountry: 'BR' | 'US' = 'BR'): PhoneValidationResult {
    return validateRecipientPhone(raw, defaultCountry);
  }

  isAuthorized(e164: string): boolean {
    if (this.config.autoAuthorizeDevNumbers.has(e164)) {
      return true;
    }
    const row = this.db.getAuthorizationByE164(e164);
    return Boolean(row?.authorized);
  }

  getStatus(e164: string): RecipientAuthorizationStatusResponse {
    const devAuto = this.config.autoAuthorizeDevNumbers.has(e164);
    const row = this.db.getAuthorizationByE164(e164);
    const botDigits = this.getBotPhoneDigits() || this.config.waBotPhoneHint || null;

    const validPending =
      row?.pending_code &&
      row.pending_expires_at &&
      new Date(row.pending_expires_at).getTime() > Date.now()
        ? row.pending_code
        : null;

    const link = validPending ? buildWaMeAuthorizeUrl(botDigits, validPending) : { url: null, message: null };

    return {
      e164,
      masked: maskPhone(e164),
      authorized: devAuto || Boolean(row?.authorized),
      authorizedAt: devAuto ? row?.authorized_at ?? new Date().toISOString() : row?.authorized_at ?? null,
      pendingChallengeCode: validPending,
      pendingExpiresAt: validPending ? row?.pending_expires_at ?? null : null,
      waMeUrl: link.url,
      prefilledMessage: link.message,
    };
  }

  requestAuthorizationChallenge(rawPhone: string): {
    validation: PhoneValidationResult;
    challenge: RecipientAuthorizationChallenge | null;
  } {
    const validation = this.validatePhone(rawPhone);
    if (!validation.valid || !validation.e164) {
      return { validation, challenge: null };
    }

    const e164 = validation.e164;
    const botDigits = this.getBotPhoneDigits() || this.config.waBotPhoneHint || null;

    if (this.config.autoAuthorizeDevNumbers.has(e164)) {
      this.db.markRecipientAuthorizedByE164(e164);
    }

    const existing = this.db.getAuthorizationByE164(e164);
    const code =
      existing?.pending_code &&
      existing.pending_expires_at &&
      new Date(existing.pending_expires_at).getTime() > Date.now() + 30_000
        ? existing.pending_code
        : generateChallengeCode(6);

    const expiresAt = new Date(Date.now() + this.config.authorizationCodeTtlSec * 1000).toISOString();
    const challengeId = existing?.pending_challenge_id ?? crypto.randomUUID();
    const record = this.db.upsertAuthorizationChallenge({
      e164,
      challengeId,
      code,
      expiresAt,
    });

    const { url, message } = buildWaMeAuthorizeUrl(botDigits, code);
    this.db.recordAuditEvent('auth.challenge_created', record.e164_masked, code);

    return {
      validation,
      challenge: {
        challengeId,
        recipientMasked: record.e164_masked,
        e164,
        code,
        expiresAt,
        authorized: Boolean(record.authorized),
        botNumberConfigured: Boolean(botDigits),
        waMeUrl: url,
        prefilledMessage: message,
        instructions: botDigits
          ? `Abra o WhatsApp e envie a mensagem "${message}" para o número do bot StickerWave para liberar o recebimento.`
          : `Envie "${message}" pelo seu WhatsApp para o número oficial do bot StickerWave conectado pelo administrador.`,
      },
    };
  }

  /**
   * Confirms authorization when the recipient messages the connected bot on WhatsApp
   * containing `AUTORIZAR STICKERWAVE <CODE>` (or the exact 6-char challenge code).
   * Prevents one phone number from confirming another phone's challenge by matching
   * normalized digits against the hashed E.164 key when sender phone JID is known.
   */
  handleIncomingWhatsAppAuthorization(params: {
    senderJid: string;
    senderPhoneAltJid?: string;
    text: string;
  }): { confirmed: boolean; code?: string; replyText?: string } {
    const textUpper = params.text.toUpperCase();
    const explicitMatch = textUpper.match(/AUTORIZAR\s+STICKERWAVE\s+([A-Z2-9]{6})/);
    const code = explicitMatch?.[1] ?? (textUpper.trim().length === 6 && /^[A-Z2-9]{6}$/.test(textUpper.trim()) ? textUpper.trim() : null);
    if (!code) return { confirmed: false };

    const pending = this.db.findPendingChallengeByCode(code);
    if (!pending) return { confirmed: false };

    // Extract digits from sender PN JID (or remoteJidAlt when Baileys delivers @lid + @s.whatsapp.net alt).
    const pnCandidate = [params.senderPhoneAltJid, params.senderJid].find((j) => j && j.endsWith('@s.whatsapp.net'));
    let matchedHash: string | undefined;
    if (pnCandidate) {
      const digits = normalizeJidDigits(pnCandidate);
      if (digits) {
        const senderE164 = `+${digits}`;
        matchedHash = hashRecipientE164(senderE164);
      }
    }

    const updated = this.db.confirmChallengeByCode(code, matchedHash);
    if (!updated) {
      this.logger.warn('Recipient authorization code mismatch or expired.', { code });
      return { confirmed: false };
    }

    this.db.recordAuditEvent('auth.recipient_confirmed_whatsapp', updated.e164_masked, 'OPT_IN_OK');
    this.logger.info('Recipient authorized via incoming WhatsApp message.', { recipientMasked: updated.e164_masked });
    return {
      confirmed: true,
      code,
      replyText: 'StickerWave: seu número foi autorizado para receber figurinhas sonoras neste WhatsApp.',
    };
  }

  /**
   * Allows explicit confirmation via admin/code challenge when matching E.164 and valid active code
   * (e.g., automated integration test or user submitting code received from bot challenge).
   */
  confirmByPhoneAndCode(e164: string, code: string): { confirmed: boolean; status: RecipientAuthorizationStatusResponse } {
    const hash = hashRecipientE164(e164);
    const updated = this.db.confirmChallengeByCode(code, hash);
    if (updated) {
      this.db.recordAuditEvent('auth.recipient_confirmed_code', updated.e164_masked, 'CODE_OK');
    }
    return {
      confirmed: Boolean(updated),
      status: this.getStatus(e164),
    };
  }

  revoke(e164: string): boolean {
    const ok = this.db.revokeRecipientAuthorization(e164);
    if (ok) {
      this.db.recordAuditEvent('auth.recipient_revoked', maskPhone(e164), 'REVOKED');
    }
    return ok;
  }
}
