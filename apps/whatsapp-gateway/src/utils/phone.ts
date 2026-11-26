import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import type { PhoneValidationResult } from '@stickerwave/contracts';
import { maskPhone } from './mask.js';

/**
 * Validates and normalizes recipient phone numbers to canonical E.164 (`+5511999887766`)
 * and WhatsApp user JID (`5511999887766@s.whatsapp.net`).
 */
export function validateRecipientPhone(
  rawInput: string,
  defaultCountry: CountryCode = 'BR',
): PhoneValidationResult {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed || trimmed.length > 32) {
    return { valid: false, e164: null, masked: null, countryCode: null, nationalNumber: null, reason: 'Empty or oversized phone input.' };
  }

  // Reject characters outside normal dial formatting
  if (/[^\d+\s().-]/.test(trimmed)) {
    return { valid: false, e164: null, masked: null, countryCode: null, nationalNumber: null, reason: 'Phone contains unsupported characters.' };
  }

  const normalizedCandidate = trimmed.startsWith('00') ? `+${trimmed.slice(2)}` : trimmed;
  const parsed = normalizedCandidate.startsWith('+')
    ? parsePhoneNumberFromString(normalizedCandidate)
    : parsePhoneNumberFromString(normalizedCandidate, defaultCountry);

  if (!parsed || !parsed.isValid()) {
    return {
      valid: false,
      e164: null,
      masked: null,
      countryCode: parsed?.country ?? null,
      nationalNumber: null,
      reason: 'Phone number is not a valid international E.164 number.',
    };
  }

  const e164 = parsed.number;
  return {
    valid: true,
    e164,
    masked: maskPhone(e164),
    countryCode: parsed.country ?? parsed.countryCallingCode,
    nationalNumber: parsed.nationalNumber,
  };
}

export function e164ToWhatsAppJid(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    throw new Error('Invalid E.164 digits for WhatsApp JID.');
  }
  return `${digits}@s.whatsapp.net`;
}

export function normalizeJidDigits(jid: string): string | null {
  const base = jid.split('@')[0]?.split(':')[0] ?? '';
  const digits = base.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

export function buildWaMeAuthorizeUrl(botPhoneDigits: string | null, code: string): { url: string | null; message: string } {
  const message = `AUTORIZAR STICKERWAVE ${code}`;
  if (!botPhoneDigits) return { url: null, message };
  const cleanDigits = botPhoneDigits.replace(/\D/g, '');
  if (!cleanDigits) return { url: null, message };
  return {
    url: `https://wa.me/${cleanDigits}?text=${encodeURIComponent(message)}`,
    message,
  };
}
