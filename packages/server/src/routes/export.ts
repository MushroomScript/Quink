import { Hono } from 'hono';
import { db, schema } from '../db/index.js';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { authMiddleware } from '../auth.js';
import archiver from 'archiver';
import { resolve } from 'path';
import { existsSync, createReadStream } from 'fs';
import { Readable } from 'stream';
import dayjs from 'dayjs';

const UPLOAD_DIR = resolve(process.cwd(), 'uploads');
const app = new Hono();
app.use('*', authMiddleware);

// GET /api/export — 导出笔记为 ZIP（Markdown + 附件）
// PR #13: 按 user.preferences.sharedDisplay 偏好决定范围 (own/others/none/all). 默认 own (仅作者本人)
// fork 不导出 (parent_note_id IS NULL 过滤, 跟统计同款 origin 维度)
app.get('/', async (c) => {
  const userId = c.get('userId');

  const user = await db.select({ preferences: schema.users.preferences })
    .from(schema.users).where(eq(schema.users.id, userId)).get();
  const sharedDisplay = (user?.preferences as any)?.sharedDisplay || 'own';

  // 拉笔记按 scope 分支
  let notes: Array<typeof schema.notes.$inferSelect>;
  const baseCondition = sql`${schema.notes.deletedAt} IS NULL AND ${schema.notes.parentNoteId} IS NULL`;
  if (sharedDisplay === 'all' || sharedDisplay === 'others') {
    // 我所在的 active 群列表 (导出 shared 笔记必须先确定我能看到哪些群)
    const myGroups = await db.select({ groupId: schema.groupMembers.groupId })
      .from(schema.groupMembers)
      .where(and(eq(schema.groupMembers.userId, userId), eq(schema.groupMembers.status, 'active'))).all();
    const myGroupIds = myGroups.map(g => g.groupId);
    if (sharedDisplay === 'others') {
      if (myGroupIds.length === 0) {
        notes = [];
      } else {
        const sharedNoteIds = await db.selectDistinct({ noteId: schema.noteShares.noteId })
          .from(schema.noteShares).where(inArray(schema.noteShares.groupId, myGroupIds)).all();
        const ids = sharedNoteIds.map(s => s.noteId);
        notes = ids.length === 0 ? [] : await db.select().from(schema.notes).where(and(
          inArray(schema.notes.id, ids),
          sql`${schema.notes.userId} != ${userId}`,
          eq(schema.notes.visibility, 'shared'),
          baseCondition,
        )).all();
      }
    } else {
      // all = own + others
      let sharedIds: string[] = [];
      if (myGroupIds.length > 0) {
        const sharedNotes = await db.selectDistinct({ noteId: schema.noteShares.noteId })
          .from(schema.noteShares).where(inArray(schema.noteShares.groupId, myGroupIds)).all();
        sharedIds = sharedNotes.map(s => s.noteId);
      }
      notes = await db.select().from(schema.notes).where(and(
        sql`(${schema.notes.userId} = ${userId} OR ${schema.notes.id} IN (${sharedIds.length === 0 ? sql`NULL` : sql.join(sharedIds.map(i => sql`${i}`), sql`, `)}))`,
        baseCondition,
      )).all();
    }
  } else if (sharedDisplay === 'none') {
    // 仅 private 笔记 (没有任何共享相关)
    notes = await db.select().from(schema.notes).where(and(
      eq(schema.notes.userId, userId),
      eq(schema.notes.visibility, 'private'),
      baseCondition,
    )).all();
  } else {
    // own (默认): 作者本人的笔记 (含 private + 自己发的 shared)
    notes = await db.select().from(schema.notes).where(and(
      eq(schema.notes.userId, userId),
      baseCondition,
    )).all();
  }

  // 获取所有文件记录
  const files = await db.select().from(schema.files)
    .where(eq(schema.files.userId, userId))
    .all();

  // 创建 ZIP
  const archive = archiver('zip', { zlib: { level: 9 } });

  // 收集 chunks
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));

  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });

  // 笔记 → Markdown 文件
  for (const note of notes) {
    const date = dayjs(note.createdAt).format('YYYY-MM-DD_HHmmss');
    // PR #8 命名重整: quink=灵感, note=笔记, todo=待办
    const typeLabel = note.type === 'todo' ? '待办' : note.type === 'note' ? '笔记' : '灵感';
    const filename = `notes/${date}_${typeLabel}_${note.id}.md`;

    // YAML frontmatter + content
    const tags = (note.tags as string[]) || [];
    const frontmatter = [
      '---',
      `id: ${note.id}`,
      `type: ${note.type}`,
      `category: ${note.category || ''}`,
      `tags: [${tags.map(t => `"${t}"`).join(', ')}]`,
      `todoStatus: ${note.todoStatus || ''}`,
      `pinned: ${note.pinned}`,
      `created: ${note.createdAt}`,
      `updated: ${note.updatedAt}`,
      '---',
      '',
    ].join('\n');

    archive.append(frontmatter + note.content, { name: filename });
  }

  // 附件文件
  for (const file of files) {
    const diskPath = resolve(UPLOAD_DIR, file.url.replace('/api/uploads/', ''));
    if (existsSync(diskPath)) {
      archive.file(diskPath, { name: `attachments/${file.filename}` });
    }
  }

  // 元数据
  const meta = {
    exportedAt: dayjs().toISOString(),
    noteCount: notes.length,
    fileCount: files.length,
    version: '0.1.0',
  };
  archive.append(JSON.stringify(meta, null, 2), { name: 'meta.json' });

  archive.finalize();
  await done;

  const buffer = Buffer.concat(chunks);
  const filename = `quink-export-${dayjs().format('YYYYMMDD-HHmmss')}.zip`;

  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
});

