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

## 群组共享编辑权限分级 (PR #5b)

PR #5 默认所有群 active member 都能改共享笔记, PR #5b 把默认收紧到"管理员可改" + 加申请编辑权流程. 作者本人永远能改, 不算独立档.

- **DB schema 1 列 + 2 新表**:
  - `notes.edit_permission` (enum: `admin` / `all`, 默认 `admin`) - shared 笔记用, private 忽略
  - `note_edit_grants` (note_id, user_id, granted_at, granted_by) - **永久白名单** (申请通过后写入, 作者/admin 可撤销)
  - `note_edit_requests` (id, note_id, user_id, status, message, created_at, handled_at, handled_by) - 申请记录 4 状态 (pending/approved/rejected/canceled)
- **`getNoteForAccess` 扩 `mode='read'|'write'` 参数**:
  - read: 作者 OR shared + 我是 active 群成员 (PR #5 行为)
  - write: 作者放行; 否则 `editPermission='all'` 任何 active member / `editPermission='admin'` 我在群里是 owner/admin / 在 `note_edit_grants` 白名单内 → 放行
- **`isAdminOfSharedNote(userId, noteId)` helper**: 给"管理操作"用 (DELETE / 审批 / 撤销授权), 比 write 更严格 - 普通成员有 write 权限也不能管. 校验我在共享群里是 owner/admin
- **PATCH / DELETE / lock API / chat update_note 全部用 write mode**:
  - PATCH 没 write 权返 `403 { error: 'no_write_permission', editPermission }` 让前端弹"申请编辑权"按钮
  - DELETE 扩到 admin 可删 (admin 删别人的笔记前端要弹"确认删 @张三 的笔记"对话)
  - lock API 加 write 校验 (没编辑权连锁都拿不到, 避免编辑到一半提交才发现没权)
  - chat update_note 没 write 权返"这条笔记的编辑权限为「仅管理员」, 你没有编辑权" 让 AI 告知用户
- **6 个权限管理 API** (`routes/notes.ts`):
  - `POST /:id/edit-request` 申请 (没 write 权才能调; 已有 pending 申请返原 request, idempotent; SSE 推作者 + 群 admin)
  - `POST /:id/edit-requests/:reqId/approve` 同意 (作者 + 群 admin 都能批; 事务写 `note_edit_grants` + 更新 request 状态)
  - `POST /:id/edit-requests/:reqId/reject` 拒绝
  - `GET /:id/edit-requests` 列所有申请 (含 join users 拿 nickname/avatar)
  - `GET /:id/edit-grants` 列已授权用户
  - `DELETE /:id/edit-grants/:userId` 撤销授权
  - **改 editPermission 走 PATCH /:id 的 `editPermission` 字段** (仅作者改, 跟 visibility / sharedGroupIds 同款约定), 不另加 API
- **SSE 事件**:
  - `note-edit-request` 推作者 + 群 admin (申请人提交时), payload 含 requesterNickname / message
  - `note-edit-request-resolved` 推申请人 (审批后), payload 含 status (approved/rejected)
- **前端 UI 完整**:
  - `NoteCard` 类型 chip 后面加 "已分享" + "管理员可编辑 ⟳"（PhArrowsClockwise 切换图标）单胶囊（点击 toggle admin/all）, **仅作者本人 + shared 笔记 + `route.path.startsWith('/groups/')` 群组上下文**才显示（主 view 不污染）
  - `NoteDetail` 加分享设置行: 「已分享到 X 个群」(popover 展群名) + 「管理员可编辑 ⟳」(同款胶囊) + 「额外授权 X 人」(popover 列已授权用户 + 撤销按钮). `editPermission='all'` 时"额外授权"自动隐藏 (白名单无意义)
  - `GroupDetail` 加"待审编辑申请"section (跨笔记汇总, 折叠 >3 条), 同意按钮直接审批; 申请发起方收 SSE → toast "申请编辑权限" 按钮一键发起
  - `NoteEditModal` 锁失败 toast 区分 409 locked / 403 no_write_permission, 后者 toast action 按钮一键申请
  - `GlobalToast` button 在 error kind 用白字 (避免原 toast-undo-btn 的红字 #FF3B3B 撞红底 bg-red-500)
- **store.updateNote 不同步组件本地 ref**: `groupNotes` (GroupDetail) / `note.value` (NoteDetail) 是组件本地 ref, store 内 vs.notes 同步不到. NoteCard / NoteDetail 切 editPermission 后必须**直接 mutate** `props.note.editPermission` 或 `note.value.editPermission` 让 reactive UI 立刻反映. 否则按钮点击后 toast 提示成功但颜色不切 (经典 bug)
- **作者改自己共享笔记免锁** (PR #5 微调): `PATCH /:id` 内 `if (existing.visibility === 'shared' && !isAuthor)` 才走 lock + version 强制. 锁本意防"群成员协作时撞改", 作者多设备靠 version 乐观锁兜底. 让作者改 editPermission / visibility / sharedGroupIds 等"管理操作"不卡 lock 流程
- **`GET /api/groups/:id/notes` 必须返回 sharedGroupIds + editPermission**: 群内 NoteCard 显示"已分享" chip + "管理员可编辑 ⟳" 胶囊都依赖这两个字段. 原始 SQL 手动 camelCase 映射时不要漏 (bug 实测: 漏了字段后整张胶囊视觉消失)
- **群级汇总 API** (`routes/groups.ts`): `GET /:id/note-edit-requests` 拉该群所有 shared 笔记 pending 申请 (含 noteId + 申请人 + 笔记 preview + 作者 nickname); `GET /:id/note-edit-grants` 拉所有已授权用户. 给群组详情页"编辑申请管理"面板用 (不分页, 假设每群 pending 量不大)
- **Electron 通知 click Win32 SetForegroundWindow lock 防御** (`packages/desktop/src/main.ts`): notification click 不仅 `mainWindow.focus()`, 还要 `setAlwaysOnTop(true)` 临时拉前 + 100ms 后 `setAlwaysOnTop(false)`. 单纯 focus() 在 Win11 上经常被 SetForegroundWindow lock 静默拒绝 (任务栏闪一下但窗口不上前). 跟主窗口持久窗口 hide→show 的 window-shown IPC 模式同根因, 但通知是外部应用唤醒, 不走 IPC, 直接 setAlwaysOnTop 救场更稳
