import { Hono } from 'hono';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';
import { hashPassword, verifyPassword, needsRehash, signToken, authMiddleware, invalidateTokenVersionCache } from '../auth.js';
import { logAudit } from '../utils/auditLog.js';
import { publish } from '../reminder/bus.js';
import { cleanTrashForUser } from '../cleanup.js';
import { DEFAULT_CATEGORIES } from '../ai/prompts.js';
import { createTokenBucket, createAccountLock, getClientIp } from '../utils/rateLimit.js';

const app = new Hono();

// 登录/注册 rate limit + 账号锁 (S3 REVIEW-TODO 修复):
// - 每 IP 10 分钟 5 次登录/注册尝试 (仅算失败, 成功后 reset)
// - 每 username 10 分钟 5 次登录尝试, 超阈值锁账号 30 分钟
// - 账号被锁期间返回 429, 密码正确也拒绝, 防暴力破解 + 撞库
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 5;
const ACCOUNT_LOCK_MS = 30 * 60 * 1000;
const ipLoginBucket = createTokenBucket({ windowMs: AUTH_WINDOW_MS, max: AUTH_MAX_ATTEMPTS });
const ipRegisterBucket = createTokenBucket({ windowMs: AUTH_WINDOW_MS, max: AUTH_MAX_ATTEMPTS });
const usernameLoginBucket = createTokenBucket({ windowMs: AUTH_WINDOW_MS, max: AUTH_MAX_ATTEMPTS });
const accountLock = createAccountLock();

function getIpFromContext(c: any): string {
  return getClientIp({
    'x-forwarded-for': c.req.header('x-forwarded-for'),
    'x-real-ip': c.req.header('x-real-ip'),
  });
}

// 密码最短 8 位 (S1 REVIEW-TODO 修复, 提升暴破成本; 从 6 位 → 8 位)
const registerSchema = z.object({
  username: z.string().min(2).max(32),
  password: z.string().min(8).max(128),
  nickname: z.string().min(1).max(32),
});

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

const updateProfileSchema = z.object({
  nickname: z.string().min(1).max(32).optional(),
  avatar: z.string().max(2048).optional(),
  // preferences 限制 JSON size 32KB 防恶意大 JSON 灌 DB. 字段不收紧 (兼容大量已知字段如 aiBindings/xfyun/shortcuts)
  // 但 aiPersonaCustom (会拼进 system prompt) 单独限长 1000 字符
  preferences: z.record(z.any()).refine(
    (p) => JSON.stringify(p).length <= 32 * 1024,
    { message: 'preferences 大小不能超过 32KB' },
  ).refine(
    (p) => typeof p.aiPersonaCustom !== 'string' || p.aiPersonaCustom.length <= 1000,
    { message: 'aiPersonaCustom 长度不能超过 1000 字符' },
  ).optional(),
});

// POST /api/auth/register
app.post('/register', async (c) => {
  const ip = getIpFromContext(c);
  if (!ipRegisterBucket.check(ip)) {
    return c.json({ error: '注册请求过于频繁, 请 10 分钟后再试' }, 429);
  }

  const body = await c.req.json();
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { password, nickname } = parsed.data;
  const username = parsed.data.username.toLowerCase();

  // Check if username already exists
  const existing = await db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  if (existing) {
    return c.json({ error: '用户名已存在' }, 409);
  }

  const user = {
    id: nanoid(12),
    username,
    passwordHash: await hashPassword(password),
    nickname,
    avatar: null,
    preferences: {},
    tokenVersion: 0,
    createdAt: dayjs().toISOString(),
  };

  await db.insert(schema.users).values(user);
  // 注册操作记录
  c.set('userId', user.id);
  await logAudit(c, 'auth.register', 'user', user.id, { username: user.username });
  // seed 默认大类 (工作/学习/生活/其他). 自动分类 prompt 用 {categories} 占位, AI 从这个列表里选 (有"其他"兜底),
  // 不能编新分类. 老用户不补种 (按设计约定); 失败容忍, 用户后续手动加分类也行
  await Promise.all(
    DEFAULT_CATEGORIES.map((name, idx) =>
      db.insert(schema.categories).values({
        userId: user.id, name, icon: null, sortOrder: idx,
      }).catch(err => console.error('[register] seed category failed:', name, err))
    )
  );
  const token = signToken(user.id, user.tokenVersion);

  return c.json({
    data: {
      token,
      user: { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar, preferences: user.preferences },
    },
  }, 201);
});

