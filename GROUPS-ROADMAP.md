# 群组共享功能 Roadmap

跨 6 个 PR 完成的"群组 + 笔记共享"功能。PR #1 已 ship（commit `cef1924`），后续 PR 按这里列的顺序做。

## 核心决策（已拍板，不再变）

| 决策点 | 选择 | 理由 |
|---|---|---|
| **共享粒度** | 每条笔记选可见群组（per-note visibility） | 蘑菇明确选: 类似朋友圈"发布时选可见人"语义 |
| **写权限模型** | 编辑锁 + 先到先得 + 自动释放（**不申请编辑权**） | 蘑菇否决申请编辑权: 编辑频率高不能烦, A 在编时 B 看到提示等就行 |
| **建群方式** | 任何注册用户可建群 + 邀请链接 + 申请审批模式（默认） | 兼顾自由度跟管理员可控 |
| **autoJoin 模式** | 群创建时勾选 → 邀请链接打开直接进群 | 信任圈子用; 被踢/退群过的人 autoJoin 群也强制审批 |
| **文件访问授权** | `/api/uploads/*` 加访问中间件按 noteShares 判 | 不让群外用户直接拿 url 下载 |
| **角色三档** | owner='创建者' / admin='管理员' / member='成员' | UI chip 橙/蓝/灰; admin 可审批/踢人/管理邀请, 不能改群设置/解散 |

## PR 拆分总览

| PR | 内容 | 状态 | 代码量估 |
|---|---|---|---|
| **#1 地基** | DB 迁移 + groups/members CRUD + 邀请 + 申请审批 + 踢人 + 角色管理 + SSE 自动刷新 | ✅ done (cef1924) | ~1500 行 |
| **#2 笔记可见性** | notes.visibility + note_shares + 编辑器底栏 "选可见群组" chip + 列表过滤 + 群组 feed 页 + SSE note-shared 群播 | ✅ done (de8a827 + d3bf481) | ~810 行 |
| **#3 文件授权** | `/api/uploads/*` 加访问中间件按 noteShares 判 + 缩略图同套逻辑 | ✅ done | ~90 行 (实际比估算少, files 表 + LIKE notes content 即可, avatar 不在 files 表自动公开) |
| **#4 SSE 拓展 + AI 共享上下文** | AI chat 10 工具加 scope/author + 群共享可见性 helper + voice_transcription 共享授权链 | ✅ done | ~145 行 (含 author 字段 + groups.ts:90 TS 修 + context.ts 死代码清 -200) |
| **#5 编辑锁（极简）** | 4 lock API + cron 60s 清锁 + version 乐观锁 + NoteEditModal 锁交互 + chat update_note 扩到群成员 | ✅ done | ~470 行 (含 chat update_note 同步扩 + getNoteForAccess helper) |
| **#5b 编辑权限分级 + 申请流程** | 笔记加 edit_permission (admin/all 两档, 默认 admin) + 申请编辑权 6 API + admin 可删 + SSE + GroupDetail 申请管理面板 + NoteCard/NoteDetail 切换胶囊 + 额外授权 popover + Electron 通知唤窗修 + 各种 UX | ✅ done (完整) | ~1500 行 (后端 + 完整前端 UI + 文档) |
| **#5c scope preferences** | preferences.showSharedInMain 全局开关 (默认 false, 开后 3 主 view 显示共享笔记) + scope='all' 子查询 | 被 PR #7a 吸收 (4 选偏好 + 多 scope 分支替代 bool 开关) | — |
| **#6 表情 reaction + 评论** | note_reactions + note_comments thread + ReactionBar/CommentThread 组件 + NoteCard summary + NoteDetail 集成 + SSE 4 事件 | ✅ done | ~1000 行 |
| **#7a Phase A + 偏好生效** | notes.parent_note_id + note_edit_history 表 (仅存储, 7b 接入 fork) + sharedDisplay 偏好 4 选 (own/others/none/all) + 后端 scope 加 'private' / 'others_shared' / 'all' 3 个新分支 + Settings 下拉 + store/App.vue 同步链 | ✅ done | ~150 行 |
| **#7b fork 写入 + UI 标记** | forkNote helper + PATCH /:id fork 决策 (editContext.groupId 触发) + 资源跟随 (note_shares / group_note_pins / note_edit_grants) + note_edit_history 非作者写入 + loadEditorCountMap + GET /:id/edit-history API + Note type 加 parentNoteId/editorCount + store updateNote 处理 forked 标志 + NoteEditModal editContext 透传 + 版本标 + NoteCard 版本胶囊 + editorCount 显示 + NoteDetail 编辑历史 popover | ✅ done | ~430 行 |
| **#7c AI/导出/孤儿收尾** | AI chat update_note 适配 fork (主动问用户) + 导出按 sharedDisplay + 作者删 fork 版 UX 确认 + shared→private 转换约束 + 统计按 origin + 孤儿物理删后台任务 | pending | ~500 行 (估) |

总量预估 ~3550 行。每个 PR 独立 ship 不破坏现有功能。

---

## PR #2 笔记可见性（next）

### Schema 改动

```sql
-- notes 加 1 列
ALTER TABLE notes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
-- enum: 'private' | 'shared'

-- 新表
CREATE TABLE note_shares (
  note_id TEXT NOT NULL REFERENCES notes(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  shared_at TEXT NOT NULL,
  PRIMARY KEY (note_id, group_id)
);
CREATE INDEX idx_note_shares_group ON note_shares(group_id);
CREATE INDEX idx_note_shares_note ON note_shares(note_id);
```

### 查询逻辑

笔记可见性查询（getNotes / getStats 等所有 list 类）：

```sql
WHERE user_id = me
   OR id IN (
     SELECT note_id FROM note_shares
     WHERE group_id IN (
       SELECT group_id FROM group_members
       WHERE user_id = me AND status = 'active'
     )
   )
```

