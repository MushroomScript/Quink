import { Hono } from 'hono';
import { db, schema } from '../db/index.js';
import { eq, sql } from 'drizzle-orm';
import { authMiddleware } from '../auth.js';
import archiver from 'archiver';
import { resolve } from 'path';
import { existsSync, createReadStream } from 'fs';
import { Readable } from 'stream';
import dayjs from 'dayjs';

const UPLOAD_DIR = resolve(process.cwd(), 'uploads');
const app = new Hono();
app.use('*', authMiddleware);

// GET /api/export — 导出所有笔记为 ZIP（Markdown + 附件）
app.get('/', async (c) => {
  const userId = c.get('userId');

  // 获取所有未删除的笔记
  const notes = await db.select().from(schema.notes)
    .where(eq(schema.notes.userId, userId))
    .all();

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
    const typeLabel = note.type === 'todo' ? '待办' : note.type === 'snippet' ? '笔记' : '灵感';
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
app.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.parseBody();
  const file = body['file'];

  if (!file || typeof file === 'string') {
    return c.json({ error: '请选择 ZIP 文件' }, 400);
  }

  // 简单导入：解析 ZIP 中的 Markdown 文件
  // 使用 JSZip 代替 unzipper（更简单）
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(buffer);

    let imported = 0;
    const noteFiles = Object.keys(zip.files).filter(f => f.startsWith('notes/') && f.endsWith('.md'));

    for (const filename of noteFiles) {
      const content = await zip.files[filename].async('string');

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
        todoDue: null,
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
