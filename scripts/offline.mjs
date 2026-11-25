import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const assets = [];
for (const file of (await readdir(join(dist, 'assets'))).sort()) {
  if (!/\.(?:[cm]?js|css|woff2)$/.test(file) || /^ffmpeg-core/.test(file)) continue;
  if ((await stat(join(dist, 'assets', file))).size <= 450 * 1024) assets.push('/assets/' + file);
}
const shell = ['/index.html', '/manifest.webmanifest', '/images/mark.svg', '/images/wavi.svg', '/images/wavi.webp',
  '/images/app-192.png', '/images/app-512.png', '/sounds/catalog.json', ...assets];
const version = createHash('sha256').update(JSON.stringify(assets)).update(await readFile(join(dist, 'index.html')))
  .update(await readFile(join(dist, 'sounds/catalog.json'))).digest('hex').slice(0, 16);
const script = `
const release = ${JSON.stringify(version)};
const shell = 'stickerwave-shell-' + release;
const local = 'stickerwave-resources-' + release;
const precache = ${JSON.stringify(shell)};
self.addEventListener('install', event => {
  event.waitUntil(caches.open(shell).then(cache => cache.addAll(precache.map(url => new Request(url, {cache:'reload'})))));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if ((key.startsWith('stickerwave-shell-') || key.startsWith('stickerwave-resources-')) && key !== shell && key !== local) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const path = new URL(request.url);
  if (request.method !== 'GET' || path.origin !== self.location.origin || path.pathname === '/download') return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.open(shell)).match('/index.html')));
    return;
  }
  if (precache.includes(path.pathname)) {
    event.respondWith((async () => (await (await caches.open(shell)).match(path.pathname)) || fetch(request))());
    return;
  }
  if (!/^\\/(?:assets|models|sounds)\\//.test(path.pathname) || /\\.blend$/.test(path.pathname)) return;
  const fullRequest = new Request(path.href);
  event.respondWith((async () => {
    const cache = await caches.open(local);
    const stored = await cache.match(fullRequest);
    if (stored) return stored;
    const result = await fetch(fullRequest);
    if (result.ok && result.status === 200 && Number(result.headers.get('content-length') || 0) < 40 * 1024 * 1024) {
      try {
        await cache.put(fullRequest, result.clone());
        const keys = await cache.keys();
        const sizes = await Promise.all(keys.map(async key => Number((await cache.match(key))?.headers.get('content-length') || 0)));
        let bytes = sizes.reduce((sum, size) => sum + size, 0);
        for (let index = 0; index < keys.length && (bytes > 64 * 1024 * 1024 || keys.length - index > 48); index++) {
          await cache.delete(keys[index]); bytes -= sizes[index];
        }
      } catch { /* storage may be full or unavailable */ }
    }
    return result;
  })());
});
`;
await writeFile(join(dist, 'sw.js'), script.trimStart());
