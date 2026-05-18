# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库工作时提供指引。

## 项目概览

Quink（一念）是一款带 AI 自动打标签、自动分类、写作辅助的个人笔记应用。pnpm monorepo，三个 package：

- **packages/server** — Hono + SQLite（better-sqlite3）+ Drizzle ORM 后端 API
- **packages/web** — Vue 3 + Vite + TailwindCSS + Vditor（Markdown 编辑器）前端
- **packages/desktop** — Electron 桌面壳（主窗口加载 web，全局快捷键弹快速记录窗口）

## 开发命令

```bash
# 启动后端（端口 38999）
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

## 图标系统

- **统一用 `@phosphor-icons/vue`**，禁止再用 emoji 当图标、禁止手写 inline SVG。极少数 v-html 字符串里嵌入图标的场景用 inline phosphor SVG path（见 `utils/refLink.ts`）。
- **weight 默认 `fill`**（实心）。两种例外允许局部用 `bold`：
  - 三点菜单（`PhDotsThreeVertical`）— fill 像红绿灯
  - Electron 标题栏 3 按钮（最小化/最大化/关闭）— fill 显得是黑块，bold 更像 Win11 线条按钮
- **size 用 rem 字符串**：`size="1rem"` / `size="0.875rem"`（=14px @ 16px html font-size）。**禁止用数字 px**（`:size="14"`），因为图标不会跟着用户的字体大小设置（设置 → 字体）缩放。
  - 数字 px 到 rem 的换算就是 N / 16
- **v-html 内嵌图标**：组件 `<PhXxx />` 不能用在 v-html 渲染的字符串里（Vue 不解析字符串里的组件标签）。必须直接写 inline SVG 字符串。SVG 必须加 `pointer-events: none`（否则会拦截父元素的 click 事件，导致 closest('.xxx') 失败）。`utils/refLink.ts` 是引用块的范例。

## 渲染坑

- **`html.replace(regex, '<mark>$1</mark>')` 这种字符串级别的搜索高亮会破坏 HTML 属性**（比如 `<a href="x.mp3">` 里的 mp3 被替换 → CSS 选择器 `a[href$=".mp3"]` 不匹配 → 音频胶囊样式失效）。正确做法：用 `(<[^>]+>)|([^<]+)` regex 拆"标签 vs 文本"，只在文本上替换。范例：`NoteCard.vue` 的搜索高亮。AI.vue 用 TreeWalker + range.surroundContents，天然安全。
- **下拉/popover 在编辑器旁边总被盖住**：编辑器（Vditor 等）经常创建 stacking context，子组件的 z-[9999] 不起作用。解决方案：**默认走 `<Teleport to="body">` + `position: fixed` + 动态算位置**。范例：TopBar 的标签建议下拉、batchMove 下拉。
- **圆角裁切 + absolute 定位锚点不要混在同一个 div 上**：父级 `overflow-hidden` 会裁掉绝对定位的子下拉。修法：外层套一个仅做 `relative` 的容器，内层做 `overflow-hidden` 圆角裁切。
- **markdown 内嵌 emoji + 渲染端 regex 自动加 emoji = 双图标 bug**：写入端就别塞 emoji，渲染端用 `replace(/^📌\s*/, '')` 剥老数据的前缀。范例：`utils/refLink.ts`。
- **Windows bat 文件编码**：永远用 PowerShell `[System.IO.File]::WriteAllBytes` 写 **GBK + CRLF** 的 bat 文件，**不要**用 Write 工具（UTF-8 + LF），cmd 默认 cp936 会把 UTF-8 中文字节当命令分隔符乱读。`chcp 65001` 救不了，因为 cmd 逐行读，那一行本身就被拆了。

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
