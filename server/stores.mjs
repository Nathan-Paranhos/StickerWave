import { createHash, randomUUID } from 'node:crypto';

function emailKey(email) {
  return `email/${createHash('sha256').update(email.toLowerCase()).digest('hex')}`;
}

function userKey(id) {
  return `user/${id}`;
}

function sessionKey(tokenHash) {
  return `session/${tokenHash}`;
}

function ownerKey(projectId) {
  return `project-owner/${projectId}`;
}

function userProjectKey(userId, projectId) {
  return `user-project/${userId}/${projectId}`;
}

function favoritesKey(userId) {
  return `favorites/${userId}`;
}

function gatewayConfigKey() {
  return 'config/whatsapp-gateway';
}

export function isDataStore(candidate) {
  return Boolean(candidate && typeof candidate.findUserByEmail === 'function' && typeof candidate.upsertProject === 'function');
}

export function createPrismaStore(prisma) {
  return {
    async ping() {
      await prisma.$queryRaw`SELECT 1`;
    },
    async findUserByEmail(email) {
      return prisma.user.findUnique({ where: { email } });
    },
    async createUser({ name, email, passwordHash }) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) return { conflict: true };
      try {
        const user = await prisma.user.create({ data: { name, email, passwordHash } });
        return { conflict: false, user };
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'P2002') return { conflict: true };
        throw error;
      }
    },
    async findSession(tokenHash) {
      const session = await prisma.session.findUnique({ where: { tokenHash }, include: { user: true } });
      if (!session) return null;
      const expiresAtMs = session.expiresAt instanceof Date ? session.expiresAt.getTime() : Number(session.expiresAt);
      if (expiresAtMs <= Date.now()) {
        await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
        return null;
      }
      return { id: session.id, userId: session.userId, user: session.user };
    },
    async createSession({ tokenHash, userId, expiresAt }) {
      await prisma.session.create({ data: { tokenHash, userId, expiresAt } });
    },
    async deleteSessionByHash(tokenHash) {
      await prisma.session.deleteMany({ where: { tokenHash } });
    },
    async listProjects(userId) {
      const rows = await prisma.projectRecord.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
      });
      return rows.flatMap(row => {
        try { return [JSON.parse(row.data)]; } catch { return []; }
      });
    },
    async getProject(id, userId) {
      const record = await prisma.projectRecord.findFirst({ where: { id, userId } });
      if (!record) return null;
      return JSON.parse(record.data);
    },
    async upsertProject({ id, userId, project, expectedRevision }) {
      return prisma.$transaction(async tx => {
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
    },
    async deleteAllUserData(userId) {
      await prisma.$transaction([
        prisma.projectRecord.deleteMany({ where: { userId } }),
        prisma.favoriteSound.deleteMany({ where: { userId } }),
      ]);
    },
    async deleteProject(id, userId) {
      await prisma.projectRecord.deleteMany({ where: { id, userId } });
    },
    async listFavorites(userId) {
      const rows = await prisma.favoriteSound.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
      return rows.map(row => row.soundId);
    },
    async setFavorite(userId, soundId, favorite) {
      if (favorite) {
        await prisma.favoriteSound.upsert({
          where: { userId_soundId: { userId, soundId } },
          create: { userId, soundId },
          update: {},
        });
      } else {
        await prisma.favoriteSound.deleteMany({ where: { userId, soundId } });
      }
    },
    async getGatewayConfig() {
      try {
        await prisma.$executeRawUnsafe(
          'CREATE TABLE IF NOT EXISTS AppConfig (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt TEXT NOT NULL)',
        );
        const rows = await prisma.$queryRawUnsafe('SELECT value FROM AppConfig WHERE key = ?', 'whatsapp-gateway');
        if (Array.isArray(rows) && rows[0]?.value) {
          return JSON.parse(rows[0].value);
        }
      } catch {
        // Fallback cleanly if database schema is read-only
      }
      return null;
    },
    async setGatewayConfig(config) {
      await prisma.$executeRawUnsafe(
        'CREATE TABLE IF NOT EXISTS AppConfig (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt TEXT NOT NULL)',
      );
      const serialized = JSON.stringify(config);
      const now = new Date().toISOString();
      await prisma.$executeRawUnsafe(
        'INSERT INTO AppConfig (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt',
        'whatsapp-gateway',
        serialized,
        now,
      );
    },
  };
}

