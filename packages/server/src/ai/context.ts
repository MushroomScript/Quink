import { db, schema } from '../db/index.js';
import { eq, and, sql, like, or, desc, inArray } from 'drizzle-orm';
import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(char)) {
      tokens += 1.5;
    } else if (/\s/.test(char)) {
      tokens += 0.25;
    } else {
      tokens += 0.5;
    }
  }
  return Math.ceil(tokens);
}

export function extractKeywords(question: string): string[] {
  const cleaned = question.replace(/[?？！!。，、；：""''（）\[\]{}.,;:'"()\s]+/g, ' ').trim();
  const words: string[] = [];
  const englishWords = cleaned.match(/[a-zA-Z]{2,}/g);
  if (englishWords) words.push(...englishWords);
  const chinese = cleaned.replace(/[a-zA-Z0-9\s]+/g, '');
  if (chinese.length >= 2) {
    for (let len = Math.min(4, chinese.length); len >= 2; len--) {
      for (let i = 0; i <= chinese.length - len; i++) {
        words.push(chinese.slice(i, i + len));
      }
    }
  }
  return [...new Set(words)].slice(0, 15);
}

const INTENT_TYPE_MAP: Record<string, string[]> = {
  '待办': ['todo'], '代办': ['todo'], 'todo': ['todo'],
  '笔记': ['snippet', 'note'], '灵感': ['note'], '记录': ['note', 'snippet'],
};

function detectIntentTypes(question: string): string[] {
  const types: string[] = [];
  for (const [keyword, noteTypes] of Object.entries(INTENT_TYPE_MAP)) {
    if (question.includes(keyword)) types.push(...noteTypes);
  }
  return [...new Set(types)];
}

export async function searchRelevantNotes(userId: string, question: string, limit = 10, previousSourceIds: string[] = []): Promise<typeof schema.notes.$inferSelect[]> {
  const resultMap = new Map<string, typeof schema.notes.$inferSelect>();

  // 1. 上轮引用的笔记直接带入（解决"这条笔记还写了啥"类追问）
  if (previousSourceIds.length) {
    for (const nid of previousSourceIds) {
      const note = await db.select().from(schema.notes)
        .where(and(eq(schema.notes.id, nid), eq(schema.notes.userId, userId))).get();
      if (note && !note.deletedAt) resultMap.set(nid, note);
    }
  }

  // 2. 意图检测：待办/笔记等类型过滤
  const intentTypes = detectIntentTypes(question);
  if (intentTypes.length) {
    const typed = await db.select().from(schema.notes)
      .where(and(
        eq(schema.notes.userId, userId),
        sql`${schema.notes.deletedAt} IS NULL`,
        inArray(schema.notes.type, intentTypes)
      ))
      .orderBy(desc(schema.notes.updatedAt))
      .limit(limit)
      .all();
    for (const n of typed) resultMap.set(n.id, n);
  }

  // 3. 关键词搜索
  const keywords = extractKeywords(question);
  if (keywords.length) {
    const conditions = keywords.slice(0, 8).map(kw =>
      or(
        like(schema.notes.content, `%${kw}%`),
        like(schema.notes.tags, `%${kw}%`),
        like(schema.notes.category, `%${kw}%`)
      )
    );

    const found = await db.select().from(schema.notes)
      .where(and(
        eq(schema.notes.userId, userId),
        sql`${schema.notes.deletedAt} IS NULL`,
        or(...conditions)
      ))
      .orderBy(desc(schema.notes.updatedAt))
      .limit(limit * 2)
      .all();

    for (const n of found) resultMap.set(n.id, n);
  }

  // 按相关度排序
  const notes = [...resultMap.values()];
  const scored = notes.map(note => {
    let score = 0;
    if (previousSourceIds.includes(note.id)) score += 10;
    if (intentTypes.length && intentTypes.includes(note.type)) score += 5;
    const text = (note.content + ' ' + (note.tags as string[]).join(' ') + ' ' + (note.category || '')).toLowerCase();
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) score++;
    }
    return { note, score };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.note);
}

async function resolveReferences(userId: string, content: string, visited: Set<string>, depth: number): Promise<string> {
  if (depth > 2) return content;
  const refRegex = /\[[\s\S]*?\]\(\/?[?&]ref=([^)]+)\)/g;
  let match;
  let result = content;
  const refs: { full: string; noteId: string }[] = [];
  while ((match = refRegex.exec(content)) !== null) {
    const noteId = match[1];
    if (!visited.has(noteId)) {
      refs.push({ full: match[0], noteId });
      visited.add(noteId);
    }
  }
  for (const ref of refs) {
    try {
      const note = await db.select().from(schema.notes)
        .where(and(eq(schema.notes.id, ref.noteId), eq(schema.notes.userId, userId))).get();
      if (note) {
        const expanded = await resolveReferences(userId, note.content, visited, depth + 1);
        result = result.replace(ref.full, `\n[引用笔记内容]: ${expanded}\n`);
      } else {
        result = result.replace(ref.full, '[引用笔记: 已删除]');
      }
    } catch {
      result = result.replace(ref.full, '[引用笔记: 加载失败]');
    }
  }
  return result;
}

