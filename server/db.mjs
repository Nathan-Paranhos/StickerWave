import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis;

function defaultDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const dbPath = resolve('prisma', 'stickerwave.db').replace(/\\/g, '/');
  return `file:${dbPath}`;
}

export function createPrismaClient(databaseUrl = defaultDatabaseUrl()) {
  const client = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  return client;
}

export function getPrisma() {
  if (!globalForPrisma.__stickerwavePrisma) {
    globalForPrisma.__stickerwavePrisma = createPrismaClient();
  }
  return globalForPrisma.__stickerwavePrisma;
}

/**
 * Ensures SQLite tables exist matching prisma/schema.prisma when running with ephemeral test DB files.
 */
export async function ensureSqliteSchema(prisma) {
  await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON;');
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  );`);
  await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");');
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`);
  await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "Session_tokenHash_key" ON "Session"("tokenHash");');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId");');
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ProjectRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "data" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`);
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ProjectRecord_userId_updatedAt_idx" ON "ProjectRecord"("userId", "updatedAt");');
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "FavoriteSound" (
    "userId" TEXT NOT NULL,
    "soundId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("userId", "soundId"),
    CONSTRAINT "FavoriteSound_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  );`);
}

export const SCHEMA_PATH = pathToFileURL(resolve('prisma', 'schema.prisma')).href;