export function createBlobsStore(blobs) {
  return {
    async ping() {
      await blobs.list({ prefix: 'health/' });
    },
    async findUserByEmail(email) {
      const ref = await blobs.get(emailKey(email), { type: 'json' });
      if (!ref?.userId) return null;
      return blobs.get(userKey(ref.userId), { type: 'json' });
    },
    async createUser({ name, email, passwordHash }) {
      const userId = randomUUID();
      const user = { id: userId, name, email, passwordHash, createdAt: new Date().toISOString() };
      await blobs.setJSON(userKey(userId), user);
      const claim = await blobs.setJSON(emailKey(email), { userId }, { onlyIfNew: true });
      if (!claim.modified) {
        await blobs.delete(userKey(userId)).catch(() => undefined);
        return { conflict: true };
      }
      return { conflict: false, user };
    },
    async findSession(tokenHash) {
      const session = await blobs.get(sessionKey(tokenHash), { type: 'json' });
      if (!session) return null;
      if (Number(session.expiresAt) <= Date.now()) {
        await blobs.delete(sessionKey(tokenHash)).catch(() => undefined);
        return null;
      }
      const user = await blobs.get(userKey(session.userId), { type: 'json' });
      if (!user) return null;
      return { id: session.id, userId: session.userId, user };
    },
    async createSession({ tokenHash, userId, expiresAt }) {
      const expiresAtMs = expiresAt instanceof Date ? expiresAt.getTime() : Number(expiresAt);
      await blobs.setJSON(sessionKey(tokenHash), { id: randomUUID(), tokenHash, userId, expiresAt: expiresAtMs });
    },
    async deleteSessionByHash(tokenHash) {
      await blobs.delete(sessionKey(tokenHash));
    },
    async listProjects(userId) {
      const listing = await blobs.list({ prefix: `user-project/${userId}/` });
      const loaded = await Promise.all(listing.blobs.map(item => blobs.get(item.key, { type: 'json' })));
      return loaded
        .filter(item => item && typeof item.updatedAt === 'string')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async getProject(id, userId) {
      return (await blobs.get(userProjectKey(userId, id), { type: 'json' })) ?? null;
    },
    async upsertProject({ id, userId, project, expectedRevision }) {
      const owner = await blobs.get(ownerKey(id), { type: 'json' });
      if (owner && owner.userId !== userId) return { status: 403 };
      if (!owner) {
        const claimed = await blobs.setJSON(ownerKey(id), { userId }, { onlyIfNew: true });
        if (!claimed.modified) {
          const raceOwner = await blobs.get(ownerKey(id), { type: 'json' });
          return raceOwner && raceOwner.userId !== userId ? { status: 403 } : { status: 409 };
        }
      }
      const existing = await blobs.getWithMetadata(userProjectKey(userId, id), { type: 'json' });
      if ((existing?.data?.revision ?? null) !== expectedRevision) return { status: 409 };
      const next = {
        ...project,
        revision: (expectedRevision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      const write = await blobs.setJSON(
        userProjectKey(userId, id),
        next,
        existing ? (existing.etag ? { onlyIfMatch: existing.etag } : undefined) : { onlyIfNew: true },
      );
      if (!write.modified) return { status: 409 };
      return { status: 200, project: next };
    },
    async deleteAllUserData(userId) {
      const listing = await blobs.list({ prefix: `user-project/${userId}/` });
      await Promise.all([
        ...listing.blobs.flatMap(item => {
          const projectId = item.key.slice(`user-project/${userId}/`.length);
          return [blobs.delete(item.key), blobs.delete(ownerKey(projectId))];
        }),
        blobs.delete(favoritesKey(userId)),
      ]);
    },
    async deleteProject(id, userId) {
      const owner = await blobs.get(ownerKey(id), { type: 'json' });
      if (owner && owner.userId !== userId) return;
      await Promise.all([
        blobs.delete(userProjectKey(userId, id)),
        owner ? blobs.delete(ownerKey(id)) : Promise.resolve(),
      ]);
    },
    async listFavorites(userId) {
      const stored = await blobs.get(favoritesKey(userId), { type: 'json' });
      return Array.isArray(stored?.items) ? stored.items : [];
    },
    async setFavorite(userId, soundId, favorite) {
      const current = await this.listFavorites(userId);
      const next = favorite
        ? (current.includes(soundId) ? current : [...current, soundId])
        : current.filter(item => item !== soundId);
      await blobs.setJSON(favoritesKey(userId), { items: next });
    },
    async getGatewayConfig() {
      return (await blobs.get(gatewayConfigKey(), { type: 'json' })) ?? null;
    },
    async setGatewayConfig(config) {
      await blobs.setJSON(gatewayConfigKey(), config);
    },
  };
}
