# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库工作时提供指引。

## CLAUDE.md 维护规则

仓库里有多个分层文件，按以下规则维护，避免根目录膨胀：

- **根 `CLAUDE.md`**：跨包通用、全局约定、多文件共享的高频经验（命名规范、UI 交互、跨 view 的动画通用知识、渲染坑等）。Claude Code 启动时自动加载
- **子目录 `CLAUDE.md`**：只该目录或少数关联文件用到的专属内容。Claude 在该目录工作时自动加载
- **同一主题规则数量大、自成体系** → 拆到独立 `CLAUDE.md`（推荐放对应代码目录），根目录留一行指针
- **使用频率低的规则**（如图标系统：写完后改动少）→ 拆到根目录普通 `.md` 文件（**不带 CLAUDE 前缀**），不自动加载，根 `CLAUDE.md` 留指针让 Claude 在需要时主动读。代价是 Claude 需要根 `CLAUDE.md` 的提示才知道去读 → 好处是启动时不占 context

**当前文件清单：**
- 根 `CLAUDE.md`（本文件）— 全局指引、高频规则
- 根 `ICONS.md` — 图标系统约定（不自动加载，改图标时来读）
- 根 `RENDERING-PITFALLS.md` — 渲染相关坑（DOM / CSS / Vue / HMR / markdown / Vditor / 动画 / 鼠标事件，不自动加载，改 UI / markdown / 编辑器 / 列表动画时来读）
- `packages/desktop/CLAUDE.md` — Electron 主进程坑（OS 窗口动画、快捷窗口防闪烁、IPC 契约等）
- `packages/web/src/utils/CLAUDE.md` — 卡片列表 leave 动画体系（`cardLeave.ts` + TransitionGroup 多个坑）
- `packages/web/src/composables/CLAUDE.md` — 瀑布流 + 无限滚动体系（`useMasonry` + `useInfiniteScroll`），含 column-count / computed-vs-ref / v-if-loading-unmount / scrollTop 调试 等坑

**新增规则时的判断流程：**
1. **多文件高频用** → 根 `CLAUDE.md`
2. **少数文件专属** → 对应子目录 `CLAUDE.md`
3. **同一主题积累 ~10 行以上** → 考虑独立成 `CLAUDE.md`
4. **写完后改动少 / 低频** → 根目录普通 `.md` 文件，根 `CLAUDE.md` 留指针

## 项目概览

Quink（一念）是一款带 AI 自动打标签、自动分类、写作辅助的个人笔记应用。pnpm monorepo，三个 package：

- **packages/server** — Hono + SQLite（better-sqlite3）+ Drizzle ORM 后端 API
- **packages/web** — Vue 3 + Vite + TailwindCSS + Vditor（Markdown 编辑器）前端
- **packages/desktop** — Electron 桌面壳（主窗口加载 web，全局快捷键弹快速记录窗口）

## 开发命令

```bash
# 启动后端（端口 38999，tsx watch，改代码自动重启）
pnpm run dev:server

# 启动前端（端口 24888）
pnpm run dev:web

# 启动桌面端（编译 desktop ts + 起 electron；走 pnpm filter 才能正确解析根目录的 electron）
pnpm run dev:desktop
```

**Windows 一键启动（推荐）：**
- 双击 `start-server.bat` — 起后端，单独窗口可见日志
- 双击 `start-desktop.bat` — 检查后端 → 起 Vite（24888，最小化窗口） → 编译 desktop → 启 Electron

**坑提醒**：不要写 `cd packages/desktop && npx electron .` —— `electron` 被 pnpm hoist 到根 `node_modules`，npx 在子包目录找不到会触发**现下载**（慢/卡）。永远用 `pnpm --filter @quink/desktop` 或根 `pnpm run dev:desktop`。

前端通过 Vite 配置将 `/api` 请求代理到后端。Electron 主窗口加载 `http://localhost:24888`。

