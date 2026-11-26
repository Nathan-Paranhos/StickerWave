import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleApiRequest } from '../server/api.mjs';
import { createPrismaClient, ensureSqliteSchema, getPrisma } from '../server/db.mjs';

const distribution = fileURLToPath(new URL('../dist', import.meta.url));
const mediaTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.png': 'image/png', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
};

export function createDistributionServer({ download, databaseUrl, prisma: externalPrisma, gatewayUrl = process.env.GATEWAY_URL || 'http://127.0.0.1:3001' } = {}) {
  const ownsPrisma = !externalPrisma && Boolean(databaseUrl);
  const prisma = externalPrisma ?? (databaseUrl ? createPrismaClient(databaseUrl) : getPrisma());
  const ready = ensureSqliteSchema(prisma).catch(() => undefined);

  const server = createServer(async (request, response) => {
    try {
      const parsedUrl = new URL(request.url ?? '/', 'http://localhost');
      const pathname = decodeURIComponent(parsedUrl.pathname);
      if (pathname.startsWith('/gateway/')) {
        const targetUrl = new URL(pathname.replace(/^\/gateway/, '') + parsedUrl.search, gatewayUrl);
        const requester = targetUrl.protocol === 'https:' ? httpsRequest : httpRequest;
        const headers = { ...request.headers, host: targetUrl.host };
        const proxyReq = requester(
          targetUrl,
          { method: request.method, headers },
          proxyRes => {
            response.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(response);
          },
        );
        proxyReq.on('error', () => {
          if (!response.headersSent) {
            response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          }
          response.end(JSON.stringify({ ok: false, code: 'GW-5030', message: 'StickerWave WhatsApp Gateway inacessível.' }));
        });
        request.pipe(proxyReq);
        return;
      }
      if (pathname.startsWith('/api/')) {
        await ready;
        await handleApiRequest(request, response, pathname, prisma);
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      if (download && pathname === '/download') {
        const info = await stat(download.path).catch(() => null);
        if (!info?.isFile()) { response.writeHead(404).end(); return; }
        response.writeHead(200, {
          ...securityHeaders, 'Content-Type': 'application/zip', 'Content-Length': info.size,
          'Content-Disposition': `attachment; filename="${download.name}"`, 'Cache-Control': 'no-store',
        });
        if (request.method === 'HEAD') response.end();
        else createReadStream(download.path).on('error', error => response.destroy(error)).pipe(response);
        return;
      }
      let file = resolve(distribution, '.' + pathname);
      if (!file.startsWith(distribution + sep) && file !== distribution) {
        response.writeHead(404).end();
        return;
      }
      let info = await stat(file).catch(() => null);
      if (!info?.isFile() && (!extname(pathname) && !pathname.startsWith('/assets/') && !pathname.startsWith('/sounds/'))) {
        file = resolve(distribution, 'index.html');
        info = await stat(file).catch(() => null);
      }
      if (!info?.isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, {
        ...securityHeaders,
        'Content-Type': mediaTypes[extname(file)] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      if (request.method === 'HEAD') response.end();
      else createReadStream(file).on('error', error => response.destroy(error)).pipe(response);
    } catch { response.writeHead(400).end(); }
  });
  server.on('close', () => {
    if (ownsPrisma) void prisma.$disconnect().catch(() => undefined);
  });
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.argv[2] ?? 4173);
  createDistributionServer().listen(port, '127.0.0.1', () => {
    process.stdout.write(`StickerWave: http://127.0.0.1:${port}/\n`);
  });
}
