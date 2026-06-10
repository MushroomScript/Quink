import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { eq, and, sql, inArray, like } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { authMiddleware, verifyToken } from './auth.js';
import { serveStatic } from '@hono/node-server/serve-static';
import authRoutes from './routes/auth.js';
import notesRoutes from './routes/notes.js';
import categoriesRoutes from './routes/categories.js';
import uploadRoutes from './routes/upload.js';
import aiConfigRoutes from './routes/ai-config.js';
import aiChatRoutes from './routes/ai-chat.js';
import exportRoutes from './routes/export.js';
import reminderChannelsRoutes from './routes/reminder-channels.js';
import sseRoutes from './routes/sse.js';
import groupsRoutes, { inviteApp } from './routes/groups.js';
import notificationsRoutes from './routes/notifications.js';
import { startReminderScheduler } from './reminder/scheduler.js';
import { startEditLockCleanup } from './routes/notes.js';

const app = new Hono();

// Middleware
app.use('*', cors());
app.use('*', logger());

// Static files (uploaded avatars etc.)
// 群组文件授权: query token 鉴权 + files 表查作者 + note_shares 查群可见性.
// avatar 不入 files 表 → 默认公开放行 (跨用户能看头像). file 入 files 表 → 走鉴权
app.use('/api/uploads/*', async (c, next) => {
  // 1. 拿 token (优先 Authorization header, fallback query token).
  // query token 会泄漏到浏览器历史 / referer / 服务器 access log. 优先 header, query 仅在 GET (浏览器直接打开 <img>/<audio> 没法设 header) 时接受
  const queryToken = c.req.query('token');
  const headerAuth = c.req.header('Authorization');
  const headerToken = headerAuth?.startsWith('Bearer ') ? headerAuth.slice(7) : null;
  const token = headerToken || queryToken;
  if (!token) return c.json({ error: '未登录' }, 401);
  const payload = verifyToken(token);
  if (!payload) return c.json({ error: '登录已过期' }, 401);
  const userId = payload.sub;
  // 校验 tokenVersion 防"旧 token 在 URL 里复活". 缓存 10s 跟 authMiddleware 同款
  // 不直接 import getCurrentTokenVersion (避免循环 import), 单独查一次 (静态文件请求不频繁, 性能可接受)
  const tvRow = await db.select({ tokenVersion: schema.users.tokenVersion })
    .from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!tvRow) return c.json({ error: '用户不存在' }, 401);
  if ((payload.tv ?? 0) !== (tvRow.tokenVersion ?? 0)) return c.json({ error: '登录已失效' }, 401);

  // 2. 拿 url path 最后一段 (含 .thumb.jpg 后缀的也对应原 url 鉴权)
  const path = new URL(c.req.url).pathname;
  let filename = path.replace(/^\/api\/uploads\//, '');
  // .thumb.jpg 缩略图对应原文件鉴权 (作者裸名 xxx.png, thumb 路径 xxx.png.thumb.jpg)
  const isThumb = filename.endsWith('.thumb.jpg');
  if (isThumb) filename = filename.slice(0, -('.thumb.jpg'.length));

  // 3. 查 files 表 (avatar 不入表所以查不到 → 公开放行)
  const file = await db.select().from(schema.files).where(eq(schema.files.url, filename)).get();
  if (!file) {
    // 头像 / 历史孤儿: 公开. 让 serveStatic 处理或返回 404
    return next();
  }

  // 4. 作者本人 → 放行
  if (file.userId === userId) return next();

  // 5. 查 url 是否出现在某 shared 笔记 content + 我是该群 active member → 放行
  // markdown link 模式精确匹配防"内容里随便提到这文件名"被误绑授权.
  // 兼容两种 markdown 用法: [label](filename) 跟 ![alt](filename), filename 周围必须是 `(` 跟 `)`/查询参数/空格.
  // 简化版: LIKE '%(${filename})%' OR '%(${filename}?%)' 覆盖 99% 真实用例; 兜底走原 %filename% 作 fallback (放行已知用法 + 保留旧授权)
  const linked = await db.select({ id: schema.notes.id })
    .from(schema.notes)
    .where(and(
      sql`${schema.notes.deletedAt} IS NULL`,
      eq(schema.notes.visibility, 'shared'),
      sql`(${schema.notes.content} LIKE ${'%(' + filename + ')%'}
           OR ${schema.notes.content} LIKE ${'%(' + filename + '?%'}
           OR ${schema.notes.content} LIKE ${'%/' + filename + ')%'}
           OR ${schema.notes.content} LIKE ${'%/' + filename + '?%'})`,
    )).all();
  if (linked.length === 0) return c.json({ error: '无权访问此文件' }, 403);

  // 该文件出现在 N 个共享笔记里, 任一笔记在我所在群 → 放行
  const linkedIds = linked.map(n => n.id);
  const shared = await db.select({ noteId: schema.noteShares.noteId, groupId: schema.noteShares.groupId })
    .from(schema.noteShares)
    .where(inArray(schema.noteShares.noteId, linkedIds))
    .all();
  if (shared.length === 0) return c.json({ error: '无权访问此文件' }, 403);

  const myGroups = await db.select({ groupId: schema.groupMembers.groupId })
    .from(schema.groupMembers)
    .where(and(
      eq(schema.groupMembers.userId, userId),
      eq(schema.groupMembers.status, 'active'),
      inArray(schema.groupMembers.groupId, [...new Set(shared.map(s => s.groupId))]),
    )).all();
  if (myGroups.length === 0) return c.json({ error: '无权访问此文件' }, 403);

  return next();
});
// 静态文件响应加 X-Content-Type-Options: nosniff 防 MIME sniff 绕过, 非白名单类型强制 attachment 让浏览器下载不渲染.
// INLINE_EXT 跟 upload.ts BLOCKED_EXT 配套 (svg/html/脚本 上传已拒, 历史遗留经此 disposition=attachment 兜底).
// 必须 inline 的: 图片 + 音频 + 视频 + PDF (浏览器原生可播放/打开, attachment 会让 <audio>/<video>/PDF viewer 失效)
const INLINE_EXT = new Set([
  // 图片
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'heif',
  // 音频 (audio element 不能加载 attachment 资源)
  'mp3', 'wav', 'm4a', 'ogg', 'oga', 'opus', 'flac',
  // 视频 (video element 同上)
  'mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v',
  // PDF (浏览器内置 viewer)
  'pdf',
]);
// nosniff + 默认 application/octet-stream 会让浏览器拒绝当 audio/video/pdf 加载 (mime 不匹配元素).
// serveStatic 不识别 m4a/heic 等扩展名, 必须手动注入正确 Content-Type. 跟 INLINE_EXT 一对一覆盖
const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/opus', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', m4v: 'video/mp4',
  pdf: 'application/pdf',
};
app.use('/api/uploads/*', async (c, next) => {
  await next();
  // 总是加 nosniff (无论浏览器从哪个 MIME 渲染都不再嗅探, 防 .png 实际是 html 等绕过)
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  const path = new URL(c.req.url).pathname;
  const ext = (path.split('.').pop() || '').toLowerCase();
  // 缩略图 .thumb.jpg 也算图片
  const isThumb = path.endsWith('.thumb.jpg');
  if (isThumb) {
    c.res.headers.set('Content-Type', 'image/jpeg');
  } else if (INLINE_EXT.has(ext)) {
    // 白名单: 注入正确 mime, 让浏览器 <audio>/<video>/PDF viewer 跟 <img> 都能 inline
    const mime = EXT_TO_MIME[ext];
    if (mime) c.res.headers.set('Content-Type', mime);
  } else {
    // 非白名单: 强制 attachment 让浏览器下载. 防 SVG/HTML/JS 等历史文件在浏览器内执行
    const filename = decodeURIComponent(path.split('/').pop() || 'download');
    c.res.headers.set('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  }
});
app.use('/api/uploads/*', serveStatic({ root: './', rewriteRequestPath: (path) => path.replace('/api/uploads', '/uploads') }));

// Routes
app.route('/api/auth', authRoutes);
app.route('/api/notes', notesRoutes);
app.route('/api/categories', categoriesRoutes);
app.route('/api/upload', uploadRoutes);
app.route('/api/ai/chat', aiChatRoutes);
app.route('/api/ai', aiConfigRoutes);
app.route('/api/data', exportRoutes); // GET /api/data = export, POST /api/data = import
app.route('/api/reminder-channels', reminderChannelsRoutes);
app.route('/api/sse', sseRoutes);
app.route('/api/groups', groupsRoutes);
app.route('/api/notifications', notificationsRoutes);
// 邀请页 + 申请走独立挂载点 (GET /api/invite/:token 公开不需 auth, POST .../apply 内部加 authMiddleware)
app.route('/api/invite', inviteApp);

// Health check（不需要登录）
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', name: 'Quink Server', version: '0.1.0' });
});

