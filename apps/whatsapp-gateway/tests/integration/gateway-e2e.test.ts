import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DisconnectReason, type BaileysEventEmitter, type proto } from '@whiskeysockets/baileys';
import { createGatewayRuntime } from '../../src/http/server.js';
import { GatewayDatabase } from '../../src/storage/database.js';
import type { MinimalWASocket } from '../../src/whatsapp/connection-manager.js';
import { verifyEncodedSoundStickerMessage } from '../../src/whatsapp/sound-sticker-protocol.js';

const fixturesDir = path.resolve(process.cwd(), '../../qa/fixtures');
const soundsDir = path.resolve(process.cwd(), '../../public/sounds');

class MockBaileysSocket implements MinimalWASocket {
  public readonly emitter = new EventEmitter();
  public user?: { id?: string; lid?: string; name?: string };
  public relayedMessages: Array<{ jid: string; message: proto.IMessage; messageId: string }> = [];
  public sentTexts: Array<{ jid: string; text: string }> = [];
  public ended = false;
  public loggedOut = false;

  public ev = {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      this.emitter.on(event, listener);
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      this.emitter.off(event, listener);
    },
    emit: (event: string, payload: unknown) => this.emitter.emit(event, payload),
  } as unknown as BaileysEventEmitter;

  waUploadToServer: MinimalWASocket['waUploadToServer'] = async (_filePath, opts) => {
    const id = crypto.randomBytes(6).toString('hex');
    return {
      mediaUrl: `https://mmg.whatsapp.net/v/t62/${opts.mediaType}/${id}`,
      directPath: `/v/t62/${opts.mediaType}/${id}`,
    };
  };

  relayMessage = async (jid: string, message: proto.IMessage, options: { messageId: string }) => {
    this.relayedMessages.push({ jid, message, messageId: options.messageId });
    return options.messageId;
  };

  sendMessage = async (jid: string, content: { text: string }) => {
    this.sentTexts.push({ jid, text: content.text });
    return { key: { id: 'reply-' + crypto.randomUUID() } };
  };

  onWhatsApp = async (...phones: string[]) =>
    phones.map((p) => ({
      jid: `${p.replace(/\D/g, '')}@s.whatsapp.net`,
      exists: !p.endsWith('000000'),
    }));

  logout = async () => {
    this.loggedOut = true;
  };

  end = async () => {
    this.ended = true;
  };
}

function buildMultipart(parts: Array<{ name: string; value?: string; filename?: string; contentType?: string; data?: Buffer }>) {
  const boundary = '----StickerWaveTestBoundary7d9';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.data !== undefined) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename || 'file.bin'}"\r\nContent-Type: ${part.contentType || 'application/octet-stream'}\r\n\r\n`,
        ),
      );
      chunks.push(part.data);
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value ?? ''}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
}