## 架构

### 数据流
```
用户 → Vditor（Markdown）→ API（Hono）→ SQLite
                                      → AI（异步：自动标签/分类/摘要）
```

笔记以 **Markdown** 存储（非 HTML）。Vditor 编辑器原生支持 Markdown。NoteCard 通过 `Vditor.md2html()` 渲染 Markdown → HTML。

### 认证
- JWT token（长期有效，无过期时间）。Token 存在 `localStorage` 的 `quink_token` 字段。
- `server/src/auth.ts` 的 `authMiddleware` 校验所有受保护路由的 Bearer token。
- `/api/auth/*` 登录/注册接口无需认证。
- 用户名不区分大小写（存储为小写）。

### AI 系统
- **多配置**：用户在 `ai_configs` 表创建命名的 AI 配置（provider/url/key/model）。
- **按功能绑定**：每个 AI 功能（auto_tag、auto_classify、polish、expand、write、chat）通过 `preferences.aiBindings` 绑定到具体配置。
- **提示词**：默认提示词在 `server/src/ai/prompts.ts`，用户自定义存在 `ai_prompts` 表。
- **AI 对话（v2）**：已重构为 Function Calling 模式。后端定义 10 个工具（`server/src/ai/tools.ts`），AI 自己决定调用哪个。支持原生 FC + 提示词降级两种模式。流式输出走 SSE。
- **思考模型**：支持 `<think>...</think>` 标签解析（DeepSeek-R1、QwQ 等），前端折叠展示。
- **自动处理**：创建笔记后异步触发 `processNoteWithAi()`（不阻塞）生成标签、分类、摘要。
- **AI 客户端**（`server/src/ai/client.ts`）：统一调用 OpenAI/Anthropic/Ollama，自动识别 URL 格式。
- **弱模型 / 量化模型适配**：本地 Ollama 上 qwen2.5-coder q4 这类小模型对 OpenAI Function Calling 协议支持差，第一轮 native FC 经常返回空 `tool_calls` + 直接编内容（"买菜/完成报告"这种训练样本）。`callAiWithToolLoop` 在 round 0 检测到 `toolCalls.length === 0 && !content.includes('<tool>')` 时强制降级到提示词模式重试，把 `TOOLS_PROMPT` 拼进 system 引导输出 `<tool>...</tool>`。
- **弱模型不会数数**：列表类工具（如 `get_todos`）必须在返回字符串开头直接拼好数量（"共 X 条（已完成 Y / 未完成 Z）："），不要指望 AI 自己 count。chat prompt 也明说"数量直接读开头那行，别重新数"。
- **chat prompt 三大块**：`prompts.ts` 的 chat 段定义了【强制规则】（询问待办/笔记/标签必须先调工具）、【工具返回的笔记数据格式】（ID/refId 不发给用户、引用 label 怎么读）、【汇总/分析处理方式】（置顶要标⭐、临近截止要提醒、末尾给观察）。改 chat 行为先动这里。
- **引用 label 透传给 AI**：`tools.ts` 的 `cleanContent` 把笔记里的引用块 `[label](?ref=xxx)` 转成 `「label」(refId:xxx)`，AI 直接看到被引笔记 ID，可调 `get_note(id=xxx)` 拿详情；prompt 里 refId 禁止发给用户。`search_notes` 同时 OR 搜 content + summary + tags，避免 label 只在 summary/tags 时漏检。

### 主题系统
`style.css` 中的 CSS 变量定义了 7 套主题（blueberry、lavender、mint、peach、lemon、cloud、dark）。通过 `<html>` 上的 `data-theme` 属性切换。Tailwind 颜色引用这些变量：
- `primary` / `primary-light` / `primary-dark` → `--c-accent*`
- `sidebar` / `sidebar-light` → `--c-sidebar*`
- 侧边栏文字色 → `--sb-text`、`--sb-dim`、`--sb-hover` 等
- 暗色主题需为每个使用硬编码颜色的地方加 `[data-theme="dark"]` 覆盖

