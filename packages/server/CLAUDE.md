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

## 待办提醒系统

`src/reminder/` 独立模块. 完整链路: scheduler 每分钟扫表 → 命中 `todoDue <= now` 待办 → sender dispatch 到所有 enabled `reminder_channels` → 8 个 adapter (browser / email / bark / wecom_bot / dingtalk_bot / feishu_bot / telegram / webhook) 各自实现 `send(ctx)` 接口.

- **DB schema**: `notes` 复用 `todo_due` 当提醒时间(ISO datetime), 新加 `todo_remind_sent_at` (防重发) + `todo_remind_rrule` (RFC 5545 RRULE 简短形式, **不含 DTSTART**, scheduler 用 `lastFire = todoDue` 当 dtstart 锚点)
- **RRULE 库**: `rrule` 2.8.1 是 UMD/webpack 打包, Node ESM 走 cjs interop 时**只能 default import + 解构** —— `import rrulePkg from 'rrule'; const { RRule } = rrulePkg;`. 类型用 `import type { RRule as RRuleType } from 'rrule'` 分开. 直接 named import 报 `does not provide an export named 'RRule'`. 详见 `scheduler.ts:4-7` inline 注释
- **SSE 长连接** (`/api/sse?token=...`): EventSource 不能传 Authorization header → 走 query token (跟 JWT 共用同一 token). **SSE 路由必须 IIFE 模式**: `return new Response(readable)` 之前不能 `await write`, 否则 `@hono/node-server` 不立即返回响应头, 客户端 EventSource 一直 `CONNECTING` 不进 `OPEN`
- **SSE 两类事件**: ① `reminder` — browser adapter 触发, 前端 `quinkDesktop.showNotification` IPC → Electron `Notification` 弹 OS 通知; ② `note-updated` — scheduler 在 dispatch + DB 更新完成后 publish, 前端 `store.refreshSingleNote(id)` → `Object.assign` 字段保引用, 卡片自动反映 `sentAt`/`todoDue` 变化, **无需手动按刷新按钮**
- **cleanup 时用 `writer.abort()` 不用 `writer.close()`**: Node 22 WritableStream 在对端已 cancel 时调 `writer.close()` 同步抛 `ERR_INVALID_STATE.TypeError`, 不被 try/catch 拦截让 IIFE 顶层抛错崩 Node 进程. `abort()` 不抛错, 跨状态安全
- **测试发送** (`POST /api/reminder-channels/:id/test`): 用 `dispatchToSingleChannel` 跑同条 adapter, 失败抛 Error 含具体原因(config 缺字段 / token 无效等), Settings 测试按钮直接展示给用户
- **加新 channel adapter**: ① `adapters/<name>.ts` 实现 `AdapterFn` (接 ctx, 用 ctx.config + ctx.payload + fetch/sdk) → ② `sender.ts` adapters 表加映射 → ③ `schema.ts` reminderChannels type enum 加新值 → ④ `db/index.ts` 不用动 (type 是 string, enum 仅 Drizzle 类型层级) → ⑤ 前端 `Settings.vue` `channelTypeOptions` + `channelTypeFields` 加配置字段定义
- **browser 通道唯一性**: 同一 user 只能有一条 `type='browser'` channel. `POST /reminder-channels` 服务端拦截 + 前端 `<select>` UI disable 已有 browser 时的选项. 多条 browser 会让同一 SSE 推送的事件触发 OS 弹通知 N 次

## 文件重命名

- `PATCH /api/upload/files/:id` 只改 DB `filename`（display name），磁盘真实文件名 + url 不动，避免历史笔记 link 失效。
- 同时扫该用户所有笔记 content，把 `[label](url)` 里 label === 历史曾用过的文件名（`filename_history` JSON 数组累积，每次重命名追加旧名）的同步改成新名；用户自定义过 label 的（如把 "xxx.m4a" 改成 "今天会议录音"）保留不动尊重写作意图。
- **markdown 文本无法 100% 区分"系统插入 label" vs "用户故意写了一样的 label"** —— 当前用 historyNames 做近似（label 在历史名集合内就同步），边界 case（用户故意写了跟文件名一样的 label）无法消除，接受。

## 群组共享编辑锁 (PR #5)

仅 `visibility='shared'` 笔记走锁逻辑, `private` 笔记不走 (单人直接编辑, 无需协作). 锁本质: 抢占式 + 自动释放 + 乐观锁兜底.

- **DB schema 4 列** (`notes` 表加): `edit_lock_by` (持锁用户 id) + `edit_lock_token` (nanoid 16, PATCH 时校验, 防同用户多设备脏写) + `edit_lock_expires_at` (ISO datetime, 5min TTL) + `version` (乐观锁, 默认 1, 每次 PATCH 成功自增, server 重启等极端 case 锁失效时拒绝旧版本提交)
- **4 个 API** (`routes/notes.ts`):
  - `POST /:id/lock` —— 申请: 别人持锁未过期 → 409 + `{lockByNickname, expiresAt}`; 拿到 → 返回 `{lockToken, expiresAt}`. 自己续锁 / 抢空闲锁 / 抢过期锁都重发新 token (旧 token 自动失效)
  - `POST /:id/lock/heartbeat` —— 续约: 前端 setInterval 30s 调, body 带 `lockToken`. 失败 (lock_invalid / lock_expired) 返 409 让前端提示用户重新打开
  - `DELETE /:id/lock` —— 释放: 前端 onBeforeUnmount + `fetch keepalive` 调. 非持锁人调静默 OK (不报错避免页面卸载时控制台噪音)
  - `PATCH /:id` —— shared 笔记必须带 `lockToken` + `version` 校验, 成功后 `version++` + 自动清锁 (PATCH = 提交完成, 锁释放给下一位); private 保持原行为 (作者直接改无需锁)
- **`getNoteForAccess(userId, noteId)` helper**: 校验 userId 能否访问 noteId. 作者本人放行; 否则 visibility='shared' + 我是 `note_shares ∩ my_active_groups` 才放行. 所有 lock API + PATCH 都用这函数 (后续 GET `/:id` 重构时也会切到这个 helper)
- **权限模型**: 所有群 active member 都能编辑共享笔记 (作者/admin/member 平权, 但 visibility / sharedGroupIds 改分享设置仅作者控). chat 工具 `update_note` 同款扩 (`packages/server/src/ai/tools.ts`)
- **fetch keepalive 替代 sendBeacon**: roadmap 原本写 `sendBeacon`, 但 sendBeacon 只支持 POST 不支持 DELETE. 改用 `fetch(url, { method: 'DELETE', keepalive: true })`, 现代浏览器同款语义 (页面 unload 也能发出), 还能用 DELETE 方法. 见 `NoteEditModal.vue:releaseLockOnUnmount`
- **Cron 60s 清过期锁**: `startEditLockCleanup()` setInterval(60s) 扫 `expires_at < now AND lock_by IS NOT NULL` 的笔记清锁. 兜底 case: 用户没 fetch keepalive (浏览器异常关 / 断电) → 锁自然过期 server 自清. 跟 `startReminderScheduler()` 同款 setInterval 模式. `index.ts` 启动时调一次, tsx 进程重启自然重计时
- **chat 工具 `update_note` 跟 PATCH HTTP 行为分歧**: HTTP PATCH 要求 lockToken (持锁后才能写); chat 工具不走 lock (AI 是单次操作不持锁), 但检查"别人正在持锁" → 拒绝告知用户. version 仍维护 (`+= 1`). 见 `tools.ts:update_note` PR #5 段