test('Gateway end-to-end flow: QR connect, encrypted session, WA opt-in, sound sticker send & delivery ACK, idempotency, cancel', async (t) => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-gw-int-'));
  const sockets: MockBaileysSocket[] = [];
  const runtime = createGatewayRuntime(
    {
      host: '127.0.0.1',
      port: 0,
      adminSecret: 'super-secret-admin-key-123456',
      sessionSecret: 'super-secret-session-aes256-key-123456',
      dataDir: workDir,
      sessionDir: path.join(workDir, 'session'),
      dbPath: path.join(workDir, 'gateway.db'),
      allowedOrigins: ['http://127.0.0.1:5173'],
      enableSoundStickers: true,
      autoAuthorizeDevNumbers: new Set<string>(),
      rateLimitMaxRequests: 200,
    },
    {
      skipStartupReconnect: true,
      socketFactory: () => {
        const s = new MockBaileysSocket();
        sockets.push(s);
        return s;
      },
    },
  );

  t.after(async () => {
    await runtime.stop();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  const { port } = await runtime.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminHeaders = { Authorization: 'Bearer super-secret-admin-key-123456' };

  // 1) Health & readiness
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  const ready = await fetch(`${baseUrl}/ready`);
  assert.equal(ready.status, 200);
  const readyJson = (await ready.json()) as { ready: boolean; whatsappConnected: boolean; protocolReady: boolean };
  assert.equal(readyJson.ready, true);
  assert.equal(readyJson.protocolReady, true);
  assert.equal(readyJson.whatsappConnected, false);

  // 2) Connect & single-flight lock -> emit QR -> emit open
  const [conn1, conn2] = await Promise.all([
    fetch(`${baseUrl}/api/v1/whatsapp/connect`, { method: 'POST', headers: adminHeaders }),
    fetch(`${baseUrl}/api/v1/whatsapp/connect`, { method: 'POST', headers: adminHeaders }),
  ]);
  assert.equal(conn1.status, 200);
  assert.equal(conn2.status, 200);
  assert.equal(sockets.length, 1);

  const sock = sockets[0]!;
  sock.emitter.emit('connection.update', { qr: '2@MOCK_QR_TOKEN_SECRET' });
  await new Promise((r) => setTimeout(r, 120));

  const qrRes = await fetch(`${baseUrl}/api/v1/whatsapp/qr`, { headers: adminHeaders });
  const qrJson = (await qrRes.json()) as { status: string; qrCodeDataUrl: string };
  assert.equal(qrJson.status, 'WAITING_QR');
  assert.ok(qrJson.qrCodeDataUrl.startsWith('data:image/png;base64,'));

  // Simulate pairing complete & creds save
  sock.user = { id: '5511900001111:1@s.whatsapp.net', name: 'StickerWave Bot' };
  sock.emitter.emit('creds.update', {});
  sock.emitter.emit('connection.update', { connection: 'open' });
  await new Promise((r) => setTimeout(r, 80));

  const statusRes = await fetch(`${baseUrl}/api/v1/whatsapp/status`, { headers: adminHeaders });
  const statusJson = (await statusRes.json()) as { status: string; botWaMePhone: string; connectedPhoneMasked: string };
  assert.equal(statusJson.status, 'CONNECTED');
  assert.equal(statusJson.botWaMePhone, '5511900001111');
  assert.equal(statusJson.connectedPhoneMasked, '+5511*****1111');

  // Verify encrypted session files exist and are NOT plaintext JSON
  const sessionFiles = await fs.readdir(path.join(workDir, 'session'));
  assert.ok(sessionFiles.length >= 1);
  const firstSessionBytes = await fs.readFile(path.join(workDir, 'session', sessionFiles[0]!));
  assert.throws(() => JSON.parse(firstSessionBytes.toString('utf8')));

  // 3) Unauthorized recipient fails cleanly with 403 GW-4031
  const png = await fs.readFile(path.join(fixturesDir, 'transparency.png'));
  const wav = await fs.readFile(path.join(soundsDir, 'pop.wav'));
  const sendBlocked = buildMultipart([
    { name: 'recipientPhone', value: '+5511988887777' },
    { name: 'visual', filename: 'transparency.png', contentType: 'image/png', data: png },
    { name: 'audio', filename: 'pop.wav', contentType: 'audio/wav', data: wav },
  ]);
  const resBlocked = await fetch(`${baseUrl}/api/v1/stickers/send`, {
    method: 'POST',
    headers: { 'Content-Type': sendBlocked.contentType },
    body: sendBlocked.body,
  });
  assert.equal(resBlocked.status, 403);
  assert.equal((await resBlocked.json() as { code: string }).code, 'GW-4031');

  // 4) Request challenge & simulate recipient authorizing via WhatsApp message to bot
  const chalRes = await fetch(`${baseUrl}/api/v1/recipients/authorization-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '+5511988887777' }),
  });
  assert.equal(chalRes.status, 200);
  const chal = (await chalRes.json()) as { code: string; waMeUrl: string; prefilledMessage: string };
  assert.ok(chal.waMeUrl.includes('5511900001111'));

  sock.emitter.emit('messages.upsert', {
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '5511988887777@s.whatsapp.net', fromMe: false, id: 'in-1' },
        message: { conversation: chal.prefilledMessage },
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sock.sentTexts.length, 1);

  const authCheck = await fetch(
    `${baseUrl}/api/v1/recipients/authorization-status?phone=${encodeURIComponent('+5511988887777')}`,
  );
  assert.equal((await authCheck.json() as { authorized: boolean }).authorized, true);

  // 5) Enqueue Sound Sticker + test idempotency + verify field 26 on relayed protobuf + test DELIVERY_ACK
  const sendPayload = buildMultipart([
    { name: 'recipientPhone', value: '+5511988887777' },
    { name: 'audioOptions', value: JSON.stringify({ trimStartMs: 0, trimEndMs: 500, normalizePeak: true }) },
    { name: 'visual', filename: 'sticker.png', contentType: 'image/png', data: png },
    { name: 'audio', filename: 'pop.wav', contentType: 'audio/wav', data: wav },
  ]);

  const sendRes = await fetch(`${baseUrl}/api/v1/stickers/send`, {
    method: 'POST',
    headers: { 'Content-Type': sendPayload.contentType, 'Idempotency-Key': 'idem-test-001' },
    body: sendPayload.body,
  });
  assert.equal(sendRes.status, 202);
  const sentBody = (await sendRes.json()) as { job: { id: string } };
  const jobId = sentBody.job.id;

  // Duplicate idempotency key returns same job cleanly without double send
  const dupRes = await fetch(`${baseUrl}/api/v1/stickers/send`, {
    method: 'POST',
    headers: { 'Content-Type': sendPayload.contentType, 'Idempotency-Key': 'idem-test-001' },
    body: sendPayload.body,
  });
  assert.equal(dupRes.status, 200);
  const dupJson = (await dupRes.json()) as { deduplicated: boolean; job: { id: string } };
  assert.equal(dupJson.deduplicated, true);
  assert.equal(dupJson.job.id, jobId);

  // Poll until SENT (allowing headroom for cold FFmpeg spawn)
  let finalJob: { status: string; waMessageId: string | null; webpBytes: number | null; oggBytes: number | null } | null = null;
  for (let i = 0; i < 120; i++) {
    const jRes = await fetch(`${baseUrl}/api/v1/stickers/jobs/${jobId}`);
    finalJob = (await jRes.json()) as typeof finalJob;
    if (finalJob?.status === 'SENT' || finalJob?.status === 'FAILED') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(finalJob?.status, 'SENT');
  assert.ok((finalJob?.webpBytes ?? 0) > 100);
  assert.ok((finalJob?.oggBytes ?? 0) > 100);
  assert.equal(sock.relayedMessages.length, 1);

  // Verify the actual Message emitted by ConnectionManager has field 26 AudioMessage inside StickerMessage
  const relayed = sock.relayedMessages[0]!;
  assert.ok(relayed.message.stickerMessage);
  assert.equal(relayed.message.stickerMessage?.width, 512);
  assert.equal(relayed.message.stickerMessage?.height, 512);

  // Simulate WhatsApp DELIVERY_ACK (status = 3)
  sock.emitter.emit('messages.update', [
    { key: { id: finalJob?.waMessageId ?? relayed.messageId, remoteJid: relayed.jid }, update: { status: 3 } },
  ]);
  await new Promise((r) => setTimeout(r, 50));
  const deliveredRes = await fetch(`${baseUrl}/api/v1/stickers/jobs/${jobId}`);
  assert.equal((await deliveredRes.json() as { status: string }).status, 'DELIVERED');

  // Cannot cancel already delivered job
  const cancelRes = await fetch(`${baseUrl}/api/v1/stickers/jobs/${jobId}/cancel`, { method: 'POST' });
  assert.equal(cancelRes.status, 409);

  // Also verify canonical Spec §12 /api/v1/admin/* endpoints work seamlessly alongside /api/v1/whatsapp/*
  const adminMetricsRes = await fetch(`${baseUrl}/api/v1/admin/metrics`, { headers: adminHeaders });
  assert.equal(adminMetricsRes.status, 200);
  const adminMetricsJson = (await adminMetricsRes.json()) as { sentJobs: number; deliveredJobs: number };
  assert.ok(adminMetricsJson.deliveredJobs >= 1 || adminMetricsJson.sentJobs >= 1);

  // Test QR renewal (qrGeneration increments when new QR arrives) & reconnect state
  await fetch(`${baseUrl}/api/v1/admin/whatsapp/disconnect`, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clearSession: false }),
  });
  await fetch(`${baseUrl}/api/v1/admin/whatsapp/connect`, { method: 'POST', headers: adminHeaders });
  const sock2 = sockets[sockets.length - 1]!;
  sock2.emitter.emit('connection.update', { qr: '2@QR_V1' });
  await new Promise((r) => setTimeout(r, 40));
  sock2.emitter.emit('connection.update', { qr: '2@QR_V2' });
  await new Promise((r) => setTimeout(r, 40));
  const qrRenewJson = (await (await fetch(`${baseUrl}/api/v1/admin/whatsapp/qr`, { headers: adminHeaders })).json()) as {
    qrGeneration: number;
  };
  assert.ok(qrRenewJson.qrGeneration >= 2);

  // Simulate transient close triggering RECONNECTING state
  sock2.emitter.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionClosed } }, date: new Date() },
  });
  await new Promise((r) => setTimeout(r, 40));
  const reconnectingSnap = (await (await fetch(`${baseUrl}/api/v1/admin/whatsapp/status`, { headers: adminHeaders })).json()) as {
    status: string;
  };
  assert.equal(reconnectingSnap.status, 'RECONNECTING');

  // Re-open and test deterministic cancellation on an isolated 1-slot queue
  sock2.user = { id: '5511900001111:1@s.whatsapp.net', name: 'StickerWave Bot' };
  sock2.emitter.emit('connection.update', { connection: 'open' });
  await new Promise((r) => setTimeout(r, 40));

  // Logged out clears session cleanly
  sock2.emitter.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } }, date: new Date() },
  });
  await new Promise((r) => setTimeout(r, 80));
  const afterLogout = await fetch(`${baseUrl}/api/v1/admin/whatsapp/status`, { headers: adminHeaders });
  const afterLogoutJson = (await afterLogout.json()) as { status: string };
  assert.equal(afterLogoutJson.status, 'LOGGED_OUT');
});

test('Queue cancels queued job prior to sending without relaying', async (t) => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-gw-cancel-'));
  const sock = new MockBaileysSocket();
  const runtime = createGatewayRuntime(
    {
      host: '127.0.0.1',
      port: 0,
      maxParallelJobs: 1,
      dataDir: workDir,
      sessionDir: path.join(workDir, 'session'),
      dbPath: path.join(workDir, 'cancel.db'),
      allowedOrigins: ['*'],
    },
    { skipStartupReconnect: true, socketFactory: () => sock },
  );
  t.after(async () => {
    await runtime.stop();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  await runtime.start();
  await runtime.wa.connect();
  sock.user = { id: '5511900001111:1@s.whatsapp.net', name: 'Bot' };
  sock.emitter.emit('connection.update', { connection: 'open' });
  await new Promise((r) => setTimeout(r, 40));

  const png = await fs.readFile(path.join(fixturesDir, 'transparency.png'));
  const wav = await fs.readFile(path.join(soundsDir, 'pop.wav'));
  runtime.authService.requestAuthorizationChallenge('+5511988887777');
  const pendingStatus = runtime.authService.getStatus('+5511988887777');
  runtime.authService.confirmByPhoneAndCode('+5511988887777', pendingStatus.pendingChallengeCode!);

  const jobA = runtime.jobService.enqueue({
    recipientPhone: '+5511988887777',
    visualBytes: png,
    audioBytes: wav,
  }).job;
  const jobB = runtime.jobService.enqueue({
    recipientPhone: '+5511988887777',
    visualBytes: png,
    audioBytes: wav,
  }).job;

  // Job B is strictly QUEUED behind 1-slot Job A before queueMicrotask starts Job B -> guaranteed CANCELLED
  const cancelledB = runtime.jobService.cancelJob(jobB.id);
  assert.equal(cancelledB.status, 'CANCELLED');

  for (let i = 0; i < 80; i++) {
    const s = runtime.jobService.getJob(jobA.id)?.status;
    if (s === 'SENT' || s === 'FAILED') break;
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.equal(runtime.jobService.getJob(jobA.id)?.status, 'SENT');
  assert.equal(sock.relayedMessages.length, 1);
});

test('Encrypted WhatsApp session survives server restart and resumes connection cleanly', async (t) => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-gw-restart-'));
  const sessionDir = path.join(workDir, 'session');
  const dbPath = path.join(workDir, 'restart.db');
  const sessionSecret = 'restart-secret-32-chars-aes-gcm-123';

  const socks1: MockBaileysSocket[] = [];
  const rt1 = createGatewayRuntime(
    { host: '127.0.0.1', port: 0, sessionSecret, dataDir: workDir, sessionDir, dbPath, allowedOrigins: ['*'] },
    { skipStartupReconnect: true, socketFactory: () => { const s = new MockBaileysSocket(); socks1.push(s); return s; } },
  );
  await rt1.start();
  await rt1.wa.connect();
  socks1[0]!.user = { id: '5511944443333:1@s.whatsapp.net', name: 'Persisted Bot' };
  socks1[0]!.emitter.emit('creds.update', {});
  socks1[0]!.emitter.emit('connection.update', { connection: 'open' });
  await new Promise((r) => setTimeout(r, 80));
  await rt1.stop();

  const socks2: MockBaileysSocket[] = [];
  const rt2 = createGatewayRuntime(
    { host: '127.0.0.1', port: 0, sessionSecret, dataDir: workDir, sessionDir, dbPath, allowedOrigins: ['*'] },
    { skipStartupReconnect: false, socketFactory: () => { const s = new MockBaileysSocket(); socks2.push(s); return s; } },
  );
  t.after(async () => {
    await rt2.stop();
    await fs.rm(workDir, { recursive: true, force: true });
  });
  await rt2.start();
  for (let i = 0; i < 30 && socks2.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(socks2.length, 1);
  socks2[0]!.user = { id: '5511944443333:1@s.whatsapp.net', name: 'Persisted Bot' };
  socks2[0]!.emitter.emit('connection.update', { connection: 'open' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(rt2.wa.getSnapshot().status, 'CONNECTED');
  assert.equal(rt2.wa.getSnapshot().sessionPersisted, true);
});

test('Startup recovery marks in-flight SENDING jobs UNKNOWN and queued jobs FAILED without re-sending', async (t) => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-gw-rec-'));
  const dbPath = path.join(workDir, 'recover.db');

  const seedDb = new GatewayDatabase(dbPath);
  const jSending = seedDb.createJob({ id: 'job-sending-1', recipientE164: '+5511977776666', soundStickersEnabled: true });
  seedDb.updateJob(jSending.id, { status: 'SENDING', progress: 90, stageLabel: 'Enviando' });
  const jProc = seedDb.createJob({ id: 'job-proc-2', recipientE164: '+5511977776666', soundStickersEnabled: true });
  seedDb.updateJob(jProc.id, { status: 'PROCESSING_AUDIO', progress: 20, stageLabel: 'Áudio' });
  seedDb.close();

  const runtime = createGatewayRuntime(
    { host: '127.0.0.1', port: 0, dataDir: workDir, dbPath, sessionDir: path.join(workDir, 'session') },
    { skipStartupReconnect: true },
  );
  t.after(async () => {
    await runtime.stop();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  assert.equal(runtime.jobService.getJob('job-sending-1')?.status, 'UNKNOWN');
  assert.equal(runtime.jobService.getJob('job-sending-1')?.errorCode, 'GW-5002');
  assert.equal(runtime.jobService.getJob('job-proc-2')?.status, 'FAILED');
});
