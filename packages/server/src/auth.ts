import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import type { Context, Next } from 'hono';

const JWT_SECRET = process.env.QUINK_JWT_SECRET || 'quink-dev-secret-change-in-production';
// 长效 token，不主动退出就一直有效
const TOKEN_EXPIRY = '999y';

// ── Password hashing (HMAC-SHA256 + salt) ──

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = createHmac('sha256', salt).update(password).digest('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = createHmac('sha256', salt).update(password).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
  } catch {
    return false;
  }
}

// ── JWT ──

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token: string): { sub: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { sub: string };
  } catch {
    return null;
  }
}

// ── Hono middleware ──

export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return c.json({ error: '未登录' }, 401);
  }

  const token = header.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    return c.json({ error: '登录已过期' }, 401);
  }

  c.set('userId', payload.sub);
  await next();
}
