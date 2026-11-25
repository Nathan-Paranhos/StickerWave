import { projectRefs, projectSchema, validateAssets, type Project, type StoredAsset } from '../core/project';
import { apiDeleteProject, apiListFavorites, apiListProjects, apiLoadProject, apiSaveProject, apiSetFavorite, isRemoteAccountMode } from './api';

const databases = new Map<string, Promise<IDBDatabase>>();
let activeUserId: string | null = null;

export function setStorageUser(userId: string | null) {
  activeUserId = userId;
}

function remoteActive() {
  return Boolean(activeUserId && isRemoteAccountMode() && typeof window !== 'undefined' && typeof fetch === 'function' && navigator.onLine !== false);
}

function dbName() {
  return activeUserId ? `stickerwave:${activeUserId}` : 'stickerwave';
}

function open() {
  const name = dbName();
  let database = databases.get(name);
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = ({ oldVersion }) => {
        if (oldVersion < 1) {
          request.result.createObjectStore('projects', { keyPath: 'id' });
          request.result.createObjectStore('assets', { keyPath: 'id' }).createIndex('hash', 'sha256');
        }
        if (oldVersion < 2) {
          request.result.createObjectStore('library', { keyPath: 'id' });
          request.result.createObjectStore('favorites');
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); databases.delete(name); };
        resolve(request.result);
      };
    }).catch(error => { databases.delete(name); throw error; });
    databases.set(name, database);
  }
  return database;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function completed(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('4002'));
  });
}

export async function load(id: string): Promise<{ project: Project; assets: ReadonlyMap<string, StoredAsset>; missingLocalMedia?: boolean } | null> {
  const tx = (await open()).transaction(['projects', 'assets']);
  const localRaw = await result(tx.objectStore('projects').get(id));
  let remoteProject: Project | null = null;
  if (remoteActive()) {
    try {
      const fetched = await apiLoadProject(id);
      if (fetched) remoteProject = projectSchema.parse(fetched);
    } catch (error) {
      if (error instanceof Error && error.message === '7001') throw error;
    }
  }
  const raw = remoteProject && (!localRaw || remoteProject.revision >= (localRaw.revision ?? 0)) ? remoteProject : localRaw;
  if (!raw) return null;
  const project = projectSchema.parse(raw);
  const assetsTx = (await open()).transaction('assets');
  const assets = await Promise.all(projectRefs(project).map(ref => result<StoredAsset>(assetsTx.objectStore('assets').get(ref))));
  const collection = new Map(assets.filter(Boolean).map(asset => [asset.id, asset]));
  if (activeUserId && remoteProject && !localRaw && collection.size < projectRefs(project).length) {
    return { project, assets: collection, missingLocalMedia: true };
  }
  validateAssets(project, collection);
  return { project, assets: collection };
}