### 后端

- `notes` 表 schema + migration
- `POST/PATCH /api/notes`: 接 `visibility` + `sharedGroupIds[]` 字段
- `GET /api/notes`: 扩展过滤逻辑（默认看我的 + 我所在群可见的；query `?scope=mine|shared|group:<id>` 切换）
- `DELETE /api/notes/:id`: 软删除前查 note_shares, 弹确认窗 "已分享到 X 群"（前端做）
- `routes/groups.ts` 新加 `GET /api/groups/:id/notes` 拉某群可见的笔记列表

### 前端

- `NoteInput` / `MobileInput` / `Capture` / `RichEditor` 编辑器底栏加 "可见性 chip"
  - 默认 private（只我可见）
  - 点击弹小 popover 多选群组复选框
  - 显示 "私密" / "已发到 N 群" 状态
- `NoteCard` 右上角加发布人头像 + 群组 chip（自己发的不显示头像，他人发的显示）
- `Groups.vue` 群详情页加 "群内笔记" feed 区（复用 useMasonry + 灵感页结构）
- `views/Trash.vue` 删除前确认窗加 "已分享到 X / Y 群" 提示
- 路由 `/groups/:id` 内 layout 给笔记 feed 留位置

### 后端 SSE

- `note-shared`: 笔记被分享到某群 → 推 group-changed 给该群成员
- `note-unshared`: 取消分享 → 同上
- `note-deleted`: 共享笔记被作者删 → 群里看到列表也消失（trigger 群成员 loadGroupNotes）

### 决策已锁定 ✓

- ✓ **默认 scope = mine** (只看自己), TopBar 加 scope 切换 chip 让用户主动求"看共享"
- ✓ **群组 feed 排序 = sharedAt DESC** (最近被分享的冲顶)
- ✓ **作者删共享笔记时保留 note_shares** (软删除天然过滤; 恢复时自动重新可见)
- ✓ **PR #2 包 SSE 群播 note-shared** (复用 broadcastGroupChanged helper, 不跨 PR 拆分)

---

## PR #3 文件授权

### 后端中间件

`/api/uploads/*` 路由前加 access check：

```ts
// 拿 url 上的裸文件名 → 查 files 表
// 文件作者是 me → 放行
// 文件 url 出现在共享笔记 content 里 + 我是该群 active member → 放行
// 否则 403
```

### 性能考虑

- `LIKE %url%` 查 notes.content 慢. 建表 `note_files` 跟踪笔记里嵌的文件 url, 上传/笔记 update 时同步
- 或者用现有 `files.user_id` + 笔记 visibility 间接判断（文件作者跟笔记作者通常一致）

### 缩略图

- `/api/uploads/<name>.thumb.jpg` 走同套权限（缩略图通常跟原图同访问权）
- 静态 serve 加 middleware: hono 装 `app.use('/api/uploads/*', accessCheckMiddleware)`

---

## PR #4 SSE 群播 + AI 共享上下文（已完成 ✅）

### SSE 事件

PR #2 阶段 5c 已带（`broadcastNoteShared` helper + `routes/notes.ts` POST/PATCH/permanent delete 调用），本 PR 不再单独拆。

### 实际做的事

**`tools.ts` chat 10 工具按可见范围分层处理：**

- `getVisibilityCondition(userId, scope)` helper —— `mine` / `shared` / `all` 三档 SQL 子查询拼"我的 OR 别人共享给我所在 active 群"
- 5 个读类工具加 `scope` 参数（默认 `all`）：`search_notes` / `get_recent_notes` / `get_todos` / `get_tags` / `get_stats`
- `get_note` 不加 scope，按 id 拿后做"作者本人 OR `note_shares ∩ my_active_groups`"校验
- `get_voice_transcription` 复用 PR #3 文件授权链（audioName LIKE `notes.content` + `visibility='shared'` + note_shares + group_members）
- `get_categories` / `create_note` / `update_note` 不动（分类私有 / 创建归自己 / update 只能改自己）

**author 字段透传（让 AI 区分笔记来源）：**

- `fillAuthorNicknames(userId, notes)` helper 批量 join `users.nickname` 给非本人笔记填 `authorNickname`
- `formatNote` 加 `作者:xxx` 字段（本人笔记不带）
- `prompts.ts` chat 段加【scope 可见范围】说明 + `作者:` 字段语义，让 AI 自然提及"@张三 在群里分享了..."

### 不动的（roadmap 已锁定）

- `ai-config.ts` 的 transcribe / polish 等：私域操作
- `processNoteWithAi` 的自动打标签 / 自动分类 / 摘要：私域

### 顺带做的

- `routes/groups.ts:90` PR #1 历史 TS 错误修（`c.req.param('token')` 空判）
- `context.ts` 清死代码 -200 行（v2 FC 重构后老 RAG 全废，只剩 `estimateTokens`）

### 已知未做（PR #4 范围外）

- **前端 NoteCard 显示共享语音转写**：`ai-config.ts` 的 `transcribe-status` / `transcribe-async` HTTP 接口仍限 `userId`，群成员前端 NoteCard 直接调拉转写还拿不到。AI chat 工具能拉（`get_voice_transcription` 已扩），但 NoteCard 直接 fetch 不行。如未来要做"群里 NoteCard 显示别人共享语音转写"体验需扩这两接口同款授权链。

---

## PR #5 编辑锁（已完成 ✅）

### Schema 改动 (实际 4 列, roadmap 原写 3 列)

```sql
ALTER TABLE notes ADD COLUMN edit_lock_by TEXT REFERENCES users(id);
ALTER TABLE notes ADD COLUMN edit_lock_token TEXT;  -- 实际加: nanoid 16, 防同用户多设备脏写
ALTER TABLE notes ADD COLUMN edit_lock_expires_at TEXT;
ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
```

