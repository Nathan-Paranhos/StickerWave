import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GATEWAY_ERROR_CODES } from '@stickerwave/contracts';
import type { GatewayConfig } from '../config.js';

export interface HttpAuthError {
  statusCode: number;
  code: string;
  message: string;
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Burn comparable time before returning false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function extractBearerOrHeaderSecret(req: IncomingMessage, headerName = 'x-admin-secret'): string {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const direct = req.headers[headerName];
  if (typeof direct === 'string') return direct.trim();
  return '';
}

export function verifyAdminAuth(req: IncomingMessage, config: GatewayConfig): HttpAuthError | null {
  const provided = extractBearerOrHeaderSecret(req, 'x-admin-secret');
  if (!provided || !timingSafeEqualStrings(provided, config.adminSecret)) {
    return {
      statusCode: 401,
      code: GATEWAY_ERROR_CODES.UNAUTHORIZED_ADMIN,
      message: 'Autenticação administrativa obrigatória ou inválida.',
    };
  }
  return null;
}

export function verifyOptionalPublicToken(req: IncomingMessage, config: GatewayConfig): HttpAuthError | null {
  if (!config.publicToken) return null;
  const provided = extractBearerOrHeaderSecret(req, 'x-gateway-token');
  if (!provided || !timingSafeEqualStrings(provided, config.publicToken)) {
    return {
      statusCode: 401,
      code: GATEWAY_ERROR_CODES.UNAUTHORIZED_ADMIN,
      message: 'Token de cliente inválido para acesso ao gateway.',
    };
  }
  return null;
}

export function applySecurityAndCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
): { originAllowed: boolean; origin: string | null } {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');

  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : null;
  if (!originHeader) {
    return { originAllowed: true, origin: null };
  }

  const allowed = config.allowedOrigins.includes('*') || config.allowedOrigins.includes(originHeader);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', originHeader);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Admin-Secret, X-Gateway-Token, Idempotency-Key',
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'X-Sticker-Animated, X-Sticker-Duration-Ms, X-Sticker-Bytes, X-Sticker-Cloud-Engine',
    );
    res.setHeader('Access-Control-Max-Age', '600');
  }
  return { originAllowed: allowed, origin: originHeader };
}

export function getClientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0]!.trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, { timestamps: number[] }>();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
  ) {}

  consume(key: string): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const entry = this.buckets.get(key) ?? { timestamps: [] };
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= this.maxRequests) {
      const oldest = entry.timestamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      this.buckets.set(key, entry);
      return { allowed: false, remaining: 0, retryAfterSec };
    }

    entry.timestamps.push(now);
    this.buckets.set(key, entry);
    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - entry.timestamps.length),
      retryAfterSec: 0,
    };
  }
}

export async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      throw new Error(`PAYLOAD_TOO_LARGE:${maxBytes}`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export interface ParsedMultipart {
  fields: Record<string, string>;
  files: Record<string, { filename: string; contentType: string; data: Buffer }>;
}

/**
 * Dependency-free strict RFC-7578 multipart/form-data parser with explicit size & part caps
 * and filename sanitization (preventing path traversal hints from client headers).
 */
export function parseMultipartBody(body: Buffer, contentTypeHeader: string): ParsedMultipart {
  const boundaryMatch = contentTypeHeader.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) {
    throw new Error('INVALID_MULTIPART_BOUNDARY');
  }

  const boundaryBuf = Buffer.from(`--${boundary}`, 'latin1');
  const fields: Record<string, string> = {};
  const files: Record<string, { filename: string; contentType: string; data: Buffer }> = {};

  let partCount = 0;
  let pos = body.indexOf(boundaryBuf);
  while (pos !== -1) {
    const startAfterBoundary = pos + boundaryBuf.length;
    if (body[startAfterBoundary] === 0x2d && body[startAfterBoundary + 1] === 0x2d) {
      break; // Closing boundary `--`
    }

    const lineStart =
      body[startAfterBoundary] === 0x0d && body[startAfterBoundary + 1] === 0x0a
        ? startAfterBoundary + 2
        : body[startAfterBoundary] === 0x0a
          ? startAfterBoundary + 1
          : startAfterBoundary;

    const headerEndCrlf = body.indexOf('\r\n\r\n', lineStart, 'latin1');
    const headerEndLf = body.indexOf('\n\n', lineStart, 'latin1');
    let headerEnd = -1;
    let sepLen = 4;
    if (headerEndCrlf !== -1 && (headerEndLf === -1 || headerEndCrlf < headerEndLf)) {
      headerEnd = headerEndCrlf;
      sepLen = 4;
    } else if (headerEndLf !== -1) {
      headerEnd = headerEndLf;
      sepLen = 2;
    }
    if (headerEnd === -1) break;

    partCount++;
    if (partCount > 24) throw new Error('TOO_MANY_MULTIPART_PARTS');

    const headerText = body.subarray(lineStart, headerEnd).toString('utf8');
    const dataStart = headerEnd + sepLen;
    const nextBoundaryPos = body.indexOf(boundaryBuf, dataStart);
    if (nextBoundaryPos === -1) break;

    let dataEnd = nextBoundaryPos;
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;
    else if (body[dataEnd - 1] === 0x0a) dataEnd -= 1;

    const dispMatch = headerText.match(/content-disposition:\s*form-data;\s*([^;\r\n]+.*)/i);
    const nameMatch = dispMatch?.[1]?.match(/name="([^"]+)"/i);
    const filenameMatch = dispMatch?.[1]?.match(/filename="([^"]*)"/i);
    const ctMatch = headerText.match(/content-type:\s*([^\r\n]+)/i);

    const fieldName = nameMatch?.[1];
    if (fieldName) {
      const partData = body.subarray(dataStart, dataEnd);
      if (filenameMatch) {
        const cleanFilename = (filenameMatch[1] || 'upload').replace(/.*[\\/]/, '').slice(0, 120);
        files[fieldName] = {
          filename: cleanFilename || 'upload',
          contentType: (ctMatch?.[1] || 'application/octet-stream').trim().toLowerCase(),
          data: Buffer.from(partData),
        };
      } else {
        fields[fieldName] = partData.toString('utf8');
      }
    }

    pos = nextBoundaryPos;
  }

  return { fields, files };
}
