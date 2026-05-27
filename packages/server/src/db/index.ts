import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { resolve } from 'path';
import { toPinyinSearchable } from '../utils/pinyin.js';

const DB_PATH = process.env.QUINK_DB_PATH || resolve(process.cwd(), 'quink.db');

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

// Auto-create tables on first run
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    nickname TEXT NOT NULL,
    avatar TEXT,
    preferences TEXT DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    summary TEXT,
    category TEXT,
    tags TEXT DEFAULT '[]',
    type TEXT NOT NULL DEFAULT 'note',
    todo_status TEXT,
    todo_due TEXT,
    ai_processed INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    parent_id INTEGER,
    icon TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    filename TEXT NOT NULL,
    url TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    category TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_configs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT,
    model TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_prompts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    feature TEXT NOT NULL,
    prompt TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS ai_conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL DEFAULT '新对话',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES ai_conversations(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    sources TEXT DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS voice_transcriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    audio_url TEXT NOT NULL,
    text TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    parent_id TEXT,
    created_at TEXT NOT NULL
  );
`);
// Migrate: files.folder_id (资源页文件夹: null = 根目录, 非 null = 在指定 folders.id 下)
try { sqlite.exec('ALTER TABLE files ADD COLUMN folder_id TEXT'); } catch {}

// Migrate: add deleted_at column if not exists
try { sqlite.exec('ALTER TABLE notes ADD COLUMN deleted_at TEXT'); } catch {}
// Migrate: files.filename_history(JSON 数组,重命名时记录所有曾用过的 displayName,让"曾经是文件名的 label"也能识别为可同步)
try { sqlite.exec('ALTER TABLE files ADD COLUMN filename_history TEXT'); } catch {}
// Migrate: 把 /api/uploads/ 前缀从 files.url + notes.content 里 REPLACE 掉(新格式 url 裸名,渲染层拼前缀)。
// 用 WHERE LIKE 限制只 update 还残留前缀的 row,后续启动 LIKE 不匹配自然跳过,反复跑无害。
try { sqlite.exec(`UPDATE files SET url = REPLACE(url, '/api/uploads/', '') WHERE url LIKE '/api/uploads/%'`); } catch {}
try { sqlite.exec(`UPDATE notes SET content = REPLACE(content, '/api/uploads/', '') WHERE content LIKE '%/api/uploads/%'`); } catch {}
// Migrate: notes.content_pinyin (拼音搜索支持: 全拼 + 首字母拼接串,搜索时 LIKE %query% 命中)
try { sqlite.exec('ALTER TABLE notes ADD COLUMN content_pinyin TEXT'); } catch {}
// 一次性回填 + 升级重算: PINYIN_SCHEMA_VERSION 每次 toPinyinSearchable 算法升级时 +1,
// 启动检测 config 表里存的版本号,低于当前版本就把所有 content_pinyin 清空让下面回填重算。
// v1: 全拼 + 单读音首字母. v2: 多音字首字母穷举. v3: 多音字只取前 2 读音. v4: 加罕用读音黑名单.
// v5: 弃用多音字穷举,只用 pinyin-pro 默认读音 —— 牺牲"重做"搜 cxcz 换全局零误命中(蘑菇的决策)
const PINYIN_SCHEMA_VERSION = 5;
try {
  const row = sqlite.prepare("SELECT value FROM config WHERE key = 'pinyin_schema_version'").get() as { value: string } | undefined;
  const curVer = row ? Number(JSON.parse(row.value)) : 0;
  if (curVer < PINYIN_SCHEMA_VERSION) {
    sqlite.prepare("UPDATE notes SET content_pinyin = NULL").run();
    console.log(`[pinyin migration] schema v${curVer} → v${PINYIN_SCHEMA_VERSION}, forcing full re-backfill`);
  }
  const pending = sqlite.prepare('SELECT id, content FROM notes WHERE content_pinyin IS NULL').all() as Array<{ id: string; content: string }>;
  if (pending.length > 0) {
    const upd = sqlite.prepare('UPDATE notes SET content_pinyin = ? WHERE id = ?');
    const tx = sqlite.transaction((rows: typeof pending) => {
      for (const r of rows) upd.run(toPinyinSearchable(r.content), r.id);
    });
    tx(pending);
    console.log(`[pinyin migration] backfilled ${pending.length} notes`);
  }
  sqlite.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run('pinyin_schema_version', JSON.stringify(PINYIN_SCHEMA_VERSION));
} catch (e) { console.error('[pinyin migration] failed:', e); }

export { schema };
