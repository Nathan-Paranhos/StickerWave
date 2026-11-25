import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDistributionServer } from '../scripts/serve.mjs';
import { handleWebApiRequest } from '../server/api.mjs';
import { createBlobsStore } from '../server/stores.mjs';

function createMemoryBlobs() {
  const entries = new Map<string, { json: string; etag: string }>();
  let seq = 0;
  return {
    async list({ prefix = '' } = {}) {
      const blobs = [...entries.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, etag: value.etag }));
      return { blobs, directories: [] };
    },
    async get(key: string) {
      const item = entries.get(key);
      return item ? JSON.parse(item.json) : null;
    },
    async getWithMetadata(key: string) {
      const item = entries.get(key);
      return item ? { data: JSON.parse(item.json), etag: item.etag, metadata: {} } : null;
    },
    async setJSON(key: string, data: unknown, options: { onlyIfNew?: boolean; onlyIfMatch?: string } = {}) {
      const current = entries.get(key);
      if (options.onlyIfNew && current) return { modified: false };
      if (options.onlyIfMatch !== undefined && (!current || current.etag !== options.onlyIfMatch)) {
        return { modified: false };
      }
      const etag = `etag-${++seq}`;
      entries.set(key, { json: JSON.stringify(data), etag });
      return { modified: true, etag };
    },
    async delete(key: string) {
      entries.delete(key);
    },
  };
}

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return '';
  return setCookie.split(';')[0];
}

