import type { Project } from '../core/project';
import { logWarn } from './logger';
import { clearVaultSession, readVaultSession, vaultLogin, vaultRegister } from './vault';

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
};

type JsonFetchResult<T> = {
  status: number;
  data: T | null;
  isJson: boolean;
  networkError: boolean;
};

async function apiJson<T>(url: string, init: RequestInit = {}): Promise<JsonFetchResult<T>> {
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const contentType = response.headers.get('content-type') ?? '';
    const isJson = contentType.toLowerCase().includes('application/json');
    let data: T | null = null;
    if (isJson) {
      try { data = (await response.json()) as T; } catch { data = null; }
    }
    return { status: response.status, data, isJson: isJson && data !== null, networkError: false };
  } catch {
    return { status: 0, data: null, isJson: false, networkError: true };
  }
}

function backendUnavailable<T>(res: JsonFetchResult<T>): boolean {
  return res.networkError || !res.isJson || res.status === 405 || res.status === 501 || (res.status === 404 && !res.isJson);
}

const CACHED_USER_KEY = 'stickerwave:cachedUser';
const AUTH_MODE_KEY = 'stickerwave:authMode';

function setAuthMode(mode: 'remote' | 'local' | null) {
  try {
    if (mode) localStorage.setItem(AUTH_MODE_KEY, mode);
    else localStorage.removeItem(AUTH_MODE_KEY);
  } catch { /* storage optional */ }
}

export function isRemoteAccountMode(): boolean {
  try {
    return localStorage.getItem(AUTH_MODE_KEY) !== 'local';
  } catch {
    return true;
  }
}

function readCachedUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(CACHED_USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser;
    return parsed?.id && parsed?.email ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedUser(user: AuthUser | null) {
  try {
    if (user) localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(CACHED_USER_KEY);
  } catch { /* storage optional */ }
}

export async function fetchCurrentUser(): Promise<AuthUser | null> {
  if (!isRemoteAccountMode()) {
    const local = readVaultSession();
    if (local) return local;
  }
  const res = await apiJson<{ user: AuthUser | null }>('/api/auth/me', { method: 'GET' });
  if (!backendUnavailable(res)) {
    if (res.status === 200) {
      const current = res.data?.user ?? null;
      if (current) setAuthMode('remote');
      writeCachedUser(current);
      return current;
    }
    writeCachedUser(null);
    return null;
  }
  const vaultUser = readVaultSession();
  if (vaultUser) {
    setAuthMode('local');
    return vaultUser;
  }
  return navigator.onLine === false ? readCachedUser() : null;
}

export async function registerAccount(input: { name: string; email: string; password: string; confirmPassword?: string }): Promise<AuthUser> {
  if (input.confirmPassword !== undefined && input.password !== input.confirmPassword) {
    throw new Error('7005');
  }
  const res = await apiJson<{ user?: AuthUser; code?: string }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!backendUnavailable(res)) {
    if (res.status === 201 && res.data?.user) {
      setAuthMode('remote');
      writeCachedUser(res.data.user);
      return res.data.user;
    }
    if (res.status === 409) throw new Error('7003');
    if (res.status === 400) throw new Error(res.data?.code === '7005' ? '7005' : '7002');
    throw new Error('7004');
  }
  const localUser = await vaultRegister(input);
  setAuthMode('local');
  writeCachedUser(localUser);
  return localUser;
}

export async function loginAccount(input: { email: string; password: string }): Promise<AuthUser> {
  const res = await apiJson<{ user?: AuthUser; code?: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!backendUnavailable(res)) {
    if (res.status === 200 && res.data?.user) {
      setAuthMode('remote');
      writeCachedUser(res.data.user);
      return res.data.user;
    }
    if (res.status === 401) throw new Error('7001');
    if (res.status === 400) throw new Error('7002');
    throw new Error('7004');
  }
  const localUser = await vaultLogin(input);
  setAuthMode('local');
  writeCachedUser(localUser);
  return localUser;
}

export async function logoutAccount(): Promise<void> {
  const wasRemote = isRemoteAccountMode();
  writeCachedUser(null);
  clearVaultSession();
  setAuthMode(null);
  if (wasRemote) {
    await apiJson('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
  }
}

export async function apiListProjects(): Promise<Project[]> {
  const res = await apiJson<{ projects?: Project[]; error?: string }>('/api/projects', { method: 'GET' });
  if (backendUnavailable(res)) { setAuthMode('local'); throw new Error('7004'); }
  if (res.status === 401) throw new Error('7001');
  if (res.status !== 200 || !res.data?.projects) {
    logWarn('api.projects', 'list_failed', { code: '4002', detail: res.data?.error, meta: { status: res.status } });
    throw new Error('4002');
  }
  return res.data.projects;
}

export async function apiLoadProject(id: string): Promise<Project | null> {
  const res = await apiJson<{ project?: Project; error?: string }>(`/api/projects/${id}`, { method: 'GET' });
  if (backendUnavailable(res)) { setAuthMode('local'); throw new Error('7004'); }
  if (res.status === 404) return null;
  if (res.status === 401) throw new Error('7001');
  if (res.status !== 200 || !res.data?.project) {
    logWarn('api.projects', 'load_failed', { code: '4002', detail: res.data?.error, meta: { status: res.status, id: id.slice(0, 8) } });
    throw new Error('4002');
  }
  return res.data.project;
}

export async function apiSaveProject(project: Project, expectedRevision: number | null): Promise<Project> {
  const res = await apiJson<{ project?: Project; code?: string; error?: string }>(`/api/projects/${project.id}`, {
    method: 'PUT',
    body: JSON.stringify({ project, expectedRevision }),
  });
  if (backendUnavailable(res)) { setAuthMode('local'); throw new Error('7004'); }
  if (res.status === 409) {
    logWarn('api.projects', 'save_conflict', { code: '4003', meta: { id: project.id.slice(0, 8), expectedRevision } });
    throw new Error('4003');
  }
  if (res.status === 401) throw new Error('7001');
  if (res.status !== 200 || !res.data?.project) {
    logWarn('api.projects', 'save_failed', { code: res.data?.code ?? '4002', detail: res.data?.error, meta: { status: res.status, id: project.id.slice(0, 8), expectedRevision } });
    throw new Error(res.data?.code ?? '4002');
  }
  return res.data.project;
}

export async function apiDeleteProject(id?: string): Promise<void> {
  const res = await apiJson(id ? `/api/projects/${id}` : '/api/projects', { method: 'DELETE' });
  if (backendUnavailable(res)) { setAuthMode('local'); throw new Error('7004'); }
  if (res.status === 401) throw new Error('7001');
  if (res.status >= 400) throw new Error('4001');
}

export async function apiListFavorites(): Promise<string[]> {
  const res = await apiJson<{ favorites?: string[] }>('/api/favorites', { method: 'GET' });
  if (backendUnavailable(res)) { setAuthMode('local'); throw new Error('7004'); }
  if (res.status === 401) throw new Error('7001');
  if (res.status !== 200 || !res.data?.favorites) throw new Error('4001');
  return res.data.favorites;
}

export async function apiSetFavorite(soundId: string, favorite: boolean): Promise<void> {
  const res = await apiJson(`/api/favorites/${encodeURIComponent(soundId)}`, {
    method: 'PUT',
    body: JSON.stringify({ favorite }),
  });
  if (backendUnavailable(res)) { setAuthMode('local'); throw new Error('7004'); }
  if (res.status === 401) throw new Error('7001');
  if (res.status >= 400) throw new Error('4001');
}
