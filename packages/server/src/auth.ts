import { createHmac, timingSafeEqual } from 'crypto';
import bcrypt from 'bcryptjs';
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

// ── Password hashing (bcrypt cost 10, 兼容旧 HMAC-SHA256) ──
//
// S1 REVIEW-TODO 修复: 从单轮 HMAC-SHA256 升级到 bcrypt (cost 10 ≈ 100ms/次).
// 老 hash (`salt:hash` hex 格式) 保留 verify, 用户下次成功登录自动 rehash 升级 (verifyAndMaybeRehash 返 needsRehash=true).
// bcrypt 生成的 hash 形如 `$2a$10$...` / `$2b$10$...`, 靠 `$` 前缀区分.

const BCRYPT_COST = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

// 旧 hash 校验 (单轮 HMAC-SHA256 + salt): 仅用于兼容, 校验通过后 login 会自动 rehash 升级
function verifyLegacyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = createHmac('sha256', salt).update(password).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
  } catch {
    return false;
  }
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // 新 hash (bcrypt): 以 `$2` 开头
  if (stored.startsWith('$2')) {
    try {
      return await bcrypt.compare(password, stored);
    } catch {
      return false;
    }
  }
  // 老 hash (HMAC-SHA256 + salt 十六进制): 兼容不阻断已存在用户登录
  return verifyLegacyPassword(password, stored);
}

// 老 hash 需升级到 bcrypt: 供 login handler 判断
export function needsRehash(stored: string): boolean {
  return !stored.startsWith('$2');
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
