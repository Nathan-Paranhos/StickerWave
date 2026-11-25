import type { Project } from '../core/project';

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
};

async function apiJson<T>(url: string, init: RequestInit = {}): Promise<{ status: number; data: T | null }> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  let data: T | null = null;
  try {
    data = (await response.json()) as T;
  } catch {
    data = null;
  }
  return { status: response.status, data };
}

const CACHED_USER_KEY = 'stickerwave:cachedUser';

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
  try {
    const { status, data } = await apiJson<{ user: AuthUser | null }>('/api/auth/me', { method: 'GET' });
    if (status === 200) {
      const current = data?.user ?? null;
      writeCachedUser(current);
      return current;
    }
    writeCachedUser(null);
    return null;
  } catch {
    return navigator.onLine === false ? readCachedUser() : null;
  }
}

export async function registerAccount(input: { name: string; email: string; password: string }): Promise<AuthUser> {
  let res;
  try {
    res = await apiJson<{ user?: AuthUser; code?: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  } catch {
    throw new Error('7004');
  }
  if (res.status === 201 && res.data?.user) {
    writeCachedUser(res.data.user);
    return res.data.user;
  }
  if (res.status === 409) throw new Error('7003');
  if (res.status === 400) throw new Error('7002');
  throw new Error('7004');
}

export async function loginAccount(input: { email: string; password: string }): Promise<AuthUser> {
  let res;
  try {
    res = await apiJson<{ user?: AuthUser; code?: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  } catch {
    throw new Error('7004');
  }
  if (res.status === 200 && res.data?.user) {
    writeCachedUser(res.data.user);
    return res.data.user;
  }
  if (res.status === 401) throw new Error('7001');
  if (res.status === 400) throw new Error('7002');
  throw new Error('7004');
}

export async function logoutAccount(): Promise<void> {
  writeCachedUser(null);
  try {
    await apiJson('/api/auth/logout', { method: 'POST', body: '{}' });
  } catch {
    /* ignore network error when clearing client session */
  }
}

export async function apiListProjects(): Promise<Project[]> {
  const { status, data } = await apiJson<{ projects?: Project[] }>('/api/projects', { method: 'GET' });
  if (status === 401) throw new Error('7001');
  if (status !== 200 || !data?.projects) throw new Error('4002');
  return data.projects;
}

export async function apiLoadProject(id: string): Promise<Project | null> {
  const { status, data } = await apiJson<{ project?: Project }>(`/api/projects/${id}`, { method: 'GET' });
  if (status === 404) return null;
  if (status === 401) throw new Error('7001');
  if (status !== 200 || !data?.project) throw new Error('4002');
  return data.project;
}

export async function apiSaveProject(project: Project, expectedRevision: number | null): Promise<Project> {
  const { status, data } = await apiJson<{ project?: Project; code?: string }>(`/api/projects/${project.id}`, {
    method: 'PUT',
    body: JSON.stringify({ project, expectedRevision }),
  });
  if (status === 409) throw new Error('4003');
  if (status === 401) throw new Error('7001');
  if (status !== 200 || !data?.project) throw new Error(data?.code ?? '4002');
  return data.project;
}

export async function apiDeleteProject(id?: string): Promise<void> {
  const { status } = await apiJson(id ? `/api/projects/${id}` : '/api/projects', { method: 'DELETE' });
  if (status === 401) throw new Error('7001');
  if (status >= 400) throw new Error('4001');
}

export async function apiListFavorites(): Promise<string[]> {
  const { status, data } = await apiJson<{ favorites?: string[] }>('/api/favorites', { method: 'GET' });
  if (status === 401) throw new Error('7001');
  if (status !== 200 || !data?.favorites) throw new Error('4001');
  return data.favorites;
}

export async function apiSetFavorite(soundId: string, favorite: boolean): Promise<void> {
  const { status } = await apiJson(`/api/favorites/${encodeURIComponent(soundId)}`, {
    method: 'PUT',
    body: JSON.stringify({ favorite }),
  });
  if (status === 401) throw new Error('7001');
  if (status >= 400) throw new Error('4001');
}