### Electron
- **主窗口**：加载前端 URL，无菜单栏（`Menu.setApplicationMenu(null)`）。
- **快速记录窗**：加载 `/capture` 路由，无边框，置顶，Shift+Space 触发。
- **全局快捷键**：通过 `uiohook-napi`（低级键盘钩子，支持 Electron 的 `globalShortcut` 无法注册的 Shift+Space）。
- **Token 同步**：主窗口通过 `preload-main.ts` IPC 把 token 发给 Electron 主进程，供快速记录窗调用 API。

### 移动端
- 通过 Tailwind `md:` 断点（768px）做响应式。
- 小屏：侧边栏改抽屉，搜索折叠成图标，`MobileInput`（textarea）替换 Vditor。
- `100dvh` + JS `--app-height` 处理 iOS Safari 视口。

### 数据库
SQLite + 启动时自动迁移（`db/index.ts` 中 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` 包 try-catch）。Schema 在 `db/schema.ts`（Drizzle ORM）。核心表：`users`、`notes`（含软删除 `deleted_at`）、`categories`、`files`、`ai_configs`、`ai_prompts`、`ai_conversations`、`ai_messages`、`voice_transcriptions`。

### 笔记类型（type 字段）
- schema 定义 4 个值：`note / todo / snippet / link`（看 `db/schema.ts`）
- 前端 sidebar 主导航只有 3 个对应 view，**type 到 view 的映射不直观**：
  - `/` 灵感（`Inspiration.vue`）→ `filterType='note'`
  - `/notes` 笔记（`Notes.vue`）→ `filterType='snippet'`（**不是 `note`**）
  - `/todos` 待办（`Todos.vue`）→ `filterType='todo'`
  - `type='link'` **无专属 view 入口**，创建后只能通过搜索或 AI 工具调用查到（设计 quirk，未来补 `/links` 路由 + filterType='link' 才能用）
- 这个映射也写在 `utils/cardLeave.ts` 的 `TYPE_TO_NAV_PATH`（控制回收站恢复时卡片飞向哪个 sidebar 菜单项）。改 type 枚举或加 view 时记得两边都改。

### Vditor
静态文件从 `packages/web/public/vditor/dist/`（从 node_modules 复制）提供。RichEditor.vue 的 CDN 配置指向 `/vditor`。`pnpm install` 后执行：`cp -r node_modules/vditor/dist packages/web/public/vditor/dist`

## 核心约定

- 所有 UI 文案使用中文。
- 全局 `<body>` 加 `spellcheck="false"`，杜绝任何红色波浪线。
- 所有输入框颜色用 CSS 主题变量，禁止硬编码 hex（使用 `rgb(var(--c-accent))` 模式）。
- 笔记内容是 Markdown。AI 返回 Markdown。无需 HTML↔MD 转换。
- 笔记软删除（`deleted_at` 字段），30 天后自动彻底清除。
- 端口：后端 38999，前端 24888。配置在 `vite.config.ts` 和 `server/src/index.ts`。

## UI 交互约定

- **危险操作必须弹窗确认**（删除/清空/永久删除等），禁止在按钮原地切换文字。使用 `confirmXxxId` ref + Teleport 居中弹窗 + 取消/确认双按钮。
- **按钮要有背景色**：主要操作 `bg-primary-light text-primary-dark`，危险操作 `bg-red-50 text-red-500`，hover 加深。
- **数字显示用 `tabular-nums`** 等宽字体类，避免切换页面时数字跳动。
- **暗色主题全适配**：所有硬编码颜色必须在 style.css 加 `[data-theme="dark"]` 覆盖。
- **搜索高亮**统一用全局琥珀色（`#fbbf24` / `#d97706`），柠檬主题例外用紫色（避免黄底黄字）。
- **批量操作用乐观更新**：`恢复所有` / `清空回收站` 等批量 API 调用，**必须先改 UI 触发动画再 await API**。否则若 `Promise.all` 中任一 reject，整个 Promise.all reject → 空 catch 吞掉 → 数据变更（如 `notes.value = []`）不执行 → **动画不触发**。乐观更新代价是 API 失败时 server 数据不一致（UI 已清空 server 还有），下次刷新会自动同步；用 `console.error` 留痕。范例：`Trash.vue` 的 `doRestoreAll` / `doEmptyAll`。

