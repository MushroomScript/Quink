import { Hono } from 'hono';
import { authMiddleware } from '../auth.js';
import { publish } from '../reminder/bus.js';
import { db, schema } from '../db/index.js';
import { eq, desc, and, isNull, inArray } from 'drizzle-orm';
import { resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { Readable } from 'stream';
import archiver from 'archiver';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';
import { toPinyinSearchable } from '../utils/pinyin.js';
import { isHeicFilename, generateHeicThumb, heicThumbPath, backfillHeicThumbs } from '../utils/heicThumb.js';
import { isThumbableImage, generateImageThumb } from '../utils/imageThumb.js';

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

// 拼唯一磁盘文件名 + 冲突检测（同秒多次上传时追加 _2/_3）.
// 入参 safeName 必须已 sanitize（小写字母/数字/中文等安全字符）. 调用方按需自己组装 displayFilename
function buildUniqueFilename(safeName: string, ext: string): string {
  const datePrefix = dayjs().format('YYYY-MM-DD_HHmmss');
  const base = `${datePrefix}_${safeName}`;
  let filename = `${base}.${ext}`;
  let counter = 2;
  while (existsSync(resolve(UPLOAD_DIR, filename))) {
    filename = `${base}_${counter}.${ext}`;
    counter++;
  }
  return filename;
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
  const filename = buildUniqueFilename('avatar', ext);
  const diskPath = resolve(UPLOAD_DIR, filename);
  writeFileSync(diskPath, Buffer.from(await file.arrayBuffer()));

  // 同步生成 thumb (头像 2MB 上限 + sharp 处理 < 300ms 可接受). 失败 swallow, 前端 onError 兜底原图
  if (isThumbableImage(filename)) {
    try {
      await generateImageThumb(diskPath);
    } catch (e: any) {
      console.warn('[upload] avatar thumb generation failed:', filename, e?.message);
    }
  }

  publish(userId, 'data-changed', { scope: 'user-profile' }, _ocid);
  return c.json({ data: { url: `/api/uploads/${filename}` } }, 201);
});

// POST /api/upload/file — general file upload (任意类型，最大 100MB)
app.post('/file', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];
  const displayNameField = body['displayName'];
  const folderIdField = body['folderId']; // 可选, 不传 = 上传到根目录

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

  const safeName = sanitizeName(rawName);
  const filename = buildUniqueFilename(safeName, ext);
  const displayFilename = `${safeName}.${ext}`;
  const diskPath = resolve(UPLOAD_DIR, filename);
  writeFileSync(diskPath, Buffer.from(await file.arrayBuffer()));

  // HEIC 同步生成 <basename>.thumb.jpg 缩略图. 前端 HeicImage 直接 GET 这个 thumb URL,
  // 不再客户端转码 (用 libheif-js + jpeg-js, 1-3s 阻塞上传响应, 个人使用场景可接受)
  if (isHeicFilename(filename)) {
    try {
      await generateHeicThumb(diskPath);
    } catch (e: any) {
      console.warn('[upload] HEIC thumb generation failed:', filename, e?.message);
    }
  } else if (isThumbableImage(filename)) {
    // 普通图片 (jpg/png/webp/gif) 同步生成 sharp thumb. resources 缩略图 + 笔记里嵌图都受益.
    // 大图 sharp 处理 200-500ms 阻塞上传响应, 单次上传可接受. 失败 swallow, 前端 onError 兜底原图
    try {
      await generateImageThumb(diskPath);
    } catch (e: any) {
      console.warn('[upload] image thumb generation failed:', filename, e?.message);
    }
  }

  // url 只存裸的磁盘文件名(不含 /api/uploads/ 前缀),前端 resolveFileUrl helper 拼前缀
  const url = filename;
  const category = getFileCategory(file.type);
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const id = nanoid(12);

  const folderId = typeof folderIdField === 'string' && folderIdField ? folderIdField : null;
  await db.insert(schema.files).values({
    id,
    userId,
    filename: displayFilename,
    url,
    mimeType: file.type || 'application/octet-stream',
    category,
    size: file.size,
    folderId,
    createdAt: dayjs().toISOString(),
  });

  publish(userId, 'data-changed', { scope: 'resources' }, _ocid);
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
  const _ocid = c.req.header('X-Quink-Client-Id');
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
  const _ocid = c.req.header('X-Quink-Client-Id');
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

  publish(userId, 'data-changed', { scope: 'resources' }, _ocid);
  return c.json({ data: { ...file, filename: newName } });
});

// DELETE /api/upload/files/:id
app.delete('/files/:id', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
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
  publish(userId, 'data-changed', { scope: 'resources' }, _ocid);
  return c.json({ message: '已删除' });
});

// ──────────── 文件夹相关 ────────────

// GET /api/upload/folders — 列出当前用户所有文件夹 (嵌套树由前端按 parentId 组装)
app.get('/folders', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const results = await db.select().from(schema.folders)
    .where(eq(schema.folders.userId, userId))
    .orderBy(schema.folders.name)
    .all();
  return c.json({ data: results });
});

