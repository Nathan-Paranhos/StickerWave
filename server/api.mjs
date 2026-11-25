import { z } from 'zod';
import {
  buildSessionCookie, hashPassword, hashSessionToken, newSessionToken,
  parseCookies, publicUser, SESSION_COOKIE, SESSION_TTL_SECONDS, verifyPassword,
} from './auth.mjs';
import { createPrismaStore, isDataStore } from './stores.mjs';

const MAX_BODY_BYTES = 384 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOUND_ID_RE = /^[a-z0-9-]{1,64}$/;

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email().max(160),
  password: z.string().min(6).max(128),
  confirmPassword: z.string().optional(),
}).refine(data => data.confirmPassword === undefined || data.password === data.confirmPassword, {
  message: 'Password mismatch',
  path: ['confirmPassword'],
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

function readHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) ?? '';
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function jsonResponse(status, body, headers = {}) {
  const payload = JSON.stringify(body);
  return {
    status,
    payload,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  };
}

async function readNodeBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
}

function parseJsonText(raw) {
  if (!raw.trim()) return {};
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    throw Object.assign(new Error('Payload too large'), { status: 413 });
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function isSecureRequest(headers, requestUrl) {
  const proto = readHeader(headers, 'x-forwarded-proto');
  if (proto.split(',')[0].trim() === 'https') return true;
  return typeof requestUrl === 'string' && requestUrl.startsWith('https://');
}

function checkSameOrigin(headers, requestUrl) {
  const origin = readHeader(headers, 'origin');
  if (!origin) return true;
  let urlHost = '';
  if (typeof requestUrl === 'string' && /^https?:\/\//i.test(requestUrl)) {
    try { urlHost = new URL(requestUrl).host; } catch { /* ignore */ }
  }
  const host = readHeader(headers, 'x-forwarded-host') || readHeader(headers, 'host') || urlHost;
  if (!host) return false;
  try {
    return new URL(origin).host === host.split(',')[0].trim();
  } catch {
    return false;
  }
}

function normalizeApiPath(pathname) {
  if (pathname.startsWith('/.netlify/functions/api')) {
    const rest = pathname.slice('/.netlify/functions/api'.length);
    if (!rest || rest === '/') return '/';
    return rest === '/api' || rest.startsWith('/api/') ? rest : `/api${rest.startsWith('/') ? rest : `/${rest}`}`;
  }
  return pathname || '/';
}

async function createSessionCookie(store, userId, secure) {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await store.createSession({ tokenHash: hashSessionToken(token), userId, expiresAt });
  return buildSessionCookie(token, { secure });
}

export async function handleApiCore({ method = 'GET', pathname, headers, bodyText = '', requestUrl, store }) {
  const normalizedPath = normalizeApiPath(pathname);
  const secure = isSecureRequest(headers, requestUrl);

  if (method !== 'GET' && method !== 'HEAD' && !checkSameOrigin(headers, requestUrl)) {
    return jsonResponse(403, { error: 'Forbidden origin' });
  }

  try {
    if (normalizedPath === '/api/health' && method === 'GET') {
      await store.ping();
      return jsonResponse(200, { ok: true });
    }

    const cookies = parseCookies(readHeader(headers, 'cookie'));
    const token = cookies[SESSION_COOKIE];

    if (normalizedPath === '/api/auth/me' && method === 'GET') {
      const auth = token ? await store.findSession(hashSessionToken(token)) : null;
      return jsonResponse(200, { user: auth ? publicUser(auth.user) : null });
    }

    if (normalizedPath === '/api/auth/register' && method === 'POST') {
      const parsed = registerSchema.safeParse(parseJsonText(bodyText));
      if (!parsed.success) {
        const mismatch = parsed.error.issues.some(issue => issue.path.includes('confirmPassword'));
        return jsonResponse(400, { code: mismatch ? '7005' : '7002', error: mismatch ? 'Passwords do not match' : 'Invalid account details' });
      }
      const { name, email, password } = parsed.data;
      const passwordHash = await hashPassword(password);
      const outcome = await store.createUser({ name, email, passwordHash });
      if (outcome.conflict) {
        return jsonResponse(409, { code: '7003', error: 'Email already registered' });
      }
      const cookie = await createSessionCookie(store, outcome.user.id, secure);
      return jsonResponse(201, { user: publicUser(outcome.user) }, { 'Set-Cookie': cookie });
    }

    if (normalizedPath === '/api/auth/login' && method === 'POST') {
      const parsed = loginSchema.safeParse(parseJsonText(bodyText));
      if (!parsed.success) {
        return jsonResponse(400, { code: '7002', error: 'Invalid login format' });
      }
      const { email, password } = parsed.data;
      const user = await store.findUserByEmail(email);
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return jsonResponse(401, { code: '7001', error: 'Invalid credentials' });
      }
      const cookie = await createSessionCookie(store, user.id, secure);
      return jsonResponse(200, { user: publicUser(user) }, { 'Set-Cookie': cookie });
    }

    if (normalizedPath === '/api/auth/logout' && method === 'POST') {
      if (token) await store.deleteSessionByHash(hashSessionToken(token));
      return jsonResponse(200, { ok: true }, { 'Set-Cookie': buildSessionCookie('', { secure, maxAge: 0 }) });
    }

    const auth = token ? await store.findSession(hashSessionToken(token)) : null;
    if (!auth) {
      return jsonResponse(401, { code: '7001', error: 'Authentication required' });
    }
    const userId = auth.user.id;

    if (normalizedPath === '/api/projects' && method === 'GET') {
      return jsonResponse(200, { projects: await store.listProjects(userId) });
    }

    if (normalizedPath === '/api/projects' && method === 'DELETE') {
      await store.deleteAllUserData(userId);
      return jsonResponse(200, { ok: true });
    }

    if (normalizedPath.startsWith('/api/projects/')) {
      const id = normalizedPath.slice('/api/projects/'.length);
      if (!UUID_RE.test(id)) {
        return jsonResponse(400, { code: '4002', error: 'Invalid project id' });
      }
      if (method === 'GET') {
        const project = await store.getProject(id, userId);
        return project ? jsonResponse(200, { project }) : jsonResponse(404, { error: 'Project not found' });
      }
      if (method === 'PUT') {
        const parsed = projectSaveSchema.safeParse(parseJsonText(bodyText));
        if (!parsed.success || parsed.data.project.id !== id) {
          return jsonResponse(400, { code: '4002', error: 'Invalid project payload' });
        }
        const outcome = await store.upsertProject({
          id,
          userId,
          project: parsed.data.project,
          expectedRevision: parsed.data.expectedRevision,
        });
        if (outcome.status === 403) return jsonResponse(403, { error: 'Forbidden' });
        if (outcome.status === 409) return jsonResponse(409, { code: '4003', error: 'Revision conflict' });
        return jsonResponse(200, { project: outcome.project });
      }
      if (method === 'DELETE') {
        await store.deleteProject(id, userId);
        return jsonResponse(200, { ok: true });
      }
    }

    if (normalizedPath === '/api/favorites' && method === 'GET') {
      return jsonResponse(200, { favorites: await store.listFavorites(userId) });
    }

    if (normalizedPath.startsWith('/api/favorites/') && method === 'PUT') {
      const soundId = decodeURIComponent(normalizedPath.slice('/api/favorites/'.length));
      if (!SOUND_ID_RE.test(soundId)) {
        return jsonResponse(400, { code: '4002', error: 'Invalid sound id' });
      }
      const parsed = favoriteSchema.safeParse(parseJsonText(bodyText));
      if (!parsed.success) {
        return jsonResponse(400, { code: '4002', error: 'Invalid payload' });
      }
      await store.setFavorite(userId, soundId, parsed.data.favorite);
      return jsonResponse(200, { favorite: parsed.data.favorite });
    }

    return jsonResponse(404, { error: 'Not found' });
  } catch (error) {
    const status = error?.status ?? 500;
    return jsonResponse(status, { error: status >= 500 ? 'Internal server error' : error.message });
  }
}