async function resolveVoiceLinks(userId: string, content: string): Promise<string> {
  const voiceRegex = /\[语音备忘\s*(\d+)s\]\(([^)]+\.(?:webm|mp3|wav|ogg|m4a))\)/gi;
  let match;
  const replacements: { full: string; dur: string; url: string }[] = [];
  while ((match = voiceRegex.exec(content)) !== null) {
    replacements.push({ full: match[0], dur: match[1], url: match[2] });
  }
  for (const r of replacements) {
    const trans = await db.select().from(schema.voiceTranscriptions)
      .where(and(eq(schema.voiceTranscriptions.userId, userId), eq(schema.voiceTranscriptions.audioUrl, r.url))).get();
    if (trans && trans.status === 'done' && trans.text) {
      content = content.replace(r.full, `[语音转写]: ${trans.text}`);
    } else {
      content = content.replace(r.full, `[语音 ${r.dur}s - 未转写]`);
    }
  }
  return content;
}

function replaceImages(content: string, keepImages: boolean): { text: string; imageUrls: string[] } {
  const imageUrls: string[] = [];
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const text = content.replace(imageRegex, (_, alt, url) => {
    if (keepImages) {
      imageUrls.push(url);
      return `[图片${alt ? ': ' + alt : ''}]`;
    }
    return `[图片${alt ? ': ' + alt : ''}]`;
  });
  return { text, imageUrls };
}

export interface NoteContext {
  text: string;
  imageUrls: string[];
  noteIds: string[];
}

export async function buildNoteContext(userId: string, notes: typeof schema.notes.$inferSelect[], keepImages = false): Promise<NoteContext> {
  const imageUrls: string[] = [];
  const parts: string[] = [];
  const noteIds: string[] = [];

  for (const note of notes) {
    noteIds.push(note.id);
    let content = note.content;
    content = await resolveReferences(userId, content, new Set([note.id]), 0);
    content = await resolveVoiceLinks(userId, content);
    const { text, imageUrls: imgs } = replaceImages(content, keepImages);
    imageUrls.push(...imgs);
    const header = [note.category, ...(note.tags as string[]).map(t => `#${t}`)].filter(Boolean).join(' ');
    parts.push(header ? `[${header}]\n${text}` : text);
  }

  return { text: parts.join('\n\n---\n\n'), imageUrls, noteIds };
}

export async function readImageAsBase64(url: string): Promise<{ base64: string; mediaType: string } | null> {
  try {
    const filePath = resolve(process.cwd(), url.replace(/^\/api\//, ''));
    if (!existsSync(filePath)) return null;
    const buffer = readFileSync(filePath);
    const ext = url.split('.').pop()?.toLowerCase() || 'png';
    const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
    const mediaType = mimeMap[ext] || 'image/png';
    return { base64: buffer.toString('base64'), mediaType };
  } catch {
    return null;
  }
}