### 锁参数

- **5 分钟 TTL** + **30s 前端心跳** 续约
- 离开页面 → `fetch(url, { method: 'DELETE', keepalive: true })` (替代 sendBeacon, 后者只支持 POST)
- 5 分钟不续约 → server cron 60s 扫清

### 4 个 API (`routes/notes.ts`)

```
POST   /notes/:id/lock              申请 → {lockToken, expiresAt} 或 409 {lockByNickname, expiresAt}
POST   /notes/:id/lock/heartbeat    续约 (前端 setInterval 30s, body {lockToken})
DELETE /notes/:id/lock              释放 (fetch keepalive on unmount)
PATCH  /notes/:id                   shared 笔记必须带 lockToken + version, 成功后 version++ + 自动清锁
```

### 权限模型

- **所有群 active member 都能编辑共享笔记** (作者/admin/member 平权改 content/tags/category)
- visibility / sharedGroupIds 改分享设置仅作者控 (非作者改返回 403)
- chat 工具 `update_note` 同款扩 (跟 PATCH HTTP 同款鉴权, 但不走 lock - 单次操作不持锁, 检查"别人持锁中"则拒绝)
- `getNoteForAccess(userId, noteId)` helper 集中校验逻辑, 所有 lock API + PATCH 都用

### 前端 (`NoteEditModal.vue`)

- onMounted → 先 acquireLock, 失败直接 emit close 不走 enter 动画
- 拿到锁 → showInner=true 启动 enter 动画 + 启 30s 心跳
- onSubmit → 带 lockToken + version, 409 (version_conflict / lock_invalid) toast 提示
- onBeforeUnmount → fetch keepalive DELETE 释放锁

### 冲突防御

- **同时刻只能一人持锁** → 串行化写入, 没有"覆盖"问题
- **乐观锁兜底** (version): 万一锁机制失效（server 重启清锁等极端 case）, version 校验拒绝旧版本提交

### Cron 清锁

`startEditLockCleanup()` setInterval(60s) 扫 `expires_at < now AND lock_by IS NOT NULL` → 清锁三列. 兜底 case: 浏览器异常关闭 / 断电 / fetch keepalive 也没发出去时, 5 分钟后 cron 兜底释放. 跟 `startReminderScheduler` 同款模式.

### 蘑菇明确否决的方案

- ❌ **申请编辑权 + owner 同意** 流程: 编辑频率太高干扰
- ❌ **协同编辑（CRDT/OT）**: Vditor 集成 yjs 工程量极大, 不做第一版

### 已知未做 (PR #5 范围外)

- **GET `/api/notes/:id` 鉴权未切到 `getNoteForAccess`**: 保持 PR #2 原 inline 实现, 跟 PR #5 helper 重复. 想清理可下个 PR 一起做
- **lock 状态 SSE 推送**: 当前别人编辑时 UI 不会自动提示"@张三 正在编", 必须用户点击进 modal 才发现 lock 失败. 未来想做实时编辑感知可加 `note-lock-acquired` / `note-lock-released` SSE 事件
- **冲突时拉新内容功能**: 当前 version_conflict 只 toast 让用户"关闭重新打开看最新", 没自动 reload 笔记到编辑器. 实现复杂 (要处理用户已编辑的本地草稿), 留给协同编辑 PR 一起做

---

## PR #5b 编辑权限分级 + 申请流程（已完成 ✅, 后端 + 最小前端）

PR #5 默认所有群 active member 都能改共享笔记, PR #5b 默认收紧到"管理员可改" + 加申请流程.

### 权限两档（作者本人一直能改, 不算独立档）

- `admin`（默认, **PR #5b 行为破坏式从 PR #5 的 `all` 改过来**）= 群 owner + admin 能改
- `all` = 所有 active member 能改

### Schema 改动

- `notes` 加 `edit_permission TEXT NOT NULL DEFAULT 'admin'`（enum: admin / all）
- 新表 `note_edit_grants`: (`note_id`, `user_id`, `granted_at`, `granted_by`)—— 申请通过后永久白名单
- 新表 `note_edit_requests`: (`id`, `note_id`, `user_id`, `status`, `message`, `created_at`, `handled_at`, `handled_by`)

### 鉴权扩展

`getNoteForAccess` 加 `mode='read'|'write'` 参数. write 模式额外校验 `edit_permission`:
- author_id = me → 永远放行
- `admin` + 我是该群 owner/admin → 放行
- `all` → 任何 active member 放行
- 在 `note_edit_grants` 白名单内 → 放行
- 否则 → 403（前端弹"申请编辑权"按钮）

PATCH /:id + DELETE /:id + lock API + chat `update_note` 全部用 write mode. `isAdminOfSharedNote` helper 给"管理操作"（DELETE / 审批 / 撤销授权）单独校验, 比 write 更严格 - 普通成员有 write 也不能管.

### 6 个权限管理 API

- `POST /:id/edit-request` —— 申请（没 write 权才能调; 已有 pending 返原 request, idempotent; SSE 推作者 + 群 admin）
- `POST /:id/edit-requests/:reqId/approve` —— 同意（作者 + 群 admin 都能批; 事务写 grants + 改 request status）
- `POST /:id/edit-requests/:reqId/reject` —— 拒绝
- `GET /:id/edit-requests` —— 列所有申请（含 join users 拿 nickname/avatar）
- `GET /:id/edit-grants` —— 列已授权用户
- `DELETE /:id/edit-grants/:userId` —— 撤销授权

**改 editPermission 走 PATCH /:id 的 `editPermission` 字段**（仅作者改, 跟 visibility / sharedGroupIds 同款约定）, 不另加 API.

