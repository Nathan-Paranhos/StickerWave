import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { createDistributionServer } from '../scripts/serve.mjs';
import { createGatewayRuntime } from '../apps/whatsapp-gateway/dist/http/server.js';

class BrowserQaMockSocket {
  constructor() {
    this.emitter = new EventEmitter();
    this.user = undefined;
    this.relayed = [];
    this.ev = {
      on: (event, listener) => this.emitter.on(event, listener),
      off: (event, listener) => this.emitter.off(event, listener),
      emit: (event, payload) => this.emitter.emit(event, payload),
    };
  }
  async waUploadToServer(_path, opts) {
    const id = crypto.randomBytes(6).toString('hex');
    return {
      mediaUrl: `https://mmg.whatsapp.net/v/t62/${opts.mediaType}/${id}`,
      directPath: `/v/t62/${opts.mediaType}/${id}`,
    };
  }
  async relayMessage(jid, message, options) {
    this.relayed.push({ jid, message, messageId: options.messageId });
    return options.messageId;
  }
  async sendMessage() {
    return { key: { id: 'qa-reply-' + crypto.randomUUID() } };
  }
  async onWhatsApp(...phones) {
    return phones.map(p => ({ jid: `${p.replace(/\D/g, '')}@s.whatsapp.net`, exists: true }));
  }
  async logout() {}
  async end() {}
}

const workDir = await mkdtemp(join(tmpdir(), 'stickerwave-gw-qa-'));
const dbDir = await mkdtemp(join(tmpdir(), 'stickerwave-gw-webdb-'));
const sockets = [];
const adminSecret = 'qa-browser-admin-secret-123456';

const gateway = createGatewayRuntime(
  {
    host: '127.0.0.1',
    port: 0,
    adminSecret,
    sessionSecret: 'qa-browser-session-secret-123456',
    dataDir: workDir,
    sessionDir: join(workDir, 'session'),
    dbPath: join(workDir, 'qa.db'),
    allowedOrigins: ['*'],
    enableSoundStickers: true,
    rateLimitMaxRequests: 200,
  },
  {
    skipStartupReconnect: true,
    socketFactory: () => {
      const sock = new BrowserQaMockSocket();
      sockets.push(sock);
      return sock;
    },
  },
);

const { port: gwPort } = await gateway.start();
const webServer = createDistributionServer({
  databaseUrl: `file:${join(dbDir, 'web.db').replace(/\\/g, '/')}`,
  gatewayUrl: `http://127.0.0.1:${gwPort}`,
});
webServer.listen(0, '127.0.0.1');
await once(webServer, 'listening');
const origin = `http://127.0.0.1:${webServer.address().port}`;

let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.QA_CHROMIUM_PATH,
    args: ['--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  async function assertAccessible(label) {
    const report = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    assert.deepEqual(
      report.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })),
      [],
      label,
    );
  }

  // 1) Protected /whatsapp admin gate + live SSE QR pairing + Accessibility
  await page.goto(`${origin}/whatsapp`);
  await page.getByPlaceholder('GATEWAY_ADMIN_SECRET').fill('wrong-secret');
  await page.getByRole('button', { name: /Acessar painel WhatsApp/i }).click();
  await page.getByText(/Autenticação administrativa obrigatória|Segredo administrativo inválido/i).waitFor();

  await page.getByPlaceholder('GATEWAY_ADMIN_SECRET').fill(adminSecret);
  await page.getByRole('button', { name: /Acessar painel WhatsApp/i }).click();
  await page.getByText('Desconectado').waitFor();
  await assertAccessible('WhatsApp Admin Dashboard accessibility');

  await page.getByRole('button', { name: /Conectar \/ Gerar QR/i }).click();
  const waitUntil = async (fn, ms = 6000) => {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > ms) throw new Error('Timed out waiting for condition');
      await new Promise(r => setTimeout(r, 40));
    }
  };
  await waitUntil(() => sockets.length > 0);
  const sock = sockets[0];
  sock.emitter.emit('connection.update', { qr: '2@QA_BROWSER_MOCK_QR' });
  await page.locator('img[alt*="QR Code"]').waitFor();
  await page.getByText('Aguardando QR Code').waitFor();

  sock.user = { id: '5511911112222:1@s.whatsapp.net', name: 'StickerWave QA Bot' };
  sock.emitter.emit('creds.update', {});
  sock.emitter.emit('connection.update', { connection: 'open' });
  await page.getByText('+5511*****2222').waitFor();
  await page.getByText('StickerWave QA Bot').waitFor();
  console.log('PASS /whatsapp admin auth, SSE live QR, and connected bot status');

  // 2) Authenticate Studio user, create composition, send sound sticker through modal
  await page.goto(`${origin}/auth`);
  await page.getByLabel('Nome').fill('QA Gateway');
  await page.getByLabel('E-mail').fill('qa-gw@example.com');
  await page.getByLabel('Senha', { exact: true }).fill('sticker123');
  await page.getByLabel('Confirmar senha', { exact: true }).fill('sticker123');
  await page.getByRole('button', { name: 'Criar conta grátis' }).last().click();

  await page.getByRole('button', { name: 'Editar um exemplo' }).click();
  await page.getByRole('button', { name: 'Enviar no WhatsApp' }).first().click();

  const dialog = page.getByRole('dialog', { name: /Enviar figurinha sonora/i });
  await dialog.waitFor();
  await dialog.locator('img[alt*="Prévia da figurinha sonora"]').waitFor();
  await dialog.getByRole('button', { name: /Ouvir áudio da figurinha/i }).waitFor();
  await assertAccessible('SendToWhatsApp modal accessibility');
  await dialog.getByLabel(/Seu número do WhatsApp/i).fill('11 98888-7777');
  await dialog.getByRole('button', { name: /Validar número/i }).click();
  await dialog.getByText(/\+5511988887777/).waitFor();
  await dialog.getByText(/Autorização única/i).waitFor();

  const code = (await dialog.locator('.wa-code-banner code').innerText()).trim();
  assert.match(code, /^[A-Z2-9]{6}$/);

  // Simulate user authorizing from their WhatsApp via incoming bot message
  sock.emitter.emit('messages.upsert', {
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '5511988887777@s.whatsapp.net', fromMe: false, id: 'qa-opt-1' },
        message: { conversation: `AUTORIZAR STICKERWAVE ${code}` },
      },
    ],
  });
  await dialog.getByRole('button', { name: /Verificar autorização/i }).click();
  await dialog.getByText(/Número autorizado para receber figurinhas sonoras/i).waitFor();

  await dialog.getByRole('button', { name: /Enviar figurinha sonora/i }).click();
  await dialog.getByText(/SENT · 100%|DELIVERED · 100%/i).waitFor({ timeout: 60000 });
  assert.equal(sock.relayed.length, 1);
  console.log('PASS Studio SendToWhatsApp modal opt-in, FFmpeg build, and Sound Sticker delivery');

  // Check mobile viewport layout overflow on Studio with new button and on /whatsapp
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/studio`);
  await page.getByRole('button', { name: 'Editar um exemplo' }).click();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Studio mobile width fit');
  await page.goto(`${origin}/whatsapp`);
  await page.getByText('StickerWave Gateway').waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Admin mobile width fit');
  console.log('PASS mobile responsive layout without horizontal overflow');

  assert.deepEqual(pageErrors, []);
} finally {
  await browser?.close();
  webServer.closeAllConnections?.();
  await new Promise(resolve => webServer.close(resolve));
  await gateway.stop();
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(dbDir, { recursive: true, force: true }).catch(() => undefined);
}