// POST /api/upload/folders — 创建文件夹. body: { name, parentId?: string | null }
app.post('/folders', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : null;
  if (!name) return c.json({ error: '文件夹名不能为空' }, 400);
  if (name.length > 80) return c.json({ error: '文件夹名过长' }, 400);
  // 校验 parentId 真实存在且属于当前用户 (防造假 parentId)
  if (parentId) {
    const parent = await db.select().from(schema.folders).where(eq(schema.folders.id, parentId)).get();
    if (!parent || parent.userId !== userId) return c.json({ error: '父文件夹不存在' }, 400);
  }
  const id = nanoid(12);
  const row = { id, userId, name, parentId, createdAt: dayjs().toISOString() };
  await db.insert(schema.folders).values(row);
  publish(userId, 'data-changed', { scope: 'resources' }, _ocid);
  return c.json({ data: row }, 201);
});

// PATCH /api/upload/folders/:id — 重命名文件夹. body: { name }
app.patch('/folders/:id', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const newName = typeof body.name === 'string' ? body.name.trim() : '';
  if (!newName) return c.json({ error: '文件夹名不能为空' }, 400);
  const folder = await db.select().from(schema.folders).where(eq(schema.folders.id, id)).get();
  if (!folder || folder.userId !== userId) return c.json({ error: '文件夹不存在' }, 404);
  await db.update(schema.folders).set({ name: newName }).where(eq(schema.folders.id, id));
  publish(userId, 'data-changed', { scope: 'resources' }, _ocid);
  return c.json({ data: { ...folder, name: newName } });
});

// 递归收集 folder 下所有子文件夹 (含自身) + 它们的 files. relPath 是相对原 folder 的路径
async function collectFolderTree(userId: string, rootFolderId: string): Promise<{ files: Array<{ id: string; url: string; filename: string; relPath: string }>; folderIds: string[] }> {
  const allFolders = await db.select().from(schema.folders).where(eq(schema.folders.userId, userId)).all();
  const allFiles = await db.select().from(schema.files).where(eq(schema.files.userId, userId)).all();
  const byParent = new Map<string | null, typeof allFolders>();
  for (const f of allFolders) {
    const arr = byParent.get(f.parentId) || [];
    arr.push(f);
    byParent.set(f.parentId, arr);
  }
  const filesInFolder = new Map<string | null, typeof allFiles>();
  for (const f of allFiles) {
    const arr = filesInFolder.get(f.folderId) || [];
    arr.push(f);
    filesInFolder.set(f.folderId, arr);
  }
  const result: { files: Array<{ id: string; url: string; filename: string; relPath: string }>; folderIds: string[] } = { files: [], folderIds: [] };
  function walk(folderId: string, prefix: string) {
    result.folderIds.push(folderId);
    for (const f of filesInFolder.get(folderId) || []) {
      result.files.push({ id: f.id, url: f.url, filename: f.filename, relPath: prefix ? `${prefix}/${f.filename}` : f.filename });
    }
    for (const child of byParent.get(folderId) || []) {
      walk(child.id, prefix ? `${prefix}/${child.name}` : child.name);
    }
  }
  walk(rootFolderId, '');
  return result;
}

// GET /api/upload/folders/:id/download — 把文件夹内容(含子文件夹递归) 打包 zip 流式响应
app.get('/folders/:id/download', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { id } = c.req.param();
  const folder = await db.select().from(schema.folders).where(eq(schema.folders.id, id)).get();
  if (!folder || folder.userId !== userId) return c.json({ error: '文件夹不存在' }, 404);
  const tree = await collectFolderTree(userId, id);
  const archive = archiver('zip', { zlib: { level: 6 } });
  for (const f of tree.files) {
    const diskPath = resolve(UPLOAD_DIR, f.url);
    if (existsSync(diskPath)) archive.file(diskPath, { name: `${folder.name}/${f.relPath}` });
  }
  archive.finalize();
  // Node Readable → Web ReadableStream (node 18+ 内置)
  const stream = Readable.toWeb(archive as any) as ReadableStream;
  c.header('Content-Type', 'application/zip');
  c.header('Content-Disposition', `attachment; filename="${encodeURIComponent(folder.name)}.zip"`);
  return c.body(stream);
});