test('auth, sessions, optimistic concurrency and multi-user isolation work via Prisma SQLite', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stickerwave-prisma-'));
  const dbPath = join(dir, 'test.db').replace(/\\/g, '/');
  const server = createDistributionServer({ databaseUrl: `file:${dbPath}` });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  // Health & protected route enforcement
  const health = await fetch(origin + '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal((await fetch(origin + '/api/projects')).status, 401);
  assert.equal((await fetch(origin + '/api/favorites')).status, 401);

  // Registration validation & duplicate check
  const badReg = await fetch(origin + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'A', email: 'bad', password: '123' }),
  });
  assert.equal(badReg.status, 400);

  const badConfirm = await fetch(origin + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice', email: 'alice-mismatch@example.com', password: 'secret123', confirmPassword: 'different' }),
  });
  assert.equal(badConfirm.status, 400);
  assert.equal((await badConfirm.json()).code, '7005');

  const regA = await fetch(origin + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice Silva', email: 'alice@example.com', password: 'secret123' }),
  });
  assert.equal(regA.status, 201);
  const cookieA = extractCookie(regA);
  assert.match(cookieA, /^sw_session=/);
  const aliceBody = await regA.json();
  assert.equal(aliceBody.user.email, 'alice@example.com');
  assert.equal('passwordHash' in aliceBody.user, false);

  const dupReg = await fetch(origin + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Outra Alice', email: 'ALICE@example.com', password: 'secret123' }),
  });
  assert.equal(dupReg.status, 409);

  // Wrong password -> 401; /api/auth/me -> Alice
  const badLogin = await fetch(origin + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'wrong' }),
  });
  assert.equal(badLogin.status, 401);

  const meA = await fetch(origin + '/api/auth/me', { headers: { Cookie: cookieA } });
  assert.equal((await meA.json()).user.name, 'Alice Silva');

  // Create & update project + optimistic locking
  const projectId = crypto.randomUUID();
  const baseProject = {
    schemaVersion: 2,
    id: projectId,
    revision: 0,
    name: 'Figurinha da Alice',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const save1 = await fetch(`${origin}/api/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieA },
    body: JSON.stringify({ expectedRevision: null, project: baseProject }),
  });
  assert.equal(save1.status, 200);
  const saved1 = (await save1.json()).project;
  assert.equal(saved1.revision, 1);

  const staleSave = await fetch(`${origin}/api/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieA },
    body: JSON.stringify({ expectedRevision: 0, project: saved1 }),
  });
  assert.equal(staleSave.status, 409);

  // Favorites per user
  const favPut = await fetch(`${origin}/api/favorites/pop`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieA },
    body: JSON.stringify({ favorite: true }),
  });
  assert.equal(favPut.status, 200);
  assert.deepEqual(await (await fetch(origin + '/api/favorites', { headers: { Cookie: cookieA } })).json(), { favorites: ['pop'] });

  // Register User B -> verify strict isolation
  const regB = await fetch(origin + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bruno Souza', email: 'bruno@example.com', password: 'secret456' }),
  });
  assert.equal(regB.status, 201);
  const cookieB = extractCookie(regB);
  assert.deepEqual((await (await fetch(origin + '/api/projects', { headers: { Cookie: cookieB } })).json()).projects, []);
  assert.deepEqual(await (await fetch(origin + '/api/favorites', { headers: { Cookie: cookieB } })).json(), { favorites: [] });
  assert.equal((await fetch(`${origin}/api/projects/${projectId}`, { headers: { Cookie: cookieB } })).status, 404);
  assert.equal((await fetch(`${origin}/api/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieB },
    body: JSON.stringify({ expectedRevision: 1, project: saved1 }),
  })).status, 403);

  // Logout invalidates session
  const logoutA = await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookieA } });
  assert.equal(logoutA.status, 200);
  assert.equal((await fetch(origin + '/api/projects', { headers: { Cookie: cookieA } })).status, 401);
});

test('Netlify Web API handler and Blobs store handle auth, rewritten paths, projects and favorites', async () => {
  const store = createBlobsStore(createMemoryBlobs());
  const callApi = (path: string, init: RequestInit = {}) =>
    handleWebApiRequest(new Request(`https://stickerwave.netlify.app${path}`, init), store);

  assert.equal((await callApi('/api/health')).status, 200);
  assert.equal((await callApi('/api/projects')).status, 401);

  const crossOrigin = await callApi('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ name: 'Eva', email: 'eva@example.com', password: 'secret123', confirmPassword: 'secret123' }),
  });
  assert.equal(crossOrigin.status, 403);

  // Supports Netlify _redirects rewritten path (/.netlify/functions/api/:splat)
  const reg = await callApi('/.netlify/functions/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://stickerwave.netlify.app' },
    body: JSON.stringify({ name: 'Clara', email: 'clara@example.com', password: 'secret123', confirmPassword: 'secret123' }),
  });
  assert.equal(reg.status, 201);
  const setCookie = reg.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /Secure/);
  const cookieClara = setCookie.split(';')[0];

  const dup = await callApi('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Clara 2', email: 'CLARA@example.com', password: 'secret123', confirmPassword: 'secret123' }),
  });
  assert.equal(dup.status, 409);

  const projectId = crypto.randomUUID();
  const baseProject = {
    schemaVersion: 2,
    id: projectId,
    revision: 0,
    name: 'Figurinha Blobs',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const put1 = await callApi(`/.netlify/functions/api/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieClara },
    body: JSON.stringify({ expectedRevision: null, project: baseProject }),
  });
  assert.equal(put1.status, 200);
  const saved = (await put1.json()).project;
  assert.equal(saved.revision, 1);

  const stale = await callApi(`/api/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieClara },
    body: JSON.stringify({ expectedRevision: 0, project: saved }),
  });
  assert.equal(stale.status, 409);

  await callApi('/api/favorites/clap', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieClara },
    body: JSON.stringify({ favorite: true }),
  });
  assert.deepEqual(await (await callApi('/api/favorites', { headers: { Cookie: cookieClara } })).json(), { favorites: ['clap'] });

  const reg2 = await callApi('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Daniel', email: 'daniel@example.com', password: 'secret456' }),
  });
  const cookieDaniel = (reg2.headers.get('set-cookie') ?? '').split(';')[0];
  assert.equal((await callApi(`/api/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieDaniel },
    body: JSON.stringify({ expectedRevision: 1, project: saved }),
  })).status, 403);

  assert.equal((await callApi('/api/projects', { method: 'DELETE', headers: { Cookie: cookieClara } })).status, 200);
  assert.deepEqual((await (await callApi('/api/projects', { headers: { Cookie: cookieClara } })).json()).projects, []);
  assert.deepEqual(await (await callApi('/api/favorites', { headers: { Cookie: cookieClara } })).json(), { favorites: [] });
});