// POST /api/auth/login
app.post('/login', async (c) => {
  const ip = getIpFromContext(c);
  // IP 限流 (5次/10min, 命中的失败/成功都算; 成功登录后 reset)
  if (!ipLoginBucket.check(ip)) {
    return c.json({ error: '登录请求过于频繁, 请 10 分钟后再试' }, 429);
  }

  const body = await c.req.json();
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const username = parsed.data.username.toLowerCase();
  const password = parsed.data.password;

  // 账号锁: 该 username 被暴力破解锁 30min. 无视密码是否正确, 都拒绝. 防同一账号被穷举
  if (accountLock.isLocked(username)) {
    const unlockAt = accountLock.peek(username);
    const minutesLeft = unlockAt ? Math.max(1, Math.ceil((unlockAt - Date.now()) / 60000)) : 30;
    return c.json({ error: `账号已临时锁定, 请 ${minutesLeft} 分钟后再试` }, 429);
  }

  const user = await db.select().from(schema.users).where(eq(schema.users.username, username)).get();

  const passwordOk = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !passwordOk) {
    // 登录失败: 该 username 计数 +1, 超阈值锁 30min. 用 username 计数不用 IP 是为了防同 IP 撞多账号后 5 次就被卡死
    const allowed = usernameLoginBucket.check(username);
    if (!allowed) {
      accountLock.lock(username, ACCOUNT_LOCK_MS);
    }
    c.set('userId', user?.id || 'anonymous');
    await logAudit(c, 'auth.login_failed', 'user', user?.id || null, { username, locked: !allowed });
    return c.json({ error: '用户名或密码错误' }, 401);
  }

  // 登录成功: reset IP + username bucket + account lock, 避免正常用户被之前的失败挤压
  ipLoginBucket.reset(ip);
  usernameLoginBucket.reset(username);
  accountLock.unlock(username);

  // 老 HMAC hash 用户静默升级到 bcrypt (下次登录再验证不再走 legacy 分支). 失败不阻塞登录
  if (needsRehash(user.passwordHash)) {
    hashPassword(password)
      .then(newHash => db.update(schema.users).set({ passwordHash: newHash }).where(eq(schema.users.id, user.id)))
      .catch(err => console.error('[login] silent rehash failed:', err));
  }

  c.set('userId', user.id);
  await logAudit(c, 'auth.login', 'user', user.id, { username });
  const token = signToken(user.id, user.tokenVersion ?? 0);
  return c.json({
    data: {
      token,
      user: { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar, preferences: user.preferences },
    },
  });
});

// GET /api/auth/me — 获取当前用户信息（需登录）
app.get('/me', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();

  if (!user) {
    return c.json({ error: '用户不存在' }, 404);
  }

  return c.json({
    data: { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar, preferences: user.preferences },
  });
});

// PATCH /api/auth/me — 更新个人信息（需登录）
app.patch('/me', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const body = await c.req.json();
  const parsed = updateProfileSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const updates: Record<string, any> = {};
  if (parsed.data.nickname !== undefined) updates.nickname = parsed.data.nickname;
  if (parsed.data.avatar !== undefined) updates.avatar = parsed.data.avatar;
  if (parsed.data.preferences !== undefined) updates.preferences = parsed.data.preferences;

  if (Object.keys(updates).length > 0) {
    await db.update(schema.users).set(updates).where(eq(schema.users.id, userId));
  }

  // 用户保存了新的 retention 设置 → 立即按新天数清理该用户回收站, 不用等下个 6h 定时 tick
  if (parsed.data.preferences !== undefined) {
    const raw = (parsed.data.preferences as any).trashRetentionDays;
    const days = typeof raw === 'number' && raw >= 0 ? raw : 30;
    cleanTrashForUser(userId, days);
  }

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  return c.json({
    data: { id: user!.id, username: user!.username, nickname: user!.nickname, avatar: user!.avatar, preferences: user!.preferences },
  });
});

// POST /api/auth/password — 修改密码
app.post('/password', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { oldPassword, newPassword } = await c.req.json();

  if (!oldPassword || !newPassword) return c.json({ error: '请输入旧密码和新密码' }, 400);
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
    return c.json({ error: '新密码 8-128 位' }, 400);
  }

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user || !(await verifyPassword(oldPassword, user.passwordHash))) {
    return c.json({ error: '旧密码不正确' }, 401);
  }

  // 改密码 → tokenVersion++ + invalidate 缓存 → 所有旧 token 立即失效, 所有设备 401 必须重登
  // 约定: 长效 token 不变, 但改密码要"修改密码后立即退出登录"
  const newTv = (user.tokenVersion ?? 0) + 1;
  await db.update(schema.users)
    .set({ passwordHash: await hashPassword(newPassword), tokenVersion: newTv })
    .where(eq(schema.users.id, userId));
  invalidateTokenVersionCache(userId);
  // 改密码是高敏感操作, 必须记录 (含 tokenVersion 升级方便排查)
  await logAudit(c, 'auth.password_change', 'user', userId, { newTokenVersion: newTv });
  publish(userId, 'data-changed', { scope: 'user-profile' }, _ocid);
  return c.json({ message: '密码已修改, 所有设备需重新登录' });
});

// 主动"登出所有设备" - 不需旧密码 (因为用户已登录), tokenVersion++ 让所有旧 token (含本机) 立即失效.
// 用户场景: 怀疑某设备 token 泄漏 / 卖二手手机前清干净 / 共用电脑忘了登出. 实际效果跟改密码一致.
app.post('/logout-all-devices', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) return c.json({ error: '用户不存在' }, 404);
  const newTv = (user.tokenVersion ?? 0) + 1;
  await db.update(schema.users).set({ tokenVersion: newTv }).where(eq(schema.users.id, userId));
  invalidateTokenVersionCache(userId);
  await logAudit(c, 'auth.logout_all_devices', 'user', userId, { newTokenVersion: newTv });
  publish(userId, 'data-changed', { scope: 'user-profile' }, _ocid);
  return c.json({ message: '所有设备已退出登录' });
});

export default app;
