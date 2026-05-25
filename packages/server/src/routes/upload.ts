import { Hono } from 'hono';
import { authMiddleware } from '../auth.js';
import { db, schema } from '../db/index.js';
import { eq, desc } from 'drizzle-orm';
import { resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';
import { toPinyinSearchable } from '../utils/pinyin.js';

const UPLOAD_DIR = resolve(process.cwd(), 'uploads');

if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

const app = new Hono();

app.use('*', authMiddleware);

const MAX_SIZE = 100 * 1024 * 1024; // 100MB
const AVATAR_MAX_SIZE = 2 * 1024 * 1024; // 2MB

// 头像仍然限制图片类型
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// MIME → 扩展名 fallback（仅在 file.name 无扩展名时用）
const MIME_EXT_MAP: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
  'audio/webm': 'webm', 'audio/mp4': 'm4a',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md',
  'text/csv': 'csv', 'application/json': 'json', 'application/zip': 'zip',
};

function getExt(type: string, originalName?: string): string {
  if (originalName) {
    const lastDot = originalName.lastIndexOf('.');
    if (lastDot > 0 && lastDot < originalName.length - 1) {
      return originalName.slice(lastDot + 1).toLowerCase();
    }
  }
  return MIME_EXT_MAP[type] || 'bin';
}

function getFileCategory(type: string): string {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (
    type.startsWith('text/') ||
    type === 'application/pdf' ||
    type === 'application/json' ||
    /^application\/(msword|vnd\.openxmlformats|vnd\.ms-)/.test(type)
  ) return 'document';
  return 'other';
}

// 清理用户输入：Windows/POSIX 非法字符 + 控制符 + 路径穿越
function sanitizeName(name: string): string {
  let s = name.trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\.+/g, '.')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!s) s = '未命名';
  if (s.length > 100) s = s.slice(0, 100);
  return s;
}

// 拼磁盘文件名 + 冲突检测（同秒多次上传时追加 _2/_3）
function buildFilename(displayName: string, ext: string): { filename: string; displayFilename: string } {
  const safe = sanitizeName(displayName);
  const datePrefix = dayjs().format('YYYY-MM-DD_HHmmss');
  const base = `${datePrefix}_${safe}`;
  let filename = `${base}.${ext}`;
  let counter = 2;
  while (existsSync(resolve(UPLOAD_DIR, filename))) {
    filename = `${base}_${counter}.${ext}`;
    counter++;
  }
  return { filename, displayFilename: `${safe}.${ext}` };
}

function nameFromOriginal(originalName: string): string {
  if (!originalName) return 'file';
  const lastDot = originalName.lastIndexOf('.');
  const base = lastDot > 0 ? originalName.slice(0, lastDot) : originalName;
  return base || 'file';
}

// POST /api/upload/avatar — upload avatar image
app.post('/avatar', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];

  if (!file || typeof file === 'string') {
    return c.json({ error: '请选择图片文件' }, 400);
  }

  if (!AVATAR_TYPES.includes(file.type)) {
    return c.json({ error: '仅支持 JPG/PNG/GIF/WebP 格式' }, 400);
  }

  if (file.size > AVATAR_MAX_SIZE) {
    return c.json({ error: '头像大小不能超过 2MB' }, 400);
  }

  const ext = getExt(file.type, file.name);
  const { filename } = buildFilename('avatar', ext);
  writeFileSync(resolve(UPLOAD_DIR, filename), Buffer.from(await file.arrayBuffer()));

  return c.json({ data: { url: `/api/uploads/${filename}` } }, 201);
});

// POST /api/upload/file — general file upload (任意类型，最大 100MB)
app.post('/file', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];
  const displayNameField = body['displayName'];

  if (!file || typeof file === 'string') {
    return c.json({ error: '请选择文件' }, 400);
  }

  if (file.size > MAX_SIZE) {
    return c.json({ error: '文件大小不能超过 100MB' }, 400);
  }

  const ext = getExt(file.type, file.name);

  // displayName 优先（录音弹窗输入），否则用 file.name 去扩展名（粘贴/拖拽）
  const rawName = typeof displayNameField === 'string' && displayNameField.trim()
    ? displayNameField
    : nameFromOriginal(file.name);

  const { filename, displayFilename } = buildFilename(rawName, ext);
  writeFileSync(resolve(UPLOAD_DIR, filename), Buffer.from(await file.arrayBuffer()));

  // url 只存裸的磁盘文件名(不含 /api/uploads/ 前缀),前端 resolveFileUrl helper 拼前缀
  const url = filename;
  const category = getFileCategory(file.type);
  const userId = c.get('userId');
  const id = nanoid(12);

  await db.insert(schema.files).values({
    id,
    userId,
    filename: displayFilename,
    url,
    mimeType: file.type || 'application/octet-stream',
    category,
    size: file.size,
    createdAt: dayjs().toISOString(),
  });

  return c.json({
    data: {
      id,
      url,
      filename: displayFilename,
      type: file.type,
      category,
      size: file.size,
    },
  }, 201);
});

