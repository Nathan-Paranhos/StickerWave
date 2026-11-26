import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';

const CIPHER_ALGO = 'aes-256-gcm';
const KEY_INFO = Buffer.from('stickerwave-gateway-session-v1', 'utf8');

function deriveKey(secret: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(16, 0x73), KEY_INFO, 32));
}

function encryptText(plaintext: string, key: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: [1-byte version][12-byte iv][16-byte gcm tag][ciphertext...]
  return Buffer.concat([Buffer.from([1]), iv, tag, encrypted]);
}

function decryptBuffer(blob: Buffer, key: Buffer): string {
  if (blob.length < 29 || blob[0] !== 1) {
    throw new Error('Invalid encrypted session record header.');
  }
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const ciphertext = blob.subarray(29);
  const decipher = crypto.createDecipheriv(CIPHER_ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function sanitizeFileKey(fileKey: string): string {
  // Hash or safely encode key IDs to eliminate path traversal completely while remaining deterministic.
  return crypto.createHash('sha256').update(fileKey).digest('hex');
}

/**
 * AES-256-GCM encrypted Baileys AuthenticationState persisted inside `sessionDir`.
 * Uses per-key async queues so concurrent Signal pre-key / session updates never corrupt files.
 */
export class EncryptedSessionStore {
  private readonly encKey: Buffer;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    public readonly sessionDir: string,
    sessionSecret: string,
  ) {
    this.encKey = deriveKey(sessionSecret);
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(key, next);
    void next.finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    });
    return next;
  }

  private recordPath(logicalKey: string): string {
    const safeName = `${sanitizeFileKey(logicalKey)}.enc`;
    const resolved = path.resolve(this.sessionDir, safeName);
    const parent = path.resolve(this.sessionDir);
    if (!resolved.startsWith(parent + path.sep)) {
      throw new Error('Invalid session record path resolution.');
    }
    return resolved;
  }

  private async writeRecord(logicalKey: string, value: unknown): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
    const target = this.recordPath(logicalKey);
    const tempTarget = `${target}.tmp-${process.pid}-${Date.now()}`;
    const serialized = JSON.stringify(value, BufferJSON.replacer);
    const encrypted = encryptText(serialized, this.encKey);

    await this.withLock(logicalKey, async () => {
      await fs.writeFile(tempTarget, encrypted, { mode: 0o600 });
      await fs.rename(tempTarget, target);
    });
  }

  private async readRecord<T>(logicalKey: string): Promise<T | null> {
    const target = this.recordPath(logicalKey);
    return this.withLock(logicalKey, async () => {
      try {
        const raw = await fs.readFile(target);
        const decrypted = decryptBuffer(raw, this.encKey);
        return JSON.parse(decrypted, BufferJSON.reviver) as T;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') return null;
        throw err;
      }
    });
  }

  private async deleteRecord(logicalKey: string): Promise<void> {
    const target = this.recordPath(logicalKey);
    await this.withLock(logicalKey, async () => {
      await fs.rm(target, { force: true });
    });
  }

  async hasPersistedSession(): Promise<boolean> {
    try {
      const creds = await this.readRecord<AuthenticationCreds>('creds');
      return Boolean(creds?.me?.id);
    } catch {
      return false;
    }
  }

  async clearSession(): Promise<void> {
    await fs.rm(this.sessionDir, { recursive: true, force: true });
  }

  async createAuthState(): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }> {
    await fs.mkdir(this.sessionDir, { recursive: true });
    const creds = (await this.readRecord<AuthenticationCreds>('creds')) || initAuthCreds();

    return {
      state: {
        creds,
        keys: {
          get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
            const result: { [id: string]: SignalDataTypeMap[T] } = {};
            await Promise.all(
              ids.map(async (id) => {
                let value = await this.readRecord<SignalDataTypeMap[T]>(`${type}:${id}`);
                if (type === 'app-state-sync-key' && value) {
                  value = proto.Message.AppStateSyncKeyData.fromObject(
                    value as unknown as { [k: string]: unknown },
                  ) as unknown as SignalDataTypeMap[T];
                }
                if (value !== null && value !== undefined) {
                  result[id] = value;
                }
              }),
            );
            return result;
          },
          set: async (data: SignalDataSet) => {
            const tasks: Promise<void>[] = [];
            for (const category of Object.keys(data) as Array<keyof SignalDataSet>) {
              const bucket = data[category];
              if (!bucket) continue;
              for (const [id, value] of Object.entries(bucket)) {
                const key = `${category}:${id}`;
                if (value) {
                  tasks.push(this.writeRecord(key, value));
                } else {
                  tasks.push(this.deleteRecord(key));
                }
              }
            }
            await Promise.all(tasks);
          },
        },
      },
      saveCreds: async () => {
        await this.writeRecord('creds', creds);
      },
    };
  }
}
