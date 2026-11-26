import crypto from 'node:crypto';

/**
 * Masks E.164 phone numbers so logs and public status views never expose full subscriber numbers.
 * Example: "+5511999887766" -> "+5511*****7766"
 */
export function maskPhone(e164OrDigits: string | null | undefined): string {
  if (!e164OrDigits) return '***';
  const cleaned = e164OrDigits.trim();
  const prefix = cleaned.startsWith('+') ? '+' : '';
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length <= 4) return `${prefix}${'*'.repeat(Math.max(2, digits.length))}`;
  if (digits.length <= 7) {
    return `${prefix}${digits.slice(0, 2)}${'*'.repeat(digits.length - 4)}${digits.slice(-2)}`;
  }
  return `${prefix}${digits.slice(0, 4)}${'*'.repeat(digits.length - 8)}${digits.slice(-4)}`;
}

/**
 * Masks WhatsApp JIDs (`5511999887766:1@s.whatsapp.net` or `123456@lid`) preserving only suffix & endpoints.
 */
export function maskJid(jid: string | null | undefined): string {
  if (!jid) return 'jid:unknown';
  const [userPart, domain = ''] = jid.split('@');
  if (!userPart) return 'jid:unknown';
  const baseUser = userPart.split(':')[0] ?? userPart;
  return `${maskPhone(baseUser)}${domain ? `@${domain}` : ''}`;
}

export function hashPhoneSha256(e164: string, salt = ''): string {
  return crypto.createHash('sha256').update(`${salt}:${e164}`).digest('hex').slice(0, 24);
}

/**
 * Strips raw phone numbers, bearer tokens, base64 QR payloads, and WhatsApp media paths from arbitrary text.
 */
export function sanitizeLogString(text: string): string {
  return text
    .replace(/(bearer\s+)[a-zA-Z0-9._\-+/=]+/gi, '$1<redacted>')
    .replace(/\bhttps:\/\/mmg\.whatsapp\.net\/[^\s"')]+/gi, '<redacted-wa-media-url>')
    .replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, '<redacted-qr-data-url>')
    .replace(/\+\d{8,15}/g, (match) => maskPhone(match))
    .replace(/\b(\d{10,15})(?::\d+)?@(s\.whatsapp\.net|lid|g\.us)/g, (_m, user, dom) => `${maskPhone(user)}@${dom}`);
}
