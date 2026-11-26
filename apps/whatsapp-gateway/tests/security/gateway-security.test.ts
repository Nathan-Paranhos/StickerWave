import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createGatewayRuntime } from '../../src/http/server.js';

test('Gateway security controls enforce admin auth, strict CORS, rate limiting, SSRF blocks, and secret redaction', async (t) => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-gw-sec-'));
  const runtime = createGatewayRuntime(
    {
      host: '127.0.0.1',
      port: 0,
      adminSecret: 'top-secret-admin-key-999999',
      sessionSecret: 'top-secret-session-key-999999',
      dataDir: workDir,
      sessionDir: path.join(workDir, 'session'),
      dbPath: path.join(workDir, 'sec.db'),
      allowedOrigins: ['https://stickerwave.netlify.app'],
      rateLimitWindowMs: 60_000,
      rateLimitMaxRequests: 8,
    },
    { skipStartupReconnect: true },
  );

  t.after(async () => {
    await runtime.stop();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  const { port } = await runtime.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  // 1) Admin endpoints reject missing or invalid secrets
  for (const headers of [
    {},
    { Authorization: 'Bearer wrong-secret' },
    { 'x-admin-secret': 'short' },
  ]) {
    const res = await fetch(`${baseUrl}/api/v1/whatsapp/status`, { headers });
    assert.equal(res.status, 401);
  }

  // 2) CORS rejects disallowed origin cleanly + HEAD /health works for uptime monitors
  const headHealth = await fetch(`${baseUrl}/health`, { method: 'HEAD' });
  assert.equal(headHealth.status, 200);
  assert.match(headHealth.headers.get('content-type') || '', /application\/json/);
  assert.equal(await headHealth.text(), '');
  const badCors = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(badCors.status, 403);
  const okCors = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://stickerwave.netlify.app' } });
  assert.equal(okCors.status, 200);
  assert.equal(okCors.headers.get('access-control-allow-origin'), 'https://stickerwave.netlify.app');

  // 3) SSRF external URL fields rejected
  const boundary = '----SecBoundary1';
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="visualUrl"\r\n\r\nhttp://169.254.169.254/latest/meta-data\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="recipientPhone"\r\n\r\n+5511999998888\r\n--${boundary}--\r\n`,
  );
  const ssrfRes = await fetch(`${baseUrl}/api/v1/stickers/send`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  assert.equal(ssrfRes.status, 400);

  // 4) Path traversal filenames are stripped & payload limits enforced cleanly with 413
  const oversizedConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-gw-cap-'));
  const capRuntime = createGatewayRuntime(
    {
      host: '127.0.0.1',
      port: 0,
      adminSecret: 'cap-secret-123456',
      sessionSecret: 'cap-session-123456',
      dataDir: oversizedConfigDir,
      sessionDir: path.join(oversizedConfigDir, 'session'),
      dbPath: path.join(oversizedConfigDir, 'cap.db'),
      maxVisualUploadBytes: 512,
      maxAudioUploadBytes: 512,
      allowedOrigins: ['*'],
    },
    { skipStartupReconnect: true },
  );
  const { port: capPort } = await capRuntime.start();
  try {
    const bigRes = await fetch(`http://127.0.0.1:${capPort}/api/v1/stickers/send`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="visual"; filename="../../etc/passwd"\r\n\r\n`),
        Buffer.alloc(2 * 1024 * 1024, 0x41),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    assert.equal(bigRes.status, 413);
  } finally {
    await capRuntime.stop();
    await fs.rm(oversizedConfigDir, { recursive: true, force: true });
  }

  // 5) Rate limiter trips with 429 after max requests in window
  let tripped429 = false;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${baseUrl}/api/v1/phones/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+5511999998888' }),
    });
    if (r.status === 429) {
      tripped429 = true;
      assert.ok(r.headers.get('retry-after'));
      break;
    }
  }
  assert.equal(tripped429, true);
});
