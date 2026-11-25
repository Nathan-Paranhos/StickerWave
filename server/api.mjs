import { z } from 'zod';
import {
  buildSessionCookie, hashPassword, hashSessionToken, newSessionToken,
  parseCookies, publicUser, SESSION_COOKIE, SESSION_TTL_SECONDS, verifyPassword,
} from './auth.mjs';

const MAX_BODY_BYTES = 384 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOUND_ID_RE = /^[a-z0-9-]{1,64}$/;

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email().max(160),
  password: z.string().min(6).max(128),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
  password: z.string().min(1).max(128),
});

const projectSaveSchema = z.object({
  expectedRevision: z.number().int().min(0).nullable(),
  project: z.object({
    id: z.string().regex(UUID_RE),
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    revision: z.number().int().min(0),
    name: z.string().trim().min(1).max(80),
    createdAt: z.string(),
    updatedAt: z.string(),
  }).passthrough(),
});

const favoriteSchema = z.object({ favorite: z.boolean() });

function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  }).end(payload);
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function isSecureRequest(request) {
  const proto = request.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

function checkSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function resolveSession(prisma, request) {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  return { session, user: session.user, tokenHash };
}

async function createSessionForUser(prisma, userId, secure) {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await prisma.session.create({
    data: { tokenHash: hashSessionToken(token), userId, expiresAt },
  });
  return buildSessionCookie(token, { secure });
}

export async function handleApiRequest(request, response, pathname, prisma) {
  const method = request.method ?? 'GET';
  const secure = isSecureRequest(request);

  if (method !== 'GET' && method !== 'HEAD' && !checkSameOrigin(request)) {
    sendJson(response, 403, { error: 'Forbidden origin' });
    return;
  }

  try {
    if (pathname === '/api/health' && method === 'GET') {
      await prisma.$queryRaw`SELECT 1`;
      sendJson(response, 200, { ok: true });
      return;
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      const auth = await resolveSession(prisma, request);
      sendJson(response, 200, { user: auth ? publicUser(auth.user) : null });
      return;
    }

    if (pathname === '/api/auth/register' && method === 'POST') {
      const parsed = registerSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        sendJson(response, 400, { code: '7002', error: 'Invalid account details' });
        return;
      }
      const { name, email, password } = parsed.data;
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        sendJson(response, 409, { code: '7003', error: 'Email already registered' });
        return;
      }
      const passwordHash = await hashPassword(password);
      const user = await prisma.user.create({
        data: { name, email, passwordHash },
      });
      const cookie = await createSessionForUser(prisma, user.id, secure);
      sendJson(response, 201, { user: publicUser(user) }, { 'Set-Cookie': cookie });
      return;
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      const parsed = loginSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        sendJson(response, 400, { code: '7002', error: 'Invalid login format' });
        return;
      }
      const { email, password } = parsed.data;
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        sendJson(response, 401, { code: '7001', error: 'Invalid credentials' });
        return;
      }
      const cookie = await createSessionForUser(prisma, user.id, secure);
      sendJson(response, 200, { user: publicUser(user) }, { 'Set-Cookie': cookie });
      return;
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const cookies = parseCookies(request.headers.cookie);
      const token = cookies[SESSION_COOKIE];
      if (token) {
        await prisma.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
      }
      sendJson(response, 200, { ok: true }, { 'Set-Cookie': buildSessionCookie('', { secure, maxAge: 0 }) });
      return;
    }

    // Authenticated user routes below
    const auth = await resolveSession(prisma, request);
    if (!auth) {
      sendJson(response, 401, { code: '7001', error: 'Authentication required' });
      return;
    }
    const userId = auth.user.id;

    if (pathname === '/api/projects' && method === 'GET') {
      const rows = await prisma.projectRecord.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
      });
      const projects = rows.flatMap(row => {
        try { return [JSON.parse(row.data)]; } catch { return []; }
      });
      sendJson(response, 200, { projects });
      return;
    }

    if (pathname === '/api/projects' && method === 'DELETE') {
      await prisma.$transaction([
        prisma.projectRecord.deleteMany({ where: { userId } }),
        prisma.favoriteSound.deleteMany({ where: { userId } }),
      ]);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (pathname.startsWith('/api/projects/')) {
      const id = pathname.slice('/api/projects/'.length);
      if (!UUID_RE.test(id)) {
        sendJson(response, 400, { code: '4002', error: 'Invalid project id' });
        return;
      }

      if (method === 'GET') {
        const record = await prisma.projectRecord.findFirst({ where: { id, userId } });
        if (!record) {
          sendJson(response, 404, { error: 'Project not found' });
          return;
        }
        sendJson(response, 200, { project: JSON.parse(record.data) });
        return;
      }

      if (method === 'PUT') {
        const parsed = projectSaveSchema.safeParse(await readJson(request));
        if (!parsed.success || parsed.data.project.id !== id) {
          sendJson(response, 400, { code: '4002', error: 'Invalid project payload' });
          return;
        }
        const { expectedRevision, project } = parsed.data;
        const outcome = await prisma.$transaction(async tx => {
          const existing = await tx.projectRecord.findUnique({ where: { id } });
          if (existing && existing.userId !== userId) return { status: 403 };
          if ((existing?.revision ?? null) !== expectedRevision) return { status: 409 };
          const next = {
            ...project,
            revision: (expectedRevision ?? 0) + 1,
            updatedAt: new Date().toISOString(),
          };
          const serialized = JSON.stringify(next);
          await tx.projectRecord.upsert({
            where: { id },
            create: { id, userId, name: next.name, revision: next.revision, data: serialized },
            update: { name: next.name, revision: next.revision, data: serialized },
          });
          return { status: 200, project: next };
        });
        if (outcome.status === 403) {
          sendJson(response, 403, { error: 'Forbidden' });
          return;
        }
        if (outcome.status === 409) {
          sendJson(response, 409, { code: '4003', error: 'Revision conflict' });
          return;
        }
        sendJson(response, 200, { project: outcome.project });
        return;
      }

      if (method === 'DELETE') {
        await prisma.projectRecord.deleteMany({ where: { id, userId } });
        sendJson(response, 200, { ok: true });
        return;
      }
    }

    if (pathname === '/api/favorites' && method === 'GET') {
      const rows = await prisma.favoriteSound.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      sendJson(response, 200, { favorites: rows.map(r => r.soundId) });
      return;
    }

    if (pathname.startsWith('/api/favorites/') && method === 'PUT') {
      const soundId = pathname.slice('/api/favorites/'.length);
      if (!SOUND_ID_RE.test(soundId)) {
        sendJson(response, 400, { code: '4002', error: 'Invalid sound id' });
        return;
      }
      const parsed = favoriteSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        sendJson(response, 400, { code: '4002', error: 'Invalid payload' });
        return;
      }
      if (parsed.data.favorite) {
        await prisma.favoriteSound.upsert({
          where: { userId_soundId: { userId, soundId } },
          create: { userId, soundId },
          update: {},
        });
      } else {
        await prisma.favoriteSound.deleteMany({ where: { userId, soundId } });
      }
      sendJson(response, 200, { favorite: parsed.data.favorite });
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    const status = error?.status ?? 500;
    sendJson(response, status, { error: status >= 500 ? 'Internal server error' : error.message });
  }
}
