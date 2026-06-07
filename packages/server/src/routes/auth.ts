import { Hono } from 'hono';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';
import { hashPassword, verifyPassword, signToken, authMiddleware, invalidateTokenVersionCache } from '../auth.js';
import { logAudit } from '../utils/auditLog.js';
import { publish } from '../reminder/bus.js';
import { cleanTrashForUser } from '../cleanup.js';
import { DEFAULT_CATEGORIES } from '../ai/prompts.js';

const app = new Hono();

const registerSchema = z.object({
  username: z.string().min(2).max(32),
  password: z.string().min(6).max(128),
  nickname: z.string().min(1).max(32),
});

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

const updateProfileSchema = z.object({
  nickname: z.string().min(1).max(32).optional(),
  avatar: z.string().max(2048).optional(),
  // 安全审计 M9: preferences 限制 JSON size 32KB 防恶意大 JSON 灌 DB. 字段不收紧 (兼容大量已知字段如 aiBindings/xfyun/shortcuts)
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
    passwordHash: hashPassword(password),
    nickname,
    avatar: null,
    preferences: {},
    tokenVersion: 0,
    createdAt: dayjs().toISOString(),
  };

  await db.insert(schema.users).values(user);
  // 安全审计: 注册操作记录
  c.set('userId', user.id);
  await logAudit(c, 'auth.register', 'user', user.id, { username: user.username });
  // seed 默认大类 (工作/学习/生活/其他). 自动分类 prompt 用 {categories} 占位, AI 从这个列表里选 (有"其他"兜底),
  // 不能编新分类. 老用户不补种 (蘑菇 2026-05-29 决定); 失败容忍, 用户后续手动加分类也行
  await Promise.all(
    DEFAULT_CATEGORIES.map((name, idx) =>
      db.insert(schema.categories).values({
        userId: user.id, name, parentId: null, icon: null, sortOrder: idx,
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
  const body = await c.req.json();
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const username = parsed.data.username.toLowerCase();
  const password = parsed.data.password;
  const user = await db.select().from(schema.users).where(eq(schema.users.username, username)).get();

  if (!user || !verifyPassword(password, user.passwordHash)) {
    // 安全审计: 登录失败 (含密码错误 / 用户不存在). 频繁失败可被监控为暴力破解
    c.set('userId', user?.id || 'anonymous');
    await logAudit(c, 'auth.login_failed', 'user', user?.id || null, { username });
    return c.json({ error: '用户名或密码错误' }, 401);
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
  if (newPassword.length < 6) return c.json({ error: '新密码至少6位' }, 400);

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user || !verifyPassword(oldPassword, user.passwordHash)) {
    return c.json({ error: '旧密码不正确' }, 401);
  }

  // 安全审计 M2: 改密码 → tokenVersion++ + invalidate 缓存 → 所有旧 token 立即失效, 所有设备 401 必须重登
  // 蘑菇拍板: 长效 token 不变, 但改密码要"修改密码后立即退出登录才对"
  const newTv = (user.tokenVersion ?? 0) + 1;
  await db.update(schema.users)
    .set({ passwordHash: hashPassword(newPassword), tokenVersion: newTv })
    .where(eq(schema.users.id, userId));
  invalidateTokenVersionCache(userId);
  // 安全审计: 改密码是高敏感操作, 必须记录 (含 tokenVersion 升级方便排查)
  await logAudit(c, 'auth.password_change', 'user', userId, { newTokenVersion: newTv });
  publish(userId, 'data-changed', { scope: 'user-profile' }, _ocid);
  return c.json({ message: '密码已修改, 所有设备需重新登录' });
});

export default app;
