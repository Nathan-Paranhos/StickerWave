import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDistributionServer } from '../scripts/serve.mjs';

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
