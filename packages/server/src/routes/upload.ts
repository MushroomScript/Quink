import { Hono } from 'hono';
import { authMiddleware } from '../auth.js';
import { db, schema } from '../db/index.js';
import { eq, desc } from 'drizzle-orm';
import { resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';

const UPLOAD_DIR = resolve(process.cwd(), 'uploads');

if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

const app = new Hono();

app.use('*', authMiddleware);

const ALLOWED_TYPES: Record<string, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4'],
  document: [
    'application/pdf',
    'text/plain', 'text/markdown', 'text/csv',
    'application/json',
    'application/zip',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
};

const ALL_ALLOWED = Object.values(ALLOWED_TYPES).flat();
const MAX_SIZE = 20 * 1024 * 1024; // 20MB

function getExtFromType(type: string, originalName?: string): string {
  // Try to get ext from original filename first
  if (originalName) {
    const parts = originalName.split('.');
    if (parts.length > 1) return parts.pop()!;
  }
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
    'audio/webm': 'webm', 'audio/mp4': 'm4a',
    'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md',
    'text/csv': 'csv', 'application/json': 'json', 'application/zip': 'zip',
  };
  return map[type] || 'bin';
}

function getFileCategory(type: string): string {
  for (const [cat, types] of Object.entries(ALLOWED_TYPES)) {
    if (types.includes(type)) return cat;
  }
  return 'other';
}

// POST /api/upload/avatar — upload avatar image (kept for backwards compat)
app.post('/avatar', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];

  if (!file || typeof file === 'string') {
    return c.json({ error: '请选择图片文件' }, 400);
  }

  if (!ALLOWED_TYPES.image.includes(file.type)) {
    return c.json({ error: '仅支持 JPG/PNG/GIF/WebP 格式' }, 400);
  }

  if (file.size > 2 * 1024 * 1024) {
    return c.json({ error: '图片大小不能超过 2MB' }, 400);
  }

  const ext = getExtFromType(file.type, file.name);
  const filename = `${nanoid(12)}.${ext}`;
  writeFileSync(resolve(UPLOAD_DIR, filename), Buffer.from(await file.arrayBuffer()));

  return c.json({ data: { url: `/api/uploads/${filename}` } }, 201);
});

// POST /api/upload/file — general file upload
app.post('/file', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];

  if (!file || typeof file === 'string') {
    return c.json({ error: '请选择文件' }, 400);
  }

  if (!ALL_ALLOWED.includes(file.type)) {
    return c.json({ error: `不支持的文件类型: ${file.type}` }, 400);
  }

  if (file.size > MAX_SIZE) {
    return c.json({ error: '文件大小不能超过 20MB' }, 400);
  }

  const ext = getExtFromType(file.type, file.name);
  const filename = `${nanoid(12)}.${ext}`;
  writeFileSync(resolve(UPLOAD_DIR, filename), Buffer.from(await file.arrayBuffer()));

  const url = `/api/uploads/${filename}`;
  const category = getFileCategory(file.type);
  const userId = c.get('userId');
  const id = nanoid(12);

  // Save file record to database
  await db.insert(schema.files).values({
    id,
    userId,
    filename: file.name || filename,
    url,
    mimeType: file.type,
    category,
    size: file.size,
    createdAt: dayjs().toISOString(),
  });

  return c.json({
    data: {
      id,
      url,
      filename: file.name || filename,
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
