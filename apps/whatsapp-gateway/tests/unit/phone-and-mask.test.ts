import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskJid, maskPhone, sanitizeLogString } from '../../src/utils/mask.js';
import { buildWaMeAuthorizeUrl, validateRecipientPhone } from '../../src/utils/phone.js';

test('validateRecipientPhone normalizes Brazilian and US numbers into E.164', () => {
  const brLocal = validateRecipientPhone('(11) 99876-5432', 'BR');
  assert.equal(brLocal.valid, true);
  assert.equal(brLocal.e164, '+5511998765432');
  assert.match(brLocal.masked ?? '', /^\+5511\*+5432$/);

  const intl = validateRecipientPhone('+1 415 555 0199');
  assert.equal(intl.valid, true);
  assert.equal(intl.e164, '+14155550199');

  assert.equal(validateRecipientPhone('123').valid, false);
  assert.equal(validateRecipientPhone('+5511<script>').valid, false);
});

test('masking and log sanitization hide phone numbers, JIDs, secrets, and media URLs', () => {
  assert.equal(maskPhone('+5511998765432'), '+5511*****5432');
  assert.equal(maskJid('5511998765432:12@s.whatsapp.net'), '5511*****5432@s.whatsapp.net');

  const raw = 'Authorization Bearer secretToken123 failed for +5511998765432 at https://mmg.whatsapp.net/v/123';
  const safe = sanitizeLogString(raw);
  assert.doesNotMatch(safe, /secretToken123/);
  assert.doesNotMatch(safe, /998765432/);
  assert.doesNotMatch(safe, /mmg\.whatsapp\.net/);
});

test('buildWaMeAuthorizeUrl creates encoded confirmation link', () => {
  const built = buildWaMeAuthorizeUrl('5511912345678', 'AB34CD');
  assert.equal(built.message, 'AUTORIZAR STICKERWAVE AB34CD');
  assert.equal(built.url, 'https://wa.me/5511912345678?text=AUTORIZAR%20STICKERWAVE%20AB34CD');
});