// POST /api/import — 导入 ZIP
// 安全审计 M13: zip bomb 防御. 压缩文件大小上限 + 解压后总大小上限 + 单文件大小上限
const IMPORT_ZIP_MAX = 50 * 1024 * 1024;          // 50MB 压缩文件
const IMPORT_UNCOMPRESSED_MAX = 500 * 1024 * 1024; // 500MB 解压总大小 (压缩比 1:10 容限)
const IMPORT_FILE_MAX = 10 * 1024 * 1024;          // 10MB 单文件
const IMPORT_FILE_COUNT_MAX = 10000;               // 1 万文件上限

app.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.parseBody();
  const file = body['file'];

  if (!file || typeof file === 'string') {
    return c.json({ error: '请选择 ZIP 文件' }, 400);
  }

  // 安全审计 M13: 压缩文件大小检查
  if (file.size > IMPORT_ZIP_MAX) {
    return c.json({ error: `ZIP 文件过大 (上限 ${IMPORT_ZIP_MAX / 1024 / 1024} MB)` }, 400);
  }

  // 简单导入：解析 ZIP 中的 Markdown 文件
  // 使用 JSZip 代替 unzipper（更简单）
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(buffer);

    let imported = 0;
    const noteFiles = Object.keys(zip.files).filter(f => f.startsWith('notes/') && f.endsWith('.md'));

    // 安全审计 M13: 文件数 + 解压总大小检查
    if (noteFiles.length > IMPORT_FILE_COUNT_MAX) {
      return c.json({ error: `ZIP 内文件过多 (上限 ${IMPORT_FILE_COUNT_MAX})` }, 400);
    }
    let uncompressedTotal = 0;

    for (const filename of noteFiles) {
      const content = await zip.files[filename].async('string');
      // 单文件 + 总大小限制 (utf-8 byte length 近似 chars * 3)
      const fileSize = Buffer.byteLength(content, 'utf-8');
      if (fileSize > IMPORT_FILE_MAX) {
        return c.json({ error: `单文件过大: ${filename}` }, 400);
      }
      uncompressedTotal += fileSize;
      if (uncompressedTotal > IMPORT_UNCOMPRESSED_MAX) {
        return c.json({ error: `解压总大小超限 (上限 ${IMPORT_UNCOMPRESSED_MAX / 1024 / 1024} MB), 疑似 zip bomb` }, 400);
      }

      // 解析 frontmatter
      let noteContent = content;
      let meta: Record<string, any> = {};

      if (content.startsWith('---')) {
        const endIdx = content.indexOf('---', 3);
        if (endIdx > 0) {
          const frontmatter = content.substring(3, endIdx).trim();
          noteContent = content.substring(endIdx + 3).trim();

          for (const line of frontmatter.split('\n')) {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
              const key = line.substring(0, colonIdx).trim();
              const val = line.substring(colonIdx + 1).trim();
              meta[key] = val;
            }
          }
        }
      }

      // 解析 tags
      let tags: string[] = [];
      if (meta.tags) {
        try {
          tags = JSON.parse(meta.tags.replace(/'/g, '"'));
        } catch {}
      }

      const { nanoid } = await import('nanoid');
      const now = dayjs().toISOString();

      await db.insert(schema.notes).values({
        id: nanoid(12),
        userId,
        content: noteContent,
        type: meta.type || 'note',
        category: meta.category || null,
        tags,
        todoStatus: meta.todoStatus || null,
        summary: null,
        aiProcessed: false,
        pinned: meta.pinned === 'true',
        createdAt: meta.created || now,
        updatedAt: now,
        deletedAt: null,
      });
      imported++;
    }

    return c.json({ data: { imported, total: noteFiles.length } });
  } catch (err: any) {
    return c.json({ error: '导入失败: ' + err.message }, 500);
  }
});

export default app;