## 图标系统

全软件图标约定（统一用 `@phosphor-icons/vue`、PhXCircle vs PhX、weight/size 规则、v-html 内嵌、视觉中心偏移 nudge 等）—— 详见根目录 **`ICONS.md`**。改图标相关代码（新增图标、调整 size/weight、加 nudge）前先读那里。

## 渲染坑

渲染相关坑（DOM / CSS / Vue 模板 / HMR / markdown 渲染 / Vditor 编辑器 / TransitionGroup 动画 / 拖动鼠标事件）—— 数量多且查阅频率不高，已拆到根目录 **`RENDERING-PITFALLS.md`**。改 UI / markdown 渲染 / 编辑器 / 列表动画相关代码前先去那里查一下。新增渲染坑也加到那里，不要再加回本文件。

## markdown 显示态

笔记 markdown 渲染统一走 "外层 `.note-content` + 内层 `.vditor-reset` 嵌套 v-html" 的结构（**方案 C**），复用 Vditor 编辑器的 CSS 让显示态视觉跟编辑态完全一致。涉及 7 个文件：`NoteCard.vue` / `NoteDetail.vue` / `Trash.vue` / `App.vue`（引用预览）/ `AI.vue` / `AiChat.vue`。详见 `RENDERING-PITFALLS.md` 的"markdown 渲染"段。

## Electron 快捷窗口（Capture / AiChat）

涉及 Win11 OS 窗口动画、主题闪烁 4 层防御、`currentTheme` 缓存同步、持久窗口 vs 销毁重建策略、IPC 契约等坑——这些只有 `packages/desktop/` 主进程 + 少数 web 端文件（`Capture.vue` / `AiChat.vue` / `RichEditor.vue` / `index.html`）会涉及，详见 **`packages/desktop/CLAUDE.md`**。改 desktop 主进程或动这几个 web 文件前先读那里。

## 编码规范

### 命名规范
| 场景 | 规范 | 示例 |
|------|------|------|
| 数据库列名 | snake_case | `user_id`、`created_at`、`todo_status` |
| TypeScript 变量/函数 | camelCase | `userId`、`sendMessage`、`currentConvId` |
| TypeScript 类型/接口 | PascalCase | `Note`、`AiConfig`、`ChatMessage` |
| Vue 组件文件 | PascalCase | `NoteCard.vue`、`TopBar.vue` |
| CSS 类名 | kebab-case | `note-content`、`voice-bubble` |
| 常量 | UPPER_SNAKE_CASE | `DEFAULT_PROMPTS`、`TOOL_DEFINITIONS` |
| API JSON 响应字段 | camelCase | `{ userId, createdAt, todoStatus }` |

### 数据库查询
- **必须使用 Drizzle ORM 查询**，禁止使用 `db.all(sql\`...\`)` 等原始 SQL 返回数据给客户端（ORM 自动处理 snake_case → camelCase 映射）。
- 原始 SQL 仅限内部统计/迁移等不直接返回给前端的场景。如必须使用，需给列加 `AS camelCase` 别名。

## 文件上传
上传接口 `/api/upload/file`，静态服务 `/api/uploads/*`。文件存在 `packages/server/uploads/` 并在 `files` 表登记。最大 20MB。头像上传接口 `/api/upload/avatar`（2MB 限制）。