// GET /api/upload/files — list all uploaded files for current user
app.get('/files', async (c) => {
  const userId = c.get('userId');
  const results = await db.select().from(schema.files)
    .where(eq(schema.files.userId, userId))
    .orderBy(desc(schema.files.createdAt))
    .all();
  return c.json({ data: results });
});

// PATCH /api/upload/files/:id — 重命名(只改 DB display name,磁盘真实路径不动避免 url 失效)
// 同时扫描该用户所有笔记,把 markdown link `[oldName](url)` 同步改成 `[newName](url)`
app.patch('/files/:id', async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const newName = typeof body.filename === 'string' ? body.filename.trim() : '';
  if (!newName) return c.json({ error: '文件名不能为空' }, 400);

  const file = await db.select().from(schema.files)
    .where(eq(schema.files.id, id)).get();
  if (!file || file.userId !== userId) {
    return c.json({ error: '文件不存在' }, 404);
  }
  if (file.filename === newName) {
    return c.json({ data: file });
  }

  // 历史名字累积: 旧名加入 history(去重),让多次重命名后 label 是"任一历史名"都能识别为可同步
  const oldName = file.filename;
  const prevHistory: string[] = (() => {
    try { return file.filenameHistory ? JSON.parse(file.filenameHistory) : []; } catch { return []; }
  })();
  const newHistory = prevHistory.includes(oldName) ? prevHistory : [...prevHistory, oldName];

  await db.update(schema.files)
    .set({ filename: newName, filenameHistory: JSON.stringify(newHistory) })
    .where(eq(schema.files.id, id));

  // 扫描所有引用该文件 URL 的笔记,把 markdown link label 同步更新。
  // 关键: label 必须是 currentName 或任一 historyName(说明这个 label 曾经是系统填的文件名)才同步;
  // 用户改过 label 成自定义文案(如"今天开会录音")的保留不动。
  // 但本质上 markdown 文本无法 100% 区分"用户故意写了跟文件名一样的 label"——这种 case 概率低,接受
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 路径稳健性: regex 同时支持 `[label](url)` `![label](url)` 和 label 内 `\]` 转义
  //   - `[^\]\\]*` 匹配非 ] 非 \,搭配后面 `(?:\\.[^\]\\]*)*` 允许 `\]`/`\\` 等转义
  //   - url 用 escapeRegex 100% 完整匹配,不会误伤
  const linkPattern = new RegExp(`\\[((?:[^\\]\\\\]|\\\\.)*)\\]\\(${escapeRegex(file.url)}\\)`, 'g');
  const validLabels = new Set([...prevHistory, oldName]);
  const notes = await db.select().from(schema.notes)
    .where(eq(schema.notes.userId, userId)).all();
  const now = dayjs().toISOString();
  for (const note of notes) {
    if (!note.content.includes(file.url)) continue;
    const newContent = note.content.replace(linkPattern, (match, label) => {
      if (validLabels.has(label)) return `[${newName}](${file.url})`;
      return match;
    });
    if (newContent !== note.content) {
      await db.update(schema.notes)
        .set({ content: newContent, contentPinyin: toPinyinSearchable(newContent), updatedAt: now })
        .where(eq(schema.notes.id, note.id));
    }
  }

  return c.json({ data: { ...file, filename: newName } });
});

// DELETE /api/upload/files/:id
app.delete('/files/:id', async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.param();
  const file = await db.select().from(schema.files)
    .where(eq(schema.files.id, id)).get();
  if (!file || file.userId !== userId) {
    return c.json({ error: '文件不存在' }, 404);
  }
  await db.delete(schema.files).where(eq(schema.files.id, id));
  // 删除磁盘文件
  try {
    const diskPath = resolve(UPLOAD_DIR, file.url.replace('/api/uploads/', ''));
    if (existsSync(diskPath)) unlinkSync(diskPath);
  } catch {}
  return c.json({ message: '已删除' });
});

export default app;