// Stats（需要登录）
app.get('/api/stats', authMiddleware, async (c) => {
  const userId = c.get('userId');

  // 统计按 origin 维度 - fork 不算新笔记 (parent_note_id IS NULL 才是 origin root, 用户实际创建的)
  const totalNotes = db.select({ count: sql<number>`count(*)` })
    .from(schema.notes).where(and(
      eq(schema.notes.userId, userId),
      sql`${schema.notes.deletedAt} IS NULL AND ${schema.notes.parentNoteId} IS NULL`,
    )).get();
  const totalTodos = db.select({ count: sql<number>`count(*)` })
    .from(schema.notes).where(and(
      eq(schema.notes.userId, userId),
      eq(schema.notes.type, 'todo'),
      sql`${schema.notes.deletedAt} IS NULL AND ${schema.notes.parentNoteId} IS NULL`,
    )).get();
  const pendingTodos = db.select({ count: sql<number>`count(*)` })
    .from(schema.notes).where(
      and(eq(schema.notes.userId, userId), sql`${schema.notes.type} = 'todo' AND ${schema.notes.todoStatus} = 'pending' AND ${schema.notes.deletedAt} IS NULL AND ${schema.notes.parentNoteId} IS NULL`)
    ).get();

  // 每日记录数（热力图）+ 按 type 分组(tooltip 显示当天灵感/笔记/待办各几条)
  // 命名约定: quink=灵感, note=笔记, todo=待办. link 类型已废弃删除
  // parent_note_id IS NULL 过滤 fork (按 origin 维度统计)
  const dailyCounts = db.all(sql`
    SELECT substr(${schema.notes.createdAt}, 1, 10) as date,
      count(*) as count,
      sum(case when ${schema.notes.type} = 'quink' then 1 else 0 end) as quinkCount,
      sum(case when ${schema.notes.type} = 'note' then 1 else 0 end) as noteCount,
      sum(case when ${schema.notes.type} = 'todo' then 1 else 0 end) as todoCount
    FROM notes WHERE user_id = ${userId} AND deleted_at IS NULL AND parent_note_id IS NULL
    GROUP BY date ORDER BY date
  `) as { date: string; count: number; quinkCount: number; noteCount: number; todoCount: number }[];

  // 分类分布（饼图）
  const categoryDist = db.all(sql`
    SELECT COALESCE(${schema.notes.category}, '未分类') as category, count(*) as count
    FROM notes WHERE user_id = ${userId} AND deleted_at IS NULL AND parent_note_id IS NULL
    GROUP BY category ORDER BY count DESC
  `) as { category: string; count: number }[];

  // 类型分布
  const typeDist = db.all(sql`
    SELECT ${schema.notes.type} as type, count(*) as count
    FROM notes WHERE user_id = ${userId} AND deleted_at IS NULL AND parent_note_id IS NULL
    GROUP BY type
  `) as { type: string; count: number }[];

  return c.json({
    data: {
      totalNotes: totalNotes?.count ?? 0,
      totalTodos: totalTodos?.count ?? 0,
      pendingTodos: pendingTodos?.count ?? 0,
      dailyCounts,
      categoryDist,
      typeDist,
    },
  });
});

