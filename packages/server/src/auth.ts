import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import type { Context, Next } from 'hono';
import { db, schema } from './db/index.js';
import { eq } from 'drizzle-orm';

// JWT_SECRET 启动校验. 生产环境强制要求 env 设置, 否则 console.warn 醒目提醒.
// (开发环境允许默认值方便调试, NODE_ENV=production 时启动期警告)
const JWT_SECRET = process.env.QUINK_JWT_SECRET || 'quink-dev-secret-change-in-production';
if (process.env.NODE_ENV === 'production' && !process.env.QUINK_JWT_SECRET) {
  console.error('[SECURITY] QUINK_JWT_SECRET 未设置! 生产环境用默认 secret 严重不安全, 请立即设置环境变量');
}
// 长效 token，不主动退出就一直有效 (体验优先)
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

// token payload 含 tv (token version). 改密码时 users.token_version++ → 旧 token 携带 tv 跟 DB 不匹配, authMiddleware 拒绝
export function signToken(userId: string, tokenVersion: number = 0): string {
  return jwt.sign({ sub: userId, tv: tokenVersion }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token: string): { sub: string; tv?: number } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { sub: string; tv?: number };
  } catch {
    return null;
  }
}

// ── Hono middleware ──

// 缓存 user.tokenVersion 防每个请求都查 DB. TTL 短 (10s) 防"改密码后旧 token 还能用 10s"
// 改密码 endpoint 写完后立即 invalidate 缓存
const tvCache = new Map<string, { tv: number; expiresAt: number }>();
const TV_CACHE_TTL_MS = 10 * 1000;

export function invalidateTokenVersionCache(userId: string) {
  tvCache.delete(userId);
}

async function getCurrentTokenVersion(userId: string): Promise<number | null> {
  const cached = tvCache.get(userId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.tv;
  const row = await db.select({ tokenVersion: schema.users.tokenVersion })
    .from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!row) return null;
  tvCache.set(userId, { tv: row.tokenVersion ?? 0, expiresAt: now + TV_CACHE_TTL_MS });
  return row.tokenVersion ?? 0;
}

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

  // 校验 token version 匹配 (改密码后旧 token tv 旧 → 拒绝)
  // 老 token (没有 tv 字段) 视为 tv=0, 兼容历史登录会话
  const tokenTv = payload.tv ?? 0;
  const currentTv = await getCurrentTokenVersion(payload.sub);
  if (currentTv === null) {
    return c.json({ error: '用户不存在' }, 401);
  }
  if (tokenTv !== currentTv) {
    return c.json({ error: '登录已失效, 请重新登录' }, 401);
  }

  c.set('userId', payload.sub);
  await next();
}