export async function listProjects() {
  if (remoteActive()) {
    try {
      const list = await apiListProjects();
      return list.flatMap(item => {
        const parsed = projectSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      });
    } catch (error) {
      if (error instanceof Error && error.message === '7001') throw error;
    }
  }
  const tx = (await open()).transaction('projects');
  const raw = await result(tx.objectStore('projects').getAll());
  return raw.flatMap(item => {
    const parsed = projectSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function save(project: Project, assets: ReadonlyMap<string, StoredAsset>, expectedRevision: number | null) {
  let next = projectSchema.parse({ ...project, revision: (expectedRevision ?? 0) + 1, updatedAt: new Date().toISOString() });
  validateAssets(next, assets);

  if (remoteActive()) {
    try {
      const savedRemote = await apiSaveProject(next, expectedRevision);
      next = projectSchema.parse(savedRemote);
    } catch (error) {
      if (error instanceof Error && ['4003', '7001', '4002'].includes(error.message)) throw error;
    }
  }

  const tx = (await open()).transaction(['projects', 'assets'], 'readwrite');
  const done = completed(tx);
  // Attach a rejection handler before the revision read, including when a browser aborts the read.
  void done.catch(() => undefined);
  const projects = tx.objectStore('projects');
  const existing = await result<Project | undefined>(projects.get(next.id));
  if (!remoteActive() && (existing?.revision ?? null) !== expectedRevision) {
    tx.abort();
    throw new Error('4003');
  }
  const store = tx.objectStore('assets');
  for (const id of projectRefs(next)) {
    const asset = assets.get(id)!;
    const current = await result<StoredAsset | undefined>(store.get(id));
    if (!current) store.put(asset);
    else if (current.sha256 !== asset.sha256) { tx.abort(); throw new Error('4002'); }
  }
  projects.put(next);
  const all = await result<Project[]>(projects.getAll());
  const used = new Set(all.flatMap(projectRefs));
  const keys = await result(store.getAllKeys());
  for (const key of keys) if (typeof key === 'string' && !used.has(key)) store.delete(key);
  await done;
  return next;
}

export async function removeProject(id?: string) {
  if (remoteActive()) {
    try {
      await apiDeleteProject(id);
    } catch (error) {
      if (error instanceof Error && error.message === '7001') throw error;
    }
  }
  const tx = (await open()).transaction(id ? ['projects', 'assets'] : ['projects', 'assets', 'favorites', 'library'], 'readwrite');
  const done = completed(tx);
  void done.catch(() => undefined);
  const projects = tx.objectStore('projects');
  const assets = tx.objectStore('assets');
  if (!id) {
    projects.clear();
    assets.clear();
    tx.objectStore('favorites').clear();
    tx.objectStore('library').clear();
  } else {
    projects.delete(id);
    const remaining = new Set((await result<Project[]>(projects.getAll())).flatMap(projectRefs));
    for (const key of await result(assets.getAllKeys())) {
      if (typeof key === 'string' && !remaining.has(key)) assets.delete(key);
    }
  }
  await done;
}

export async function favoriteIds() {
  if (remoteActive()) {
    try {
      return await apiListFavorites();
    } catch (error) {
      if (error instanceof Error && error.message === '7001') throw error;
    }
  }
  const tx = (await open()).transaction('favorites');
  return (await result(tx.objectStore('favorites').getAllKeys())).filter((id): id is string => typeof id === 'string');
}

export async function changeFavorite(id: string, value: boolean) {
  if (remoteActive()) {
    try {
      await apiSetFavorite(id, value);
    } catch (error) {
      if (!(error instanceof Error && error.message === '7004')) throw error;
    }
  }
  const tx = (await open()).transaction('favorites', 'readwrite');
  const done = completed(tx);
  const store = tx.objectStore('favorites');
  if (value) store.put(true, id); else store.delete(id);
  await done;
  globalThis.window?.dispatchEvent(new Event('stickerwave:library'));
}

export async function personalSounds() {
  const tx = (await open()).transaction('library');
  return result<StoredAsset[]>(tx.objectStore('library').getAll());
}

export async function personalSound(id: string) {
  const tx = (await open()).transaction('library');
  return result<StoredAsset | undefined>(tx.objectStore('library').get(id));
}

export async function keepSound(asset: StoredAsset) {
  if (!asset.mime.startsWith('audio/')) throw new Error('1001');
  const tx = (await open()).transaction('library', 'readwrite');
  const done = completed(tx);
  void done.catch(() => undefined);
  const store = tx.objectStore('library');
  const list = await result<StoredAsset[]>(store.getAll());
  if (list.some(item => item.sha256 === asset.sha256)) { await done; return; }
  if (list.length >= 60 || list.reduce((size, item) => size + item.size, asset.size) > 120 * 1024 ** 2) {
    tx.abort();
    throw new Error('4001');
  }
  store.put(asset);
  await done;
  globalThis.window?.dispatchEvent(new Event('stickerwave:library'));
}

export async function removeSound(id: string) {
  const tx = (await open()).transaction('library', 'readwrite');
  const done = completed(tx);
  tx.objectStore('library').delete(id);
  await done;
  globalThis.window?.dispatchEvent(new Event('stickerwave:library'));
}