const PORT = parseInt(process.env.QUINK_PORT || '38999');

console.log(`
  ╭──────────────────────────────────────╮
  │                                      │
  │   Quink Server v0.1.0                │
  │   http://localhost:${PORT}              │
  │                                      │
  ╰──────────────────────────────────────╯
`);

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' });

// 异步给升级前已上传但还没 thumb 的 HEIC 文件批量补 .thumb.jpg. 不阻塞启动
(async () => {
  const [{ backfillHeicThumbs }, { resolve: resolvePath }] = await Promise.all([
    import('./utils/heicThumb.js'),
    import('path'),
  ]);
  const dir = resolvePath(process.cwd(), 'uploads');
  backfillHeicThumbs(dir).catch((e) => console.warn('[backfillHeicThumbs]', e?.message));
})();

// 启动 + 每 6h 跑一次全量清理 (用户改 trashRetentionDays 时另在 PATCH /me 处单独触发该用户的清理, 见 cleanup.ts)
// cleanGroupTrash 7 天扫 + cleanOldAuditSnapshots 90 天清 audit snapshot 字段防 audit 表爆
import { cleanAllTrash, cleanOldNotifications, cleanGroupTrash, cleanOldAuditSnapshots } from './cleanup.js';
cleanAllTrash();
cleanOldNotifications();
cleanGroupTrash();
cleanOldAuditSnapshots();
setInterval(() => {
  cleanAllTrash();
  cleanOldNotifications();
  cleanGroupTrash();
  cleanOldAuditSnapshots();
}, 6 * 60 * 60 * 1000);

// 待办提醒 scheduler: 每分钟扫表, 命中 todoDue <= now 的待办 -> 发到所有 enabled channels
startReminderScheduler();

// 编辑锁过期清理: 60s 扫一次, 兜底 sendBeacon 未触发的孤儿锁
startEditLockCleanup();
