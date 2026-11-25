import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDistributionServer } from '../scripts/serve.mjs';

test('the production build serves deep links, assets, security headers and protected API', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stickerwave-dist-'));
  const dbUrl = `file:${join(dir, 'dist.db').replace(/\\/g, '/')}`;
  const server = createDistributionServer({ databaseUrl: dbUrl });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/', '/auth', '/studio', '/studio/00000000-0000-4000-8000-000000000000', '/sounds', '/favorites', '/projects', '/docs', '/privacy', '/licenses', '/contribute', '/about']) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await response.text(), /<div id="root"><\/div>/);
  }
  const manifest = await fetch(origin + '/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).display, 'standalone');
  const serviceWorker = await fetch(origin + '/sw.js');
  assert.match(serviceWorker.headers.get('content-type'), /javascript/);
  assert.match(await serviceWorker.text(), /stickerwave-shell-/);
  const model = await fetch(origin + '/models/wavi.glb');
  assert.match(model.headers.get('content-type'), /model\/gltf-binary/);
  assert.equal(Buffer.from(await model.arrayBuffer()).subarray(0, 4).toString(), 'glTF');
  const catalog = await fetch(origin + '/sounds/catalog.json').then(response => response.json());
  assert.equal(catalog.sounds.length, 120);
  for (const sound of catalog.sounds) {
    const response = await fetch(origin + sound.url);
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    assert.equal((await response.arrayBuffer()).byteLength, sound.sizeBytes);
  }
  assert.equal((await fetch(origin + '/api/health')).status, 200);
  assert.equal((await fetch(origin + '/api/projects')).status, 401);
  assert.equal((await fetch(origin + '/assets/missing.js')).status, 404);
  assert.equal((await fetch(origin + '/sounds/missing.wav')).status, 404);
  assert.equal((await fetch(origin + '/', { method: 'POST' })).status, 405);
});