### SSE 事件

- `note-edit-request` 推作者 + 群 admin, payload 含 requesterNickname / message
- `note-edit-request-resolved` 推申请人, payload 含 status (approved/rejected)

### 前端 (完整)

- **编辑器界面不加权限 chip**（蘑菇明确: 保持编辑界面干净, 权限切换走 NoteCard / NoteDetail）
- 锁失败 toast 区分 409 locked / 403 no_write_permission, 后者 action 按钮一键申请
- SSE handler 收 note-edit-request 弹 toast (**含"同意" action 一键审批**) + 桌面通知
- SSE handler 收 resolved 事件弹通知告知申请人结果
- `NoteCard` 类型后加单胶囊"管理员可编辑 ⟳" / "已分享" 等 (仅作者本人 + shared + `/groups/` 上下文)
- `NoteDetail` 一行三胶囊: 「已分享到 X 个群」+ 「权限切换 ⟳」+ 「额外授权 X 人」(popover 含撤销按钮; `editPermission='all'` 时自动隐藏)
- `GroupDetail` 加"待审编辑申请"section (折叠 >3 条), 同意按钮一键审批
- PATCH 时 403 no_write_permission catch (兜底, 编辑期间权限被撤的罕见 case)
- 各种 UX 修: GlobalToast button error 用白字 (不撞红底), 通知文案"申请编辑权" → "申请编辑权限", Electron 通知 click Win32 lock 防御 (setAlwaysOnTop trick)

### 后端补充

