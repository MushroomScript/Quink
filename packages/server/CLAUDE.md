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

AI 系统专属指引（多配置 / 按功能绑定 / FC v2 / 自动处理 / 自动分类 `{categories}` 占位 / 弱模型适配 / chat prompt 三大块 / 引用 label 透传）已挪到 `src/ai/CLAUDE.md`，在该子目录工作时自动加载。改 server 顶层接口里间接调用 AI 流程（如 `processNoteWithAi`）时按需主动 read。

## 文件上传

- 上传接口 `/api/upload/file`，静态服务 `/api/uploads/*`。文件存在 `packages/server/uploads/` 并在 `files` 表登记。最大 100MB。头像上传接口 `/api/upload/avatar`（2MB 限制）。
- **磁盘真实文件名 vs DB display name 分离**：`buildUniqueFilename(safeName, ext)` 函数（`routes/upload.ts`）拼"日期前缀 + safeName + 防重名 counter"作为磁盘文件名（`2026-05-30_xxx_语音备忘_2.m4a`）。`/file` 调用方自己 `sanitizeName(rawName)` + 组装 `displayFilename = ${safe}.${ext}` 存 DB `files.filename`（如 `语音备忘.m4a`）。`/avatar` 不进 DB 不组装 displayFilename。前端看到的 + markdown link label 用 displayName。url 永远指向磁盘真实名，重命名 displayName 不影响 url。
- **url 字段裸名约定**：DB `files.url` 字段 + 笔记 `content` 里 markdown link 的 url 都只存裸文件名（如 `xxx.png`），不带 `/api/uploads/` 前缀，前端渲染层拼前缀（详见 `packages/web/CLAUDE.md` 的"文件 url helper"段）。新格式（裸名）和老格式（带前缀）都要兼容——DB 启动时一次性 `REPLACE` 迁移过；后端接收 url 做 disk path resolve 时也要兼容剥前缀（如 `ai-config.ts` transcribe-async：`audioUrl.replace(/^\/api\/uploads\//, '').replace(/^uploads\//, '')`）。
- **缩略图自动生成**：上传图片时同步生成 `<裸名>.thumb.jpg`（sharp 处理普通图片 / libheif 处理 HEIC），前端 `<img>` 用 thumb URL 显示，onError 降级原图。详见根 **`THUMBNAILS.md`**

## 文件重命名

- `PATCH /api/upload/files/:id` 只改 DB `filename`（display name），磁盘真实文件名 + url 不动，避免历史笔记 link 失效。
- 同时扫该用户所有笔记 content，把 `[label](url)` 里 label === 历史曾用过的文件名（`filename_history` JSON 数组累积，每次重命名追加旧名）的同步改成新名；用户自定义过 label 的（如把 "xxx.m4a" 改成 "今天会议录音"）保留不动尊重写作意图。
- **markdown 文本无法 100% 区分"系统插入 label" vs "用户故意写了一样的 label"** —— 当前用 historyNames 做近似（label 在历史名集合内就同步），边界 case（用户故意写了跟文件名一样的 label）无法消除，接受。
