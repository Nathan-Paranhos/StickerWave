import type { AuthUser } from './api';

type VaultRecord = AuthUser & {
  salt: string;
  passwordHash: string;
};

const DB_NAME = 'stickerwave-vault';
const STORE_NAME = 'accounts';
const SESSION_KEY = 'stickerwave:vaultSession';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME, { keyPath: 'email' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function safeUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function deriveHash(password: string, salt: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const keyMaterial = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100_000, hash: 'SHA-256' },
      keyMaterial,
      256,
    );
    return bytesToHex(new Uint8Array(bits));
  }
  // Fallback only for insecure non-localhost HTTP LAN contexts where WebCrypto subtle is omitted.
  let acc = 2166136261;
  const input = `${salt}:${password}`;
  for (let i = 0; i < input.length; i++) {
    acc ^= input.charCodeAt(i);
    acc = Math.imul(acc, 16777619);
  }
  return (acc >>> 0).toString(16).padStart(8, '0');
}

function publicUser(record: VaultRecord): AuthUser {
  return { id: record.id, name: record.name, email: record.email, createdAt: record.createdAt };
}

export function readVaultSession(): AuthUser | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser;
    return parsed?.id && parsed?.email ? parsed : null;
  } catch {
    return null;
  }
}

function writeVaultSession(user: AuthUser | null) {
  try {
    if (user) localStorage.setItem(SESSION_KEY, JSON.stringify(user));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* storage optional */ }
}

export function clearVaultSession() {
  writeVaultSession(null);
}

export async function vaultRegister(input: { name: string; email: string; password: string; confirmPassword?: string }): Promise<AuthUser> {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (name.length < 2 || name.length > 80 || !EMAIL_RE.test(email) || email.length > 160 || input.password.length < 6 || input.password.length > 128) {
    throw new Error('7002');
  }
  if (input.confirmPassword !== undefined && input.password !== input.confirmPassword) {
    throw new Error('7005');
  }
  const db = await openVaultDb();
  const existingTx = db.transaction(STORE_NAME, 'readonly');
  const existing = await idbRequest<VaultRecord | undefined>(existingTx.objectStore(STORE_NAME).get(email));
  if (existing) throw new Error('7003');

  const salt = randomHex(16);
  const passwordHash = await deriveHash(input.password, salt);
  const record: VaultRecord = {
    id: safeUuid(),
    name,
    email,
    createdAt: new Date().toISOString(),
    salt,
    passwordHash,
  };
  const writeTx = db.transaction(STORE_NAME, 'readwrite');
  await idbRequest(writeTx.objectStore(STORE_NAME).add(record));
  const user = publicUser(record);
  writeVaultSession(user);
  return user;
}

export async function vaultLogin(input: { email: string; password: string }): Promise<AuthUser> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || !input.password) throw new Error('7002');
  const db = await openVaultDb();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const record = await idbRequest<VaultRecord | undefined>(tx.objectStore(STORE_NAME).get(email));
  if (!record) throw new Error('7001');
  const attempt = await deriveHash(input.password, record.salt);
  if (attempt !== record.passwordHash) throw new Error('7001');
  const user = publicUser(record);
  writeVaultSession(user);
  return user;
}