- **作者改自己共享笔记免锁** (PR #5 微调): 锁本意防"群成员协作时撞改", 作者多设备靠 version 乐观锁兜底
- **群级汇总 API**: `GET /:id/note-edit-requests` 拉该群所有 pending 申请, `GET /:id/note-edit-grants` 拉所有已授权用户
- **GET /groups/:id/notes 必须返回 sharedGroupIds + editPermission**: NoteCard 在群组里显示胶囊依赖这两个字段

### 决策锁定 ✓

- ✓ **申请通过后永久授权**（note_edit_grants）, 不是单次. 之前蘑菇否决"每次编辑都申请"是这意思
- ✓ **admin 跟 author 在权限上几乎等同**（改/删/批申请都行）, 唯一差异: admin 不能改 visibility / sharedGroupIds / editPermission（仅作者控分享设置）
- ✓ **申请审批"作者 + admin 都能批"** 跟 PR #1 admin 能"群申请审批"行为一致
- ✓ **不在编辑器界面选权限**（保持编辑界面干净, 在群组界面 / 笔记设置入口改）

---

## PR #5c scope preferences（蘑菇决策已锁定）

PR #2 注释里说"TopBar 加 scope chip 让用户主动求看共享"实际**没实现**, 当前共享笔记只能从群组详情页看到. 蘑菇决定加 preferences 全局开关而不是 TopBar chip.

### Schema 改动

- 复用 `users.preferences` JSON 字段, 加 key `showSharedInMain: boolean` 默认 false
- 后端 API 已支持 `scope` query 参数（PR #2 实现）, 新加 `scope='all'` 子查询（mine + shared 并集, 跟 PR #4 `getVisibilityCondition('all')` 同款 SQL）

### 后端

- `routes/notes.ts` GET / 加 scope='all' 分支: `userId = me OR id IN (note_shares where my groups)`
- `NotesScope` type 加 'all'（当前只有 mine/shared/group:xxx）

### 前端

- Settings.vue 加 toggle: "主页面显示群组共享笔记"（默认关）
- 3 主 view（Inspiration / Notes / Todos）onActivated 根据 `preferences.showSharedInMain` 设 `vs.scope`（true='all', false='mine'）
- **不加 TopBar scope chip**（蘑菇决策: preferences 决定一切, 简化 UX）

### 影响

- 共享笔记 NoteCard 主页显示时, 复用 PR #2 GroupDetail feed 用的 author 头像 + 群组 chip 字段
- AI 默认上下文（PR #4 `scope='all'`）不受 preferences 影响, AI 总能拉群共享（跟主页显示开关解耦）

---

## PR #6 表情 reaction + 评论（已完成 ✅）

### 决策锁定 ✓

- ✓ **emoji 固定 5 个白名单** (`👍 ❤️ 🤔 ✅ 😂`, 前后端共用同一份), 不让用户自选 (防垃圾 / 兼容性 / picker UI 复杂度)
- ✓ **单层 thread**: 顶层评论 (parentId=null) + 一级回复 (parentId=顶层 id). 二级及以下后端 normalize 到根 parent. UI 顶多 2 层缩进
- ✓ **只 NoteDetail 加** 评论区, 编辑器 modal 保持干净 (蘑菇明确: 编辑笔记时不被评论分心, 跟 PR #5b "编辑器不加权限 chip" 同款理念). NoteCard 上只 readonly 显示 summary (`👍 1  💬 2`) 点 NoteCard 走详情
- ✓ **NoteCard 显示计数**: shared 笔记底部 visibleReactions (filter count>0) + commentCount > 0 才显示一行, private 不显示

### Schema 改动 (2 新表)

```sql
CREATE TABLE note_reactions (
  note_id TEXT NOT NULL REFERENCES notes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL,                    -- 5 白名单之一 (后端 ALLOWED_REACTION_EMOJIS)
  created_at TEXT NOT NULL,
  PRIMARY KEY (note_id, user_id, emoji)  -- 每人每 emoji 最多 1 条; 取消 = DELETE row 无审计
);

CREATE TABLE note_comments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  parent_id TEXT REFERENCES note_comments(id),  -- 顶层 null; 一级回复 = 顶层 id; 二级 normalize 到根 parent
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT                        -- 软删 (deletedAt IS NOT NULL 直接前端隐藏, 计数也不算)
);
CREATE INDEX idx_note_comments_note_created ON note_comments(note_id, created_at);
```

### 后端 (`routes/notes.ts`, 6 API + helpers)

- `POST /:id/reactions` body `{ emoji }` —— toggle (有 DELETE / 无 INSERT). 白名单校验 + getNoteForAccess(read) + 仅 shared. 返新 summary + action
- `GET /:id/reactions` —— 列 summary (5 个 emoji 固定顺序, count + mine)
- `POST /:id/comments` body `{ content, parentId? }` —— 单层 thread normalize: `parent.parentId ?? parent.id`. 1000 字上限. shared 笔记限制
- `GET /:id/comments` —— flat list + join users 拿 nickname/avatar, ASC by createdAt. 前端组 thread
- `PATCH /:id/comments/:cid` body `{ content }` —— 仅本人, 无时限
- `DELETE /:id/comments/:cid` —— 软删 (deletedAt). 本人 OR 笔记作者 OR 群 admin
- **broadcastNoteSocial helper**: 推该笔记所属群所有 active member ∪ 作者 (除发起人). reaction / comment 增删改全用
- **loadSocialMetaMaps export helper**: 批量拉 noteIds 的 reactionSummary + commentCount, 给 GET /api/notes 跟 GET /api/groups/:id/notes enrich 共用
- **GET /api/notes + GET /:id + GET /api/groups/:id/notes 全 enrich `reactionSummary` + `commentCount`**: shared 笔记直接 NoteCard 渲染, 不用 N+1 fetch

### SSE 4 事件 (`utils/sse.ts` + `routes/notes.ts`)

- `note-reaction-changed`: payload `{ noteId, summary }`. 前端 dispatchEvent → NoteDetail listener mutate reactionSummary
- `note-comment-added`: payload `{ noteId, comment: 含 userNickname/userAvatar }`. CommentThread listener push
- `note-comment-updated`: payload `{ noteId, commentId, content, updatedAt }`. CommentThread listener 替换字段
- `note-comment-deleted`: payload `{ noteId, commentId }`. CommentThread listener filter 移除

**NoteCard 不直接监听** (避免 N 个 listener 性能), 其 summary 下次 fetchNotes / group-notes-changed 时同步.

### 前端 (2 新组件 + 3 处集成)

- **`components/ReactionBar.vue`** —— 5 个固定 emoji + count + mine 高亮. `mode='full'` (NoteDetail 永远渲染 5 个, 可 toggle) / `mode='compact'` (只 count>0, readonly). 乐观更新 toggle + emit `update:summary`
- **`components/CommentThread.vue`** —— 单层 thread + 顶部输入框 + 编辑/删除/回复 + @xxx 引用. SSE 增量更新自管. props: `noteId` + `canDeleteAny` (作者+admin)
- `NoteCard.vue`: shared 笔记 tags 行后加 inline summary 行 (👍 1  💬 2). 不用 ReactionBar 组件 (readonly inline 更省)
- `NoteDetail.vue`: 三胶囊行下加 reaction section + comment section (本地 reactionSummary ref + SSE 监听)
- `NoteEditModal.vue`: **不集成评论区** (蘑菇决策, 保持编辑器干净, 评论走 NoteDetail)

### 已知未做 (PR #6 范围外)

- **AI chat 工具 `update_note` / `search_notes` 无 reaction/comment 感知**: AI 拿不到 "@张三在评论里说..." 这种 context. 未来加 `get_note_comments` 工具可扩
- **NoteCard 不实时 SSE 同步**: 别人 reaction/评论时 NoteCard 上的 summary 不自动更新 (需重新 fetchNotes 或进 NoteDetail 看). 性能考量, N 个 NoteCard listener 代价大
- **群级"未读"提示**: 群里别人评论了我的笔记 / 我参与过 thread 的新回复 → 没有未读红点. 未来加 noteCommentLastRead 表可扩
- **评论编辑无时限**: 蘑菇明确不加 5 分钟时限 (PR #5 锁已防同时编笔记, 评论频率低无所谓)
- **评论 markdown 渲染**: 当前 textarea 输入纯文本, 不渲染 markdown. 未来想要可在 CommentThread 加 Vditor.md2html (但评论简短, 大多无意义)

---

## PR #7 共享笔记 COW (Copy-on-Write) 分叉模型 + 列表显示开关

**核心理念**: 作者发布到群 = 把内容**贡献给群**, 自己不留独立备份. 作者列表只是"展示", 跟着群内现状走. 谁先动手改才分叉.

### 模型示例

note A 共享到 1/2/3 群 (作者开启了"显示分享到群组的"开关):

| 状态 | 数据库 | 作者列表 |
|---|---|---|
| 初始 (没人改) | `note_shares: (g1,A) (g2,A) (g3,A)` | 1 条 (A) |
| 1 群被改 | 新建 `A'` (parent=A, userId 仍是原作者), `note_shares: (g1,A') (g2,A) (g3,A)` | 2 条 (A, A') |
| 2 群也被改 | 新建 `A''`, `note_shares: (g1,A') (g2,A'') (g3,A)` | 3 条 (A, A', A'') |
| 3 群也被改 | 新建 `A'''`, `note_shares: (g1,A') (g2,A'') (g3,A''')`, A 变孤儿被物理删 | 3 条 (A', A'', A''') |

**作者修改语义**:
- 仅 1 群分叉时, 作者从灵感页改"共享版"(A) → 改 A → 2/3 群同步
- 2/3 群也分叉后, 灵感页 3 条独立, 改谁只影响谁
- 作者从群组页面进入改 → 永远只改"该群当前版本", 不一次性影响多群
- **UI 必须明确标记"现在改的是哪一版"** (本群独占版 / N 群共享版), 避免误改

### 偏好设置: 主页面群组共享笔记可见范围 (4 选 1 下拉)

private 笔记始终显示, 此偏好仅控制纳入哪些群组共享笔记:

- 默认 `own` (UI: 仅我发布的): 作者本人 private + 作者本人分享出去的 shared (跟历史行为完全一致)
- `others` (UI: 仅他人发布的): 作者本人 private + 他人共享给我所在群的 shared (作者本人 shared 被过滤)
- `none` (UI: 全部隐藏): 仅作者本人 private (任何 shared 都过滤)
- `all` (UI: 全部显示): 作者本人 private + 作者本人 shared + 他人 shared

实施: 偏好存 `users.preferences.sharedDisplay`, 4 个值映射到 GET /api/notes 的 `scope` 参数 (mine / others_shared / private / all).

### Corner case 决策 (2026-06-05 跟蘑菇定)

| # | 问题 | 决策 |
|---|---|---|
| 1 | fork 时 AI 标签/分类/摘要 | **不重跑**, 复制旧标签 (接受可能跟新内容不符) |
| 2 | 修改历史 (谁改过) | **要做**: 加 `note_edit_history` 表 (note_id, user_id, edited_at), UI 显示"原作者发布 · B、C 编辑过" |
| 3 | 作者改时上下文混淆 | **要做**: UI 明确标"本群独占版" / "N 群共享版", 灵感页改共享版同步多群, 群组页改只影响该群 |
| 4 | 孤儿笔记 (所有共享群都 fork 走了, 或群解散后没引用) | **物理删** (作者发出去就不留备份, 没群引用 = 该内容已不属于任何人) |
| 5 | shared → private 转换 | **仅未被任何群修改过的版本能改 private**, 改后从所有群移除 (等于撤回 + 加到自己列表). 被别人编辑过的 fork 版**不能改 private** (已是群的资产) |
| 6 | 统计计数 | **fork 算 1 条**, 按 origin 维度 (有 parent_note_id 链可追溯) |
| 7 | AI Chat `update_note` / `search_notes` | **明确哪个 fork 改哪个**. AI 不知道是哪个群的版本 → 主动问用户 |
| 8 | 导出 ZIP | 按"作者列表能看到的"导 (跟显示开关一致, 默认 self 模式只导自己分享的所有 fork) |
| 9 | 作者删 fork 版的 UX | **弹确认**: "该版本由 B、C 编辑过, 确认删除？" (作者技术上有删除权, 但要警醒) |

### Schema 改动 (草稿)

```sql
-- notes 表加 parent_note_id 字段 (origin = 最初的 root note id)
ALTER TABLE notes ADD COLUMN parent_note_id TEXT REFERENCES notes(id);

-- 修改历史 (Corner case #2)
CREATE TABLE note_edit_history (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  edited_at TEXT NOT NULL
);
CREATE INDEX idx_note_edit_history_note ON note_edit_history(note_id, edited_at DESC);

-- 偏好: prefs.sharedDisplay enum ('own' | 'others' | 'none' | 'all'), 默认 'own'
```

### 资源跟随 (fork 时怎么处理关联资源)

| 关联 | 跟随策略 |
|---|---|
| 附件 (file uploads, markdown 内嵌的图片/录音) | A 和 A' 都引用同一物理文件. GC 按 "还有 note 引用就保留" |
| 群内置顶 (group_note_pins, PR #6 做的) | fork 时 update `(g1, A)` → `(g1, A')`, 否则置顶视觉断 |
| 编辑锁 (edit_lock, PR #5) | fork 后各自独立锁, 互不影响 |
| 编辑权限 (editPermission, PR #5b) | A 的设置原样复制给 A', 后续 A 改设置不影响 A' |
| AI 标签 (tags / category / summary) | 直接复制, 不重跑 (Corner case #1) |
| sharedGroupIds 字段 | fork 时 A' 只 belong to 该 fork 出来的群 (单群) |

### 实施顺序 (PR #7 拆 phase)

1. **Phase A**: schema 改造 (parent_note_id + note_edit_history) + 偏好 sharedDisplay
2. **Phase B**: fork 写入逻辑 (PATCH /api/notes/:id 在 non-author 改 shared 笔记时触发 fork, 资源跟随)
3. **Phase C**: GET /api/notes 按 sharedDisplay 过滤 + 灵感页 v-if 显示 fork 标签 + "本群独占版/N 群共享版"标
4. **Phase D**: AI Chat 工具适配 (Corner #7), 导出适配 (Corner #8), 作者删 fork 版 UX (Corner #9)
5. **Phase E**: shared → private 转换约束 (Corner #5)
6. **Phase F**: 统计按 origin 维度 (Corner #6), 孤儿物理删后台任务 (Corner #4)

**工程量估算**: 比 PR #5 + PR #5b 加起来还大. 必须独立 PR. 当前 PR (群组重构 + 群内置顶) 跟 COW **不冲突**, 先 ship.

### Sub-PR 7a 实施细节 (已 ship)

完整覆盖 Phase A + Phase C 的偏好生效部分, 落地命名:

- **Schema** (`packages/server/src/db/`):
  - `notes.parent_note_id TEXT` (自引用, root note 为 NULL, 7b fork 时填). 跟 `noteComments.parentId` 同款不加 Drizzle references
  - `note_edit_history` 新表 (id / note_id / user_id / edited_at), 索引 `idx_note_edit_history_note (note_id, edited_at DESC)`. 7b 接入 fork 时写入
  - `notes.parentNoteId` Drizzle column + `noteEditHistory` table export + `NoteEditHistory` / `NewNoteEditHistory` types

- **后端 scope 接口** (`packages/server/src/routes/notes.ts` GET `/`):
  - 新增 3 个 scope 分支: `private` (作者本人 private only) / `others_shared` (作者本人 private + 他人 shared) / `all` (mine ∪ 他人 shared)
  - 保留 PR #2 的 `mine` / `shared` (后者不被偏好映射, 仅兼容旧调用方)
  - `enrich author info` 段保持 `scope !== 'mine' && scope !== 'private'` 拼装条件 (others_shared / all / shared 走拼装)

- **前端 store** (`packages/web/src/stores/notes.ts`):
  - `ViewState.scope` 类型扩到 `'mine' | 'private' | 'others_shared' | 'shared' | 'all'`
  - `SHARED_DISPLAY_TO_SCOPE` 映射: `own→mine` / `others→others_shared` / `none→private` / `all→all`
  - `sharedDisplay` ref (默认 `'own'`) + watch 触发清各 view notes/total/page + 改 vs.scope (跟 sortBy 同款套路)
  - export `sharedDisplay`

- **前端偏好持久化链** (`packages/web/src/views/Settings.vue` + `App.vue`):
  - `prefs.sharedDisplay` 默认 `'own'`, 走现有 prefs reactive 防抖保存到 `users.preferences`
  - Settings 偏好设置 tab 新加 CustomSelect (标题"群组共享笔记可见范围", 4 选 仅我发布的 / 仅他人发布的 / 全部隐藏 / 全部显示)
  - Settings onMounted + watch `prefs.sharedDisplay` → `notesStore.sharedDisplay = v`
  - App.vue `applyUserPreferences` 加 sharedDisplay 推到 store (启动时 + auth.user 变化时, 用户没打开过 Settings 也生效)

### Sub-PR 7a 不做的 (留给 7b/7c)

- fork 写入 (PATCH /:id 写入仍按原逻辑, 非作者改 shared 直接更新原 note, **不分叉**)
- editContext 字段 (前端 PATCH body 暂未加这字段, 7b 接入)
- note_edit_history 写入 (表已建但没写入逻辑)
- UI "本群独占版" / "N 群共享版" 标
- AI chat 工具适配 / 导出 / 孤儿清理

### Sub-PR 7b 实施细节 (已 ship)

落实 Phase B + UI 标 (Corner #2 / #3):

- **后端 `forkNote(tx, original, groupId, now)` helper** (`packages/server/src/routes/notes.ts`):
  - 在 tx 内同步执行. 新建 fork note (新 id, parentNoteId 指 root, userId 保留作者归属, createdAt 沿用 root, 清锁三列 + version=1, visibility='shared', editPermission 跟原)
  - note_shares 转移: 该群 (groupId, oldId) → (groupId, newId), 其它群 (otherGid, oldId) 不动
  - group_note_pins 跟随: 该群该笔记的置顶迁到 fork
  - note_edit_grants 复制: 作者授权过的人在 fork 也保留权限 (尊重作者意图, 蘑菇拍板 2026-06-06)
  - reactions / comments **不跟随** fork (蘑菇拍板: 表态属于原内容, 仍留 original)
  - 单层链: 若 original 已是 fork, 新 fork 仍指向 original.parentNoteId (不嵌套)

- **PATCH /:id fork 决策** (路由内联):
  - `updateNoteSchema` 加 `editContext: { groupId?: string }` 字段
  - `isContentChange`: 改了 content/summary/category/tags/type/todoStatus/todoDue/todoRemindRrule 任一. 不含 pinned (作者私域) / visibility / sharedGroupIds / editPermission (分享设置)
  - 非作者 + shared + isContentChange + editContext.groupId 存在 → 必 fork. ctxGroupId 缺失返 `400 editContext_required`, 不在 currentShareGroupIds 返 `400 note_not_in_group`
  - 作者 + shared + isContentChange + editContext.groupId 存在 + parentNoteId === null + 多群 (sharedGroupIds.length > 1) → fork (避免作者从群组页改影响其它群)
  - 其他作者改情况走 in-place: 灵感页改 root 多群同步 / 改 root 单群 / 改 fork (单群专属)
  - fork 路径禁止改 visibility / sharedGroupIds (分享设置只有作者从主视图 in-place 改)
  - 返回 `{ data: newNote, forked: true, forkedFromNoteId: id }`

- **note_edit_history 写入**: 事务里 `if (!isAuthor && shared && isContentChange) insert`. fork 路径写 newNoteId, in-place 路径写旧 id. 作者改不写 (保持 "原作者发布 · @B 编辑过" 语义)

- **loadEditorCountMap(noteIds)** export helper: 批量拉一组笔记的 distinct editor 数. GET /api/notes / GET /:id / GET /api/groups/:id/notes 三处 enrich

- **GET /api/notes/:id/edit-history**: 列编辑历史 join users 拿 nickname/avatar 按 editedAt DESC. NoteDetail "X 人编辑过" popover 用

- **前端 store `updateNote` 处理 `forked` 标志** (`packages/web/src/stores/notes.ts`):
  - res.forked === true → 当前 view fetchNotes keepCount 拉权威数据 (新 fork + 老 note 状态变化都同步), 跨 view 标 dirty 下次 onActivated 同步
  - 不走原 in-place mutate (新 fork 新 id, 老 note 字段也变, mutate 无法处理)

- **`NoteEditModal.vue`**:
  - useRoute 自动识别 `/groups/:gid` → `editContext.groupId` 透传给 PATCH
  - PATCH 错误处理加 `editContext_ambiguous` / `note_not_in_group` 分支 toast (引导用户去群组页改)
  - 加 `isMyNote` 守卫: 仅作者本人才把 `visibility` / `sharedGroupIds` 塞进 patchData (RichEditor.submit 永远回传这俩 form 字段, 非作者透传会撞后端"只有作者可以修改共享设置" 403)

- **`NoteCard.vue`**:
  - 底部 social meta 行加 PhPencilSimple + editorCount "X 人编辑过" 计数 (跟 reaction / commentCount 同行)
  - `showSocialMeta` 触发条件扩到 `editorCount > 0`

- **`NoteDetail.vue`**:
  - 加 "X 人编辑过" 胶囊 + popover (lazy load via api.getNoteEditHistory, 列编辑者 avatar/nickname/时间)
  - 跟现有分享设置行分开 (现有行 v-if=isMyNote 仅作者, 新行 v-if=isShared 群成员也看得到)

- **`stores/notes.ts`**:
  - `updateNote` fork 路径派 `quink-group-notes-changed` 事件 (editContext.groupId 存在时), 让 GroupDetail 重拉群笔记 feed (GroupDetail 用本地 ref 自管, store 同步走不到)

- **版本标 chip 设计被放弃** (蘑菇 2026-06-06 拍板):
  - 原方案想标 "群独占版" (fork) / "N 群共享版" (root 多群)
  - 问题: root 多群对非作者是信息泄露 (B 不该知道 A 还共享给了哪些群); fork 标对群成员也没意义 (他们本来不知道有 root 跟 fork 的区分, 这条对他们就是群里的一条笔记). 作者本人看 fork 的需求弱, 真要追溯原版可走 parent_note_id 链未来加按钮
  - 决策: 3 处 versionBadge 全删. 用户视觉无 fork 概念暴露, fork 行为对群成员透明

- **`api/index.ts`**:
  - Note 加 `parentNoteId?` + `editorCount?`
  - 新 `NoteEditHistoryRow` interface
  - `updateNote` 入参类型扩 `editContext?: { groupId?: string }`, 返回类型扩 `forked?: boolean; forkedFromNoteId?: string`
  - 加 `getNoteEditHistory(id)` 方法

### Sub-PR 7b 不做的 (留给 7c)

- AI chat `update_note` / `search_notes` 适配 fork (AI 拿不到"哪个 fork 是哪个群版本", 需主动问用户) — Corner #7
- 导出 ZIP 按 sharedDisplay (默认 self 模式导自己分享的所有 fork) — Corner #8
- 作者删 fork 版 UX 确认 ("该版本由 B、C 编辑过, 确认删除？") — Corner #9
- shared → private 转换约束 (仅未被任何群修改过能转 private) — Corner #5
- 统计按 origin 维度 (parent_note_id 链追溯 root 算 1 条) — Corner #6
- 孤儿物理删后台任务 (所有共享群都 fork 走 → root 失去引用 → 物理删) — Corner #4
- 主视图改别人共享笔记 (editContext.groupId 缺失) 的歧义解决: 已实现"宽容方案" — 后端算 `user.active_groups ∩ note.shared_groups`, 唯一交集自动 fork 到那群 (90% case 无歧义); 多个交集才返 `editContext_ambiguous` 让前端 toast 引导去群组页. 罕见歧义 case (B 同时在多群且都共享了同一条) 留 7c 看是否加群选择器交互

---

## 扩展点子清单（PR #7 之后可选）

按价值排：

| 价值 | 点子 | 复杂度 | 备注 |
|---|---|---|---|
| 高 | 群组共享 AI 上下文 | 低 | 已含在 PR #4 |
| 高 | @mention 触发对方 reminder_channel | 低 | 复用 reminder dispatch, 评论 + 笔记内都能用 |
| 高 | 协作 todo 指派（assignee） | 中 | todo 加 assignee_user_id, 到期推他的 reminder_channel |
| 中 | 群组共享文件夹 | 中 | folders 加 group_id, 群成员都能看 |
| 中 | 群周报自动生成 | 中 | scheduler 周一跑 AI 汇总群内本周笔记 → 发回群 |
| 中 | 群组级 reminder_channel | 低 | 群组自己的飞书机器人, 群内 todo 自动推 |
| 低 | owner 一键导出归档 | 低 | 解散群前导 zip / markdown 留底 |
| 低 | 跨群 #hashtag 索引 | 中 | tags 已经有, 加跨群搜接口即可 |
| ❌ | 协同编辑 CRDT/OT | 极高 | Vditor + yjs 不建议 |

---

## 主要架构风险（已记录在头脑里, 写下来防丢）

1. **AI 拉上下文范围改 → 所有 chat / 自动分类 / 自动打标签跟着变**, PR #4 改完要测各 view
2. **文件 url 共享**: PR #3 前所有图片/音频在共享笔记里点击会 404, 必须 PR #2 PR #3 一起 ship 才能用
3. **deleted_at 软删除链**:
   - 作者删共享笔记 → 群里立即消失（用 `WHERE deleted_at IS NULL` 过滤天然如此）
   - 群被解散 → `note_shares` 表 row 清掉但笔记本体保留（仅作者可见）
   - 群成员被踢/退群 → 他立即看不到该群共享笔记（查询自动过滤 `group_members.status='active'`）
4. **DB 迁移**: PR #2 加 notes.visibility 默认 'private', 现有所有笔记自动归 private 无侵入

---

## 维护规则

- **PR 顺序不能跳**: 后续 PR 依赖前面（PR #2 没做 PR #3 文件中间件没用 / PR #4 SSE 推送依赖 PR #2 的 note_shares 表）
- **shipped PR 不改决策**: 已 ship 的 PR (#1) 的 schema/API/UI 决策固化, 后续 PR 兼容它
- **任何"还没拍板"的小决策**记到对应 PR 段末尾"决策待拍板", 实施时蘑菇拍板
- **CLAUDE.md 维护规则**: 群组业务模块自身代码可读, 这个 roadmap 是规划记录不进 CLAUDE.md, 在根 CLAUDE.md 留指针 `GROUPS-ROADMAP.md`
