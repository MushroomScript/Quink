# packages/server CLAUDE.md

Quink 后端专属指引（Hono + SQLite + Drizzle ORM）。

## 认证

- JWT token（长期有效，无过期时间）。Token 存在 `localStorage` 的 `quink_token` 字段。
- `src/auth.ts` 的 `authMiddleware` 校验所有受保护路由的 Bearer token。
- `/api/auth/*` 登录/注册接口无需认证。
- 用户名不区分大小写（存储为小写）。

## 数据库

SQLite + 启动时自动迁移（`db/index.ts` 中 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` 包 try-catch）。Schema 在 `db/schema.ts`（Drizzle ORM）。核心表：`users`、`notes`（含软删除 `deleted_at`）、`categories`、`files`（含 `filename_history` JSON 数组累积历史名）、`ai_configs`、`ai_prompts`、`ai_conversations`、`ai_messages`、`voice_transcriptions`。

### 查询约定

- **必须使用 Drizzle ORM 查询**，禁止使用 `db.all(sql\`...\`)` 等原始 SQL 返回数据给客户端（ORM 自动处理 snake_case → camelCase 映射）。
- 原始 SQL 仅限内部统计/迁移等不直接返回给前端的场景。如必须使用，需给列加 `AS camelCase` 别名。

## AI 系统

- **多配置**：用户在 `ai_configs` 表创建命名的 AI 配置（provider/url/key/model）。
- **按功能绑定**：每个 AI 功能（auto_tag、auto_classify、auto_summary、polish、expand、write、chat）通过 `preferences.aiBindings` 绑定到具体配置。
- **提示词**：默认提示词在 `src/ai/prompts.ts`，用户自定义存在 `ai_prompts` 表。
- **AI 对话（v2）**：已重构为 Function Calling 模式。后端定义 10 个工具（`src/ai/tools.ts`），AI 自己决定调用哪个。支持原生 FC + 提示词降级两种模式。流式输出走 SSE。
- **思考模型**：支持 `<think>...</think>` 标签解析（DeepSeek-R1、QwQ 等），前端折叠展示。
- **自动处理**：创建笔记后异步触发 `processNoteWithAi()`（不阻塞）。3 个并发任务（tag / category / summary）各有独立开关 `prefs.autoTag` / `prefs.autoCategorize` / `prefs.autoSummary`，开关字段缺省视作 true（向后兼容）。summary 额外受 `prefs.autoSummaryMinLen` 阈值控制（纯文本长度 < 阈值不生成，过滤图片/附件 markdown 后算）。
- **自动分类的 `{categories}` 占位约定（2026-05-29 重写）**：`auto_classify` prompt 用 `{categories}` 占位符注入"用户当前分类列表"（`autoClassify` 在 `client.ts` 查 categories 表填）。AI 必须从列表里选，**后端校验 AI 返回值必须在列表内，否则强制 null**（防 AI 编造新分类）。注册时通过 `auth.ts` seed `DEFAULT_CATEGORIES`（工作 / 学习 / 生活 / 其他，"其他"是 AI 兜底）。**`processNoteWithAi` 不再"AI 返回新分类自动 insert"**——categories 表只在注册 seed / 用户手动新增时增长。老用户（0 分类）`autoClassify` 直接返回 null（不补 seed）。改自动分类行为先动 `prompts.ts` 的 `auto_classify` prompt + `client.ts` 的 `autoClassify` 校验逻辑。
- **AI 客户端**（`src/ai/client.ts`）：统一调用 OpenAI/Anthropic/Ollama，自动识别 URL 格式。
- **弱模型 / 量化模型适配**：本地 Ollama 上 qwen2.5-coder q4 这类小模型对 OpenAI Function Calling 协议支持差，第一轮 native FC 经常返回空 `tool_calls` + 直接编内容（"买菜/完成报告"这种训练样本）。`callAiWithToolLoop` 在 round 0 检测到 `toolCalls.length === 0 && !content.includes('<tool>')` 时强制降级到提示词模式重试，把 `TOOLS_PROMPT` 拼进 system 引导输出 `<tool>...</tool>`。
- **弱模型不会数数**：列表类工具（如 `get_todos`）必须在返回字符串开头直接拼好数量（"共 X 条（已完成 Y / 未完成 Z）："），不要指望 AI 自己 count。chat prompt 也明说"数量直接读开头那行，别重新数"。
- **chat prompt 三大块**：`prompts.ts` 的 chat 段定义了【强制规则】（询问待办/笔记/标签必须先调工具）、【工具返回的笔记数据格式】（ID/refId 不发给用户、引用 label 怎么读）、【汇总/分析处理方式】（置顶要标⭐、临近截止要提醒、末尾给观察）。改 chat 行为先动这里。
- **引用 label 透传给 AI**：`tools.ts` 的 `cleanContent` 把笔记里的引用块 `[label](?ref=xxx)` 转成 `「label」(refId:xxx)`，AI 直接看到被引笔记 ID，可调 `get_note(id=xxx)` 拿详情；prompt 里 refId 禁止发给用户。`search_notes` 同时 OR 搜 content + summary + tags，避免 label 只在 summary/tags 时漏检。

## 文件上传

- 上传接口 `/api/upload/file`，静态服务 `/api/uploads/*`。文件存在 `packages/server/uploads/` 并在 `files` 表登记。最大 100MB。头像上传接口 `/api/upload/avatar`（2MB 限制）。
- **磁盘真实文件名 vs DB display name 分离**：`buildUniqueFilename(safeName, ext)` 函数（`routes/upload.ts`）拼"日期前缀 + safeName + 防重名 counter"作为磁盘文件名（`2026-05-30_xxx_语音备忘_2.m4a`）。`/file` 调用方自己 `sanitizeName(rawName)` + 组装 `displayFilename = ${safe}.${ext}` 存 DB `files.filename`（如 `语音备忘.m4a`）。`/avatar` 不进 DB 不组装 displayFilename。前端看到的 + markdown link label 用 displayName。url 永远指向磁盘真实名，重命名 displayName 不影响 url。
- **url 字段裸名约定**：DB `files.url` 字段 + 笔记 `content` 里 markdown link 的 url 都只存裸文件名（如 `xxx.png`），不带 `/api/uploads/` 前缀，前端渲染层拼前缀（详见 `packages/web/CLAUDE.md` 的"文件 url helper"段）。新格式（裸名）和老格式（带前缀）都要兼容——DB 启动时一次性 `REPLACE` 迁移过；后端接收 url 做 disk path resolve 时也要兼容剥前缀（如 `ai-config.ts` transcribe-async：`audioUrl.replace(/^\/api\/uploads\//, '').replace(/^uploads\//, '')`）。
- **缩略图自动生成（sharp / libheif）**：上传图片时同步生成 `<裸名>.thumb.jpg`（长边 600 / jpeg 80 / EXIF 旋转），用于头像 / 资源缩略图 / 笔记小图显示，缓解大图一步 CSS downsample 的锐化感。两条路径同命名约定（共用 `xxx.ext.thumb.jpg`，路径不冲突）：
    - **普通图片**（jpg/png/webp/gif）：`utils/imageThumb.ts` 的 `generateImageThumb` 用 sharp。`/avatar` + `/file` 写盘后都同步 await（sharp 处理 < 500ms，单次上传可接受），失败 swallow + console.warn 不影响响应。判断走 `isThumbableImage(filename)`（含 `.thumb.` 自身的跳过防递归）
    - **HEIC**：`utils/heicThumb.ts` 的 `generateHeicThumb` 用 libheif-js（wasm-bundle）+ jpeg-js，纯 JS / WASM 不依赖系统 libvips，参见 `heicThumb.ts` 头部注释
    - 历史文件没 thumb → 前端 `<img @error>` 一次性降级原图（fileUrl helper 提供）。**不在 server 启动时全量 backfill**，避免卡启动；HEIC 例外（已有 `backfillHeicThumbs`）
    - 加新调用点（新上传接口 / 新文件类型）参照现有 isThumbableImage + try/await 模式. 改 sharp 行为或长边阈值修 `imageThumb.ts` 顶部常量

## 文件重命名

- `PATCH /api/upload/files/:id` 只改 DB `filename`（display name），磁盘真实文件名 + url 不动，避免历史笔记 link 失效。
- 同时扫该用户所有笔记 content，把 `[label](url)` 里 label === 历史曾用过的文件名（`filename_history` JSON 数组累积，每次重命名追加旧名）的同步改成新名；用户自定义过 label 的（如把 "xxx.m4a" 改成 "今天会议录音"）保留不动尊重写作意图。
- **markdown 文本无法 100% 区分"系统插入 label" vs "用户故意写了一样的 label"** —— 当前用 historyNames 做近似（label 在历史名集合内就同步），边界 case（用户故意写了跟文件名一样的 label）无法消除，接受。
