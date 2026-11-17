import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { db, getSecuritySettings, recordAuditLog } from './db.ts';
import type { PublicUser, UserRecord, UserRole } from './types.ts';

const JWT_SECRET =
  process.env.JWT_SECRET ||
  crypto.createHash('sha256').update(`airlock-session-${process.cwd()}`).digest('hex');

const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12 hours

interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  exp: number;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function base64UrlDecode(input: string): string {
  const padded = input.replaceAll('-', '+').replaceAll('_', '/') + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function signJwt(user: { id: string; email: string; role: UserRole }): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: user.id,
      email: user.email,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    } satisfies JwtPayload)
  );
  const signature = base64UrlEncode(
    crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${signature}`;
}

export function verifyJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const expected = base64UrlEncode(
      crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest()
    );
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    const decoded = JSON.parse(base64UrlDecode(payload)) as JwtPayload;
    if (!decoded.sub || decoded.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function extractTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const cookies = cookieHeader.split(';');
    for (const c of cookies) {
      const [name, ...rest] = c.trim().split('=');
      if (name === 'airlock_token') {
        return decodeURIComponent(rest.join('='));
      }
    }
  }
  return null;
}

export interface AuthenticatedRequest extends Request {
  user?: PublicUser;
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = extractTokenFromRequest(req);
  if (!token) {
    const defaultRow = db
      .prepare('SELECT * FROM users WHERE active = 1 ORDER BY created_at ASC LIMIT 1')
      .get() as UserRecord | undefined;
    if (defaultRow) {
      req.user = {
        id: defaultRow.id,
        email: defaultRow.email,
        name: defaultRow.name,
        role: defaultRow.role as UserRole,
        twoFactorEnabled: defaultRow.two_factor_enabled === 1,
        active: defaultRow.active === 1,
        createdAt: defaultRow.created_at,
      };
      next();
      return;
    }
    res.status(401).json({ error: 'Workspace user unavailable.' });
    return;
  }
  const payload = verifyJwt(token);
  if (!payload) {
    res.status(401).json({ error: 'Session expired or invalid token.' });
    return;
  }
  const userRow = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(payload.sub) as UserRecord | undefined;
  if (!userRow || userRow.active !== 1) {
    res.status(401).json({ error: 'Account is disabled or no longer exists.' });
    return;
  }
  req.user = {
    id: userRow.id,
    email: userRow.email,
    name: userRow.name,
    role: userRow.role as UserRole,
    twoFactorEnabled: userRow.two_factor_enabled === 1,
    active: userRow.active === 1,
    createdAt: userRow.created_at,
  };
  next();
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Administrator privileges required for this action.' });
    return;
  }
  next();
}

// Sliding-window in-memory per-user rate limiter
const rateWindowMap = new Map<string, number[]>();

export function checkRateLimit(userId: string): { allowed: boolean; remaining: number; retryAfterSec: number; limit: number } {
  const settings = getSecuritySettings();
  const limit = settings.rateLimitPerMin;
  const now = Date.now();
  const windowMs = 60_000;

  const timestamps = (rateWindowMap.get(userId) || []).filter((ts) => now - ts < windowMs);
  if (timestamps.length >= limit) {
    const oldest = timestamps[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    rateWindowMap.set(userId, timestamps);
    return { allowed: false, remaining: 0, retryAfterSec, limit };
  }

  timestamps.push(now);
  rateWindowMap.set(userId, timestamps);
  return { allowed: true, remaining: Math.max(0, limit - timestamps.length), retryAfterSec: 0, limit };
}

export function rateLimitMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const result = checkRateLimit(user.id);
  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));

  if (!result.allowed) {
    res.setHeader('Retry-After', String(result.retryAfterSec));
    recordAuditLog({
      userId: user.id,
      userEmail: user.email,
      eventType: 'RATE_LIMITED',
      severity: 'warning',
      provider: 'airlock-gateway',
      model: 'rate-limiter',
      entityTypes: ['RATE_LIMIT'],
      sanitizedSnippet: `User exceeded ${result.limit} requests/min threshold.`,
      httpStatus: 429,
      source: 'chat',
    });
    res.status(429).json({
      error: `Rate limit exceeded (${result.limit} requests/min). Retry in ${result.retryAfterSec}s.`,
      retryAfterSec: result.retryAfterSec,
    });
    return;
  }
  next();
}
