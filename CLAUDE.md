# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Quink (一念) is a personal note-taking app with AI-powered auto-tagging, classification, and writing assistance. It consists of three packages in a pnpm monorepo:

- **packages/server** — Hono + SQLite (better-sqlite3) + Drizzle ORM backend API
- **packages/web** — Vue 3 + Vite + TailwindCSS + Vditor (Markdown editor) frontend
- **packages/desktop** — Electron desktop shell (main window loads web URL, capture popup via global hotkey)

## Development Commands

```bash
# Start backend (port 38999)
pnpm run dev:server

# Start frontend (port 24888)
pnpm run dev:web

# Start desktop (requires backend + frontend running)
cd packages/desktop && npx tsc && npx electron .

# All three at once (or use start.bat on Windows)
pnpm run dev:server & pnpm run dev:web
# then in another terminal: cd packages/desktop && npx tsc && npx electron .
```

The frontend proxies `/api` requests to the backend via Vite config. Electron's main window loads `http://localhost:24888`.

## Architecture

### Data Flow
```
User → Vditor (Markdown) → API (Hono) → SQLite
                                      → AI (async: auto-tag, classify, summarize)
```

Notes are stored as **Markdown** (not HTML). The Vditor editor works natively with Markdown. NoteCard renders Markdown→HTML via `Vditor.md2html()`.

### Auth
- JWT tokens (long-lived, no expiry). Token stored in `localStorage` as `quink_token`.
- `authMiddleware` in `server/src/auth.ts` validates Bearer tokens on all protected routes.
- Login/register endpoints at `/api/auth/*` are unprotected.
- Username is case-insensitive (stored lowercase).

### AI System
- **Multi-config**: Users create named AI configs (provider/url/key/model) in `ai_configs` table.
- **Per-feature binding**: Each AI feature (auto_tag, auto_classify, polish, expand, write, chat) binds to a config via `preferences.aiBindings`.
- **Prompts**: Default prompts in `server/src/ai/prompts.ts`, user overrides in `ai_prompts` table.
- **Auto-processing**: After note creation, `processNoteWithAi()` runs async (non-blocking) to generate tags, category, and summary.
- **AI client** (`server/src/ai/client.ts`): Unified caller for OpenAI/Anthropic/Ollama with smart URL auto-detection.

### Theme System
CSS variables in `style.css` define 7 themes (blueberry, lavender, mint, peach, lemon, cloud, dark). Switched via `data-theme` attribute on `<html>`. Tailwind colors reference these variables:
- `primary` / `primary-light` / `primary-dark` → `--c-accent*`
- `sidebar` / `sidebar-light` → `--c-sidebar*`
- Sidebar text colors → `--sb-text`, `--sb-dim`, `--sb-hover`, etc.

### Electron
- **Main window**: Loads web frontend URL, no menu bar (`Menu.setApplicationMenu(null)`).
- **Capture window**: Loads `/capture` route, frameless, always-on-top, Shift+Space hotkey.
- **Global shortcuts**: Via `uiohook-napi` (low-level keyboard hooks, supports Shift+Space which Electron's `globalShortcut` can't register).
- **Token sync**: Main window sends token to Electron main process via `preload-main.ts` IPC, used for capture window API calls.

### Mobile
- Responsive via Tailwind `md:` breakpoint (768px).
- Small screens: sidebar becomes drawer, search collapses to icon, `MobileInput` (textarea) replaces Vditor.
- `100dvh` + JS `--app-height` for iOS Safari viewport handling.

### Database
SQLite with auto-migration on startup (`db/index.ts` runs CREATE TABLE IF NOT EXISTS + ALTER TABLE try-catch). Schema in `db/schema.ts` (Drizzle ORM). Key tables: `users`, `notes` (with `deleted_at` for soft delete), `categories`, `files`, `ai_configs`, `ai_prompts`.

### Vditor
Static files served from `packages/web/public/vditor/dist/` (copied from node_modules). CDN config in RichEditor.vue points to `/vditor`. After `pnpm install`, run: `cp -r node_modules/vditor/dist packages/web/public/vditor/dist`

## Key Conventions

- All UI text in Chinese.
- `spellcheck="false"` on `<body>` globally — no red wavy underlines anywhere.
- All input colors use CSS theme variables, never hardcoded hex (use `rgb(var(--c-accent))` pattern).
- Notes content is Markdown. AI returns Markdown. No HTML↔MD conversion needed.
- Soft delete for notes (`deleted_at` field), auto-purge after 30 days.
- Ports: backend 38999, frontend 24888. These are configured in `vite.config.ts` and `server/src/index.ts`.

## Coding Standards

### Naming
| 场景 | 规范 | 示例 |
|------|------|------|
| 数据库列名 | snake_case | `user_id`, `created_at`, `todo_status` |
| TypeScript 变量/函数 | camelCase | `userId`, `sendMessage`, `currentConvId` |
| TypeScript 类型/接口 | PascalCase | `Note`, `AiConfig`, `ChatMessage` |
| Vue 组件文件 | PascalCase | `NoteCard.vue`, `TopBar.vue` |
| CSS 类名 | kebab-case | `note-content`, `voice-bubble` |
| 常量 | UPPER_SNAKE_CASE | `DEFAULT_PROMPTS`, `TOOL_DEFINITIONS` |
| API JSON 响应字段 | camelCase | `{ userId, createdAt, todoStatus }` |

### Database Queries
- **必须使用 Drizzle ORM 查询**，禁止使用 `db.all(sql\`...\`)` 等原始 SQL 返回数据给客户端（ORM 自动处理 snake_case → camelCase 映射）。
- 原始 SQL 仅限内部统计/迁移等不直接返回给前端的场景。如必须使用，需给列加 `AS camelCase` 别名。

## File Upload
Upload endpoint at `/api/upload/file`, static serving at `/api/uploads/*`. Files stored in `packages/server/uploads/` and tracked in `files` table. Max 20MB. Avatar upload at `/api/upload/avatar` (2MB limit).