export async function handleApiRequest(request, response, pathname, dbOrStore) {
  const store = isDataStore(dbOrStore) ? dbOrStore : createPrismaStore(dbOrStore);
  let res;
  try {
    const bodyText = request.method !== 'GET' && request.method !== 'HEAD' ? await readNodeBody(request) : '';
    res = await handleApiCore({
      method: request.method ?? 'GET',
      pathname,
      headers: request.headers,
      bodyText,
      requestUrl: request.url,
      store,
    });
  } catch (error) {
    const status = error?.status ?? 500;
    res = jsonResponse(status, { error: status >= 500 ? 'Internal server error' : error.message });
  }
  response.writeHead(res.status, {
    ...res.headers,
    'Content-Length': Buffer.byteLength(res.payload),
  }).end(res.payload);
}

export async function handleWebApiRequest(request, dbOrStore) {
  const store = isDataStore(dbOrStore) ? dbOrStore : createPrismaStore(dbOrStore);
  const url = new URL(request.url);
  const bodyText = request.method !== 'GET' && request.method !== 'HEAD' ? await request.text() : '';
  const res = await handleApiCore({
    method: request.method,
    pathname: decodeURIComponent(url.pathname),
    headers: request.headers,
    bodyText,
    requestUrl: request.url,
    store,
  });
  return new Response(res.payload, { status: res.status, headers: res.headers });
}