// DELETE /api/upload/folders/:id — 删除文件夹.
// body { deleteFiles?: boolean }:
//   - false (默认): 内部文件 folderId 设回上级 (回根 / 父文件夹), 子文件夹 parent_id 提升一级
//   - true: 递归删除文件夹内所有文件 (含子文件夹) + 删除子文件夹本身
app.delete('/folders/:id', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const deleteFiles = body.deleteFiles === true;
  const folder = await db.select().from(schema.folders).where(eq(schema.folders.id, id)).get();
  if (!folder || folder.userId !== userId) return c.json({ error: '文件夹不存在' }, 404);
  if (deleteFiles) {
    // 递归删: 收集所有子文件夹 + 文件
    const tree = await collectFolderTree(userId, id);
    // DB 事务先删 (要么全成 要么全不动, 避免 files 删了 folders 没删的孤儿状态),
    // 磁盘删放事务之后 best-effort (磁盘删失败留孤儿文件占空间, 不影响 DB consistency, 比 "DB 删了磁盘留" 用户视角少看 missing-file 报错)
    db.transaction((tx) => {
      if (tree.files.length) {
        tx.delete(schema.files).where(and(eq(schema.files.userId, userId), inArray(schema.files.id, tree.files.map(x => x.id)))).run();
      }
      if (tree.folderIds.length) {
        tx.delete(schema.folders).where(and(eq(schema.folders.userId, userId), inArray(schema.folders.id, tree.folderIds))).run();
      }
    });
    // 物理删 (best-effort, 失败留孤儿)
    for (const f of tree.files) {
      try {
        const diskPath = resolve(UPLOAD_DIR, f.url);
        if (existsSync(diskPath)) unlinkSync(diskPath);
      } catch {}
    }
  } else {
    // 不删文件: folder_id / parent_id 提升一级
    await db.update(schema.files).set({ folderId: folder.parentId }).where(and(eq(schema.files.userId, userId), eq(schema.files.folderId, id)));
    await db.update(schema.folders).set({ parentId: folder.parentId }).where(and(eq(schema.folders.userId, userId), eq(schema.folders.parentId, id)));
    await db.delete(schema.folders).where(eq(schema.folders.id, id));
  }
  publish(userId, 'data-changed', { scope: 'resources' }, _ocid);
  return c.json({ message: '已删除' });
});

// POST /api/upload/items/move — 批量移动文件和/或文件夹到指定文件夹 (targetFolderId null = 移到根目录).
// body: { fileIds?: string[]; folderIds?: string[]; targetFolderId: string | null }
// 校验循环: 文件夹不能移动到自己 / 自己子孙内 (否则形成 cycle)
app.post('/items/move', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const body = await c.req.json().catch(() => ({}));
  const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter((x: any) => typeof x === 'string') : [];
  const folderIds = Array.isArray(body.folderIds) ? body.folderIds.filter((x: any) => typeof x === 'string') : [];
  const targetFolderId = typeof body.targetFolderId === 'string' && body.targetFolderId ? body.targetFolderId : null;
  if (!fileIds.length && !folderIds.length) return c.json({ error: '没有要移动的项' }, 400);
  // 目标 folder 必须存在
  if (targetFolderId) {
    const folder = await db.select().from(schema.folders).where(eq(schema.folders.id, targetFolderId)).get();
    if (!folder || folder.userId !== userId) return c.json({ error: '目标文件夹不存在' }, 400);
  }
  // 文件夹循环校验
  if (folderIds.length) {
    const allFolders = await db.select().from(schema.folders).where(eq(schema.folders.userId, userId)).all();
    const childrenMap = new Map<string | null, string[]>();
    for (const f of allFolders) {
      const arr = childrenMap.get(f.parentId) || [];
      arr.push(f.id);
      childrenMap.set(f.parentId, arr);
    }
    function descendants(id: string): Set<string> {
      const r = new Set<string>([id]);
      let q = [id];
      while (q.length) {
        const next: string[] = [];
        for (const fid of q) {
          for (const child of childrenMap.get(fid) || []) {
            if (!r.has(child)) { r.add(child); next.push(child); }
          }
        }
        q = next;
      }
      return r;
    }
    for (const sId of folderIds) {
      if (sId === targetFolderId) return c.json({ error: '不能把文件夹移动到自身' }, 400);
      const desc = descendants(sId);
      if (targetFolderId && desc.has(targetFolderId)) return c.json({ error: '不能把文件夹移动到它的子文件夹内' }, 400);
    }
  }
  // 执行
  db.transaction((tx) => {
    if (fileIds.length) tx.update(schema.files).set({ folderId: targetFolderId }).where(and(eq(schema.files.userId, userId), inArray(schema.files.id, fileIds))).run();
    if (folderIds.length) tx.update(schema.folders).set({ parentId: targetFolderId }).where(and(eq(schema.folders.userId, userId), inArray(schema.folders.id, folderIds))).run();
  });
  publish(userId, 'data-changed', { scope: 'resources' }, _ocid);
  return c.json({ message: '已移动', count: fileIds.length + folderIds.length });
});

// POST /api/upload/files/move — 批量移动文件到指定文件夹 (folderId null = 移到根目录).
// body: { ids: string[], folderId: string | null }
app.post('/files/move', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const body = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.filter((x: any) => typeof x === 'string') : [];
  const folderId = typeof body.folderId === 'string' && body.folderId ? body.folderId : null;
  if (!ids.length) return c.json({ error: 'ids 不能为空' }, 400);
  // 校验目标文件夹真实存在 (null = 根目录, 不校验)
  if (folderId) {
    const folder = await db.select().from(schema.folders).where(eq(schema.folders.id, folderId)).get();
    if (!folder || folder.userId !== userId) return c.json({ error: '目标文件夹不存在' }, 400);
  }
  await db.update(schema.files).set({ folderId }).where(and(eq(schema.files.userId, userId), inArray(schema.files.id, ids)));
  publish(userId, 'data-changed', { scope: 'resources' }, _ocid);
  return c.json({ message: '已移动', count: ids.length });
});

export default app;
