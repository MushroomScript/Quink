import { Hono } from 'hono';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';
import { authMiddleware } from '../auth.js';
import { publish } from '../reminder/bus.js';
import { dispatchToSingleChannel } from '../reminder/sender.js';

const app = new Hono();
app.use('*', authMiddleware);

const channelTypes = ['browser', 'email', 'bark', 'wecom_bot', 'dingtalk_bot', 'feishu_bot', 'telegram', 'webhook'] as const;

// 蘑菇 2026-06-09: types 是通知类型白名单. null/undefined 默认 = 全收 (兼容老 row)
const createSchema = z.object({
  type: z.enum(channelTypes),
  name: z.string().min(1).max(50),
  config: z.record(z.any()).default({}),
  enabled: z.boolean().default(true),
  types: z.array(z.string().max(64)).nullable().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  config: z.record(z.any()).optional(),
  enabled: z.boolean().optional(),
  types: z.array(z.string().max(64)).nullable().optional(),
});

app.get('/', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const rows = await db.select().from(schema.reminderChannels)
    .where(eq(schema.reminderChannels.userId, userId))
    .orderBy(schema.reminderChannels.createdAt)
    .all();
  return c.json({ data: rows });
});

app.post('/', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  // browser 通道全用户唯一: 同一 SSE 连接对所有 enabled channel 都推一份, 加多条只会让 OS 通知重复弹 N 次. 直接拦
  if (parsed.data.type === 'browser') {
    const existing = await db.select().from(schema.reminderChannels)
      .where(and(eq(schema.reminderChannels.userId, userId), eq(schema.reminderChannels.type, 'browser'))).get();
    if (existing) return c.json({ error: '已有浏览器/Electron 通道, 不能重复添加 (会让通知重复弹)' }, 400);
  }

  const row = {
    id: nanoid(12),
    userId,
    type: parsed.data.type,
    name: parsed.data.name,
    config: parsed.data.config,
    enabled: parsed.data.enabled,
    types: parsed.data.types ?? null,
    createdAt: dayjs().toISOString(),
  };
  await db.insert(schema.reminderChannels).values(row);
  publish(userId, 'data-changed', { scope: 'reminder-channels' }, _ocid);
  const { logAudit } = await import('../utils/auditLog.js');
  await logAudit(c, 'reminder.channel_create', 'reminder_channel', row.id, { type: row.type, name: row.name });
  return c.json({ data: row }, 201);
});

app.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const id = c.req.param('id');
  const parsed = updateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const existing = await db.select().from(schema.reminderChannels)
    .where(and(eq(schema.reminderChannels.id, id), eq(schema.reminderChannels.userId, userId))).get();
  if (!existing) return c.json({ error: '通道不存在' }, 404);

  const updates: Record<string, any> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.config !== undefined) updates.config = parsed.data.config;
  if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
  if (parsed.data.types !== undefined) updates.types = parsed.data.types;

  await db.update(schema.reminderChannels).set(updates).where(eq(schema.reminderChannels.id, id));
  const updated = await db.select().from(schema.reminderChannels).where(eq(schema.reminderChannels.id, id)).get();
  publish(userId, 'data-changed', { scope: 'reminder-channels' }, _ocid);
  const { logAudit: logAudit1 } = await import('../utils/auditLog.js');
  await logAudit1(c, 'reminder.channel_update', 'reminder_channel', id, { fields: Object.keys(updates) });
  return c.json({ data: updated });
});

app.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const id = c.req.param('id');
  await db.delete(schema.reminderChannels)
    .where(and(eq(schema.reminderChannels.id, id), eq(schema.reminderChannels.userId, userId)));
  publish(userId, 'data-changed', { scope: 'reminder-channels' }, _ocid);
  const { logAudit: logAudit2 } = await import('../utils/auditLog.js');
  await logAudit2(c, 'reminder.channel_delete', 'reminder_channel', id);
  return c.json({ message: '已删除' });
});

// 立即发测试消息: Settings 页"测试"按钮调用. 失败返回 400 + 错误描述, 让用户能直接看到 config 问题
app.post('/:id/test', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const id = c.req.param('id');
  const ch = await db.select().from(schema.reminderChannels)
    .where(and(eq(schema.reminderChannels.id, id), eq(schema.reminderChannels.userId, userId))).get();
  if (!ch) return c.json({ error: '通道不存在' }, 404);

  try {
    await dispatchToSingleChannel(id, {
      noteId: 'test',
      title: '[测试] Quink 提醒通道',
      body: `这是来自 ${ch.name} (${ch.type}) 的测试消息, 收到说明配置成功。`,
      remindAt: dayjs().toISOString(),
    });
    return c.json({ message: '发送成功' });
  } catch (e: any) {
    return c.json({ error: e?.message || '发送失败' }, 400);
  }
});

export default app;
