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
| **#7c AI/导出/孤儿收尾** | 已**拆解到** #8 / #9 / #13. 孤儿处理已在 7b 用 "改私密 + 软删" 落地 (Corner #4 改决策). 作者删 fork 版提示 → 进 #9. AI chat update_note 适配 fork + shared→private 转换约束 + 统计按 origin + 导出按 sharedDisplay → 进 #13 | 拆解 | — |
| **#8 命名重整** | 字段值改名 (`note`→`inspiration`, `snippet`→`note`, 删 `link`) + 路由改名 (`/`→`/inspiration` + 旧 `/` 重定向) + AI prompts 同步 + DB 自动迁移 | pending | ~500 行 (估) |
| **#9 权限重整** | 字段权限细分 (B 类作者私域字段非作者禁改) + NoteCard 三点菜单按钮 v-if / 编辑器界面非作者只显示正文 / 后端 PATCH 守卫 / "另存为灵感/笔记/待办" (副本 userId=操作人, 正文加引用原作者) / 申请编辑权点编辑改弹窗 / 作者删 fork 版给提示 / "私密"字面改 "私人" / 群组批量操作权限筛选 (普通成员隐藏多选按钮) | pending | ~700 行 (估) |
| **#10 通知中心** | 新通知表 + 通知 view (4 tab: 全部/内容/提醒/群组) + 入口 (头像列表传输按钮上方) + SSE 推送 + 接入: 另存为通知 / 申请编辑权通知 / 提醒到点 / 群组变更通知 / 评论从 toast 搬到通知页 (reaction 仍卡片) | pending | ~700 行 (估) |
| **#11 提醒分家** | 个人提醒 (todoDue, 每人自管, 删了内容也响) + 群提醒新表 (群管理员设, 群所有人收) + 群组提醒接收开关 (每人自己控该群提醒) | pending | ~500 行 (估) |
| **#12 群组回收站 + 审计** | 每群一个回收站 (从群组页进, 标题"X 群的回收站") + 7 天强制清 + 群主+管理员都能恢复, 仅群主能永久删 + 后端所有改/删存内容快照 (审计表 + 服务器主人管理界面留 #12+ 单独做) | pending | ~700 行 (估) |
| **#13 收尾** | AI chat update_note 适配 fork (主动问用户改哪一版) + shared→private 转换约束 (仅未被任何群修改过能转) + 统计按 origin 维度 (fork 算 1 条, parent_note_id 链追溯) + 导出按 sharedDisplay | pending | ~500 行 (估) |

总量预估 ~6900 行 (含已 ship 跟 6 个新 PR). 每个 PR 独立 ship 不破坏现有功能.

**PR 命名重整约定 (蘑菇 2026-06-06)**:
- 原计划 7c-1 ~ 7c-5 子 PR 命名作废, 直接用 #8 #9 #10 #11 #12 #13 平铺往后排
- 原 PR #7c 内容拆解到 #9 (作者删 fork 提示) 跟 #13 (AI/导出/统计/约束)

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
| 4 | 孤儿笔记 (所有共享群都 fork 走了, 或群解散后没引用) | **改私密 + 软删到回收站** (蘑菇 2026-06-06 改决策, 不再物理删: 作者可能想保留原稿, 走 30 天软删窗口可恢复) |
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

- **PATCH /:id fork 路径事务里的孤儿处理** (Corner #4 改决策): forkNote 删完 (id, ctxGroupId) 后查 `existing.id` 剩余 note_shares 数, = 0 → existing 变孤儿 → 改 `visibility='private'` + `deletedAt=now` + 清锁三列. 作者可在回收站找回 / 改回 shared 重新分享 / 30 天后自动彻底清

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
  - 分享设置守卫: 仅"主视图 + 作者本人"才传 visibility / sharedGroupIds (`isMyNote.value && !editGroupId.value`).
    - 非作者主视图传 → 撞后端 "只有作者可以修改共享设置" 403
    - 作者群组页改 root 多群 → 进入 fork 路径, 传分享设置撞 "fork 不允许改 visibility/sharedGroupIds" 400
    - 群组页语义 = "改本群版本", 分享设置改 root 才有意义, 群组页 modal 不该跟. RichEditor 永远回传这俩 form 字段只为 UI 回填, 不代表用户真改

- **`NoteCard.vue`**:
  - 底部 social meta 行加 PhPencilSimple + editorCount "X 人编辑过" 计数 (跟 reaction / commentCount 同行)
  - `showSocialMeta` 触发条件扩到 `editorCount > 0`

- **`NoteDetail.vue`**:
  - 加 "X 人编辑过" 胶囊 + popover (lazy load via api.getNoteEditHistory, 列编辑者 avatar/nickname/时间)
  - 跟现有分享设置行分开 (现有行 v-if=isMyNote 仅作者, 新行 v-if=isShared 群成员也看得到)

- **`stores/notes.ts`**:
  - `updateNote` fork / in-place 两路径都派 `quink-group-notes-changed` 事件 (editContext.groupId 存在时), 让 GroupDetail 重拉群笔记 feed (GroupDetail 用本地 ref 自管, store 同步走不到). 抽 `notifyGroupReload` helper 复用
  - `deleteNote` 收 res.sharedGroupIds 后给每个群派 `quink-group-notes-changed` 让操作者自己的 GroupDetail 重拉 (别人通过后端 broadcastNoteShared 收 SSE 已自动刷)
  - 新 `refreshFromRemote()` export: 当前 view 是 3 主 view 之一 → fetchNotes keepCount, 跨 view 全标 dirty 让下次 onActivated 同步. SSE group-notes-changed handler 用

- **`routes/notes.ts` DELETE /:id**: response 加 `sharedGroupIds` 字段, 给前端 store.deleteNote 派事件用. 后端 broadcastNoteShared 仍走 (复用同一 array, 单次查询)

- **`utils/sse.ts`**:
  - `group-notes-changed` handler 除了派 window 事件给 GroupDetail, 同时调 `useNotesStore().refreshFromRemote()` 让主 view 也同步 (sharedDisplay='all'/'others_shared' 时主 view 显示别人共享笔记 → 别人改了要刷新)

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
- ~~孤儿物理删后台任务~~ — Corner #4 蘑菇改决策走"软删 + 改私密"已在 7b 实施, 7c 不需要再做
- 主视图改别人共享笔记 (editContext.groupId 缺失) 的歧义解决: 已实现"宽容方案" — 后端算 `user.active_groups ∩ note.shared_groups`, 唯一交集自动 fork 到那群 (90% case 无歧义); 多个交集才返 `editContext_ambiguous` 让前端 toast 引导去群组页. 罕见歧义 case (B 同时在多群且都共享了同一条) 留 7c 看是否加群选择器交互

---

## PR #8 命名重整 (next, pending)

**目标**: 把项目早期遗留的"type 字段值跟 UI 名字对不上 + 路由不对称 + link 类型遗留"这 3 个技术债一次性清理. 命名干净后 #9 起 PR 不在乱命名上叠 bug.

### 命名映射 (蘑菇 2026-06-06 拍板)

**type 字段值改名** (蘑菇 2026-06-06 拍板用 `quink`):

| UI 上叫 | 旧字段值 | 新字段值 |
|---|---|---|
| 灵感 | `note` | `quink` |
| 笔记 | `snippet` | `note` |
| 待办 | `todo` | `todo` (不变) |
| (link 类型废弃) | `link` | 删除 (DB 当前 0 条已确认安全) |

**路由 URL 改名**:

| UI 上叫 | 旧 URL | 新 URL |
|---|---|---|
| 灵感 | `/` | `/quink` |
| 笔记 | `/notes` | 不变 |
| 待办 | `/todos` | 不变 |

旧 `/` 加 302 重定向到 `/quink` 保证用户输入域名仍有默认页.

### 数据库自动迁移

后端启动时跟现有 `CREATE TABLE IF NOT EXISTS + ALTER TABLE` 同模式 try-catch 包: 
```sql
-- 迁移顺序重要: 先把 'snippet' 改 'note', 不然 'note' 改 'quink' 后又会把改完的 'quink' 再当成旧 'note' 改 (错)
UPDATE notes SET type='note' WHERE type='snippet';
UPDATE notes SET type='quink' WHERE type='note' AND type != 'note'; -- 这里要小心顺序, 实际实现用 CASE 或临时值避免覆盖
DELETE FROM notes WHERE type='link';
```

实际实现用 CASE 表达式避免顺序坑:
```sql
UPDATE notes SET type = CASE
  WHEN type = 'snippet' THEN 'note'
  WHEN type = 'note' THEN 'quink'
  WHEN type = 'link' THEN 'DELETE_ME'
  ELSE type
END;
DELETE FROM notes WHERE type = 'DELETE_ME';
```

Schema enum 同步: notes.type 从 `['note', 'todo', 'snippet', 'link']` 改 `['quink', 'note', 'todo']`.

### 代码改动范围 (约 30 文件)

- **Schema** (`packages/server/src/db/schema.ts`): notes.type enum 修改
- **类型定义** (`packages/server/src/db/schema.ts` + `packages/web/src/api/index.ts`): NoteType 同步
- **routes/notes.ts**: zod schema 跟 createNoteSchema / updateNoteSchema 里的 enum 改
- **AI prompts** (`packages/server/src/ai/prompts.ts`): auto_tag / auto_classify / chat 工具描述里提到 'note' / 'snippet' / 'link' 全改
- **AI tools** (`packages/server/src/ai/tools.ts`): create_note / update_note 的 type 参数 enum 描述改
- **前端 router** (`packages/web/src/router/index.ts` + 类似): 路径 `/` 改 `/quink` + 加 `/` redirect
- **前端 store** (`packages/web/src/stores/notes.ts`): `typeToView` map 改, `ViewKey` 跟 `_viewState` key 同步检查 (key 可能不需要改, 它跟字段值无关)
- **侧边栏** (`packages/web/src/components/Sidebar.vue`): 路径 + typeFilter 映射改
- **TopBar** (`packages/web/src/components/TopBar.vue`): types 过滤的 chip 显示
- **3 主 view 文件**: Inspiration.vue / Notes.vue / Todos.vue 内部的 `filterType` / `default-type` prop / 类型判断
- **NoteCard.vue + NoteDetail.vue + RichEditor.vue + MobileInput.vue + NoteInput.vue + Capture.vue**: 所有 `type === 'note'` / `type === 'snippet'` 字符串改
- **TYPE_TO_NAV_PATH** (`packages/web/src/utils/cardLeave.ts`): 类型到路径的映射
- **AI.vue / AiChat.vue**: 创建笔记的 type 参数
- **scripts/seed-trash.mjs**: 演示数据里的 type
- **CLAUDE.md**: 根级 + packages/web/CLAUDE.md 里"笔记类型→view 映射"段全改

### 自测清单 (Claude MCP 能测)

- tsc 双 EXIT=0
- 后端启动无 schema migration 错误
- sqlite-mcp 查 notes 表的 type 值: 应该全是 `quink` / `note` / `todo` 三种, 无 `snippet` 无 `link`
- chrome-devtools-mcp 注入: 看 Sidebar 路径 / NoteCard chip 文案对得上

### 手测清单 (需要蘑菇)

1. 浏览器输 `http://localhost:24888/` → 应自动跳 `/quink` (灵感页)
2. 旧浏览器书签 `/notes` `/todos` 应仍能打开 (不变)
3. 新建笔记 / 灵感 / 待办: 数据库里的 type 字段值应该是 `note` / `quink` / `todo`
4. 编辑器底部类型选择器: 3 个选项分别叫 灵感 笔记 待办, 不应再出现 link
5. AI 创建笔记: AI 应使用新字段值 (chat 给 AI 一句话让它建 todo, 看是否成功)

---

## PR #9 权限重整 (pending)

**目标**: 把"谁能改笔记什么字段"按 5 类细分, 前后端守卫一致. UI 按角色隐藏对应按钮. 加"另存为"功能让无权限的人也能保留内容副本.

### 字段权限 5 类

| 字段类 | 包含字段 | 谁能改 | 改触发 |
|---|---|---|---|
| **正文** | `content`, `summary` | 作者+群主+管理员+grants 白名单 | 非作者+ shared 触发 fork |
| **作者私域** | `category`, `tags`, `pinned` (主页置顶) | **仅作者** (含群主管理员都不能改别人的) | in-place |
| **类型/状态** | `type`, `todoStatus` | 作者+群主+管理员 (普通成员含 grants 都不能改) | 改 type 不 fork (字段不属于 fork 范畴) |
| **分享设置** | `visibility`, `sharedGroupIds`, `editPermission` | 仅作者 | in-place |
| **群级独立** | `groupPinned` | 群主+管理员 (PR #6 已落) | 群级 API |

### NoteCard 三点菜单按钮可见性

| 按钮 | 显示条件 |
|---|---|
| 主页置顶 / 取消主页置顶 | `isMyNote && !inGroupContext` |
| 群内置顶 / 取消 | `canPinInGroup` (PR #6 已落) |
| 编辑 | 永远显示 (没权限 → 改弹申请窗, 不进编辑器) |
| 标记完成 / 未完成 | `isMyNote || isGroupAdmin` (todo 类型时显示, 普通成员含 grants 都不显示) |
| 设置提醒 (个人) | `type === 'todo'` (所有人都能设自己的, 不限作者) |
| 设置群提醒 | `inGroupContext && isGroupAdmin && type === 'todo'` (群管理员/群主额外按钮, 详见 PR #11) |
| 另存为灵感 / 笔记 / 待办 | 所有人都能用 (复制成自己的私人副本); 按 note.type 决定文案 |
| 多选 | `isGroupAdmin` (群组上下文) 或 `!isShared` (主视图只针对私人笔记) |
| 删除 | `canDelete` (PR #7b 已落) |

### "另存为" 操作详情

- 按钮文案按 note.type 决定: `quink` → "另存为灵感", `note` → "另存为笔记", `todo` → "另存为待办"
- 操作: 后端 POST `/api/notes/:id/duplicate` 创建副本 note
  - 副本 userId = 当前操作人
  - 副本 visibility = 'private'
  - 副本 type = 跟原笔记 type 一致
  - 副本 content = 原笔记 content + 开头自动加引用块: `> 原作者: @{原作者昵称} ｜ {原笔记 createdAt YYYY-MM-DD}\n\n`
  - 副本 parentNoteId = 不指向 (因为不是 fork, 是独立副本)
  - 副本 tags / category / pinned / todoStatus / todoDue 都不复制 (副本自己一套)
- 通知原作者: SSE 推 `note-duplicated` 事件给原作者 → 前端 PR #10 前先用 toast 顶, PR #10 接入通知页

### 申请编辑权改成弹窗

PR #5b 时申请编辑权是 toast 上有"申请"按钮 → 现改成: 没权限的人点编辑按钮 → 弹申请对话框 (输入申请理由 + "提交申请" / "取消")
- 提交后调现有 `POST /:id/edit-request` API
- 通知作者跟群管理员 (PR #10 前仍走 SSE + toast)

### 编辑器界面变化

- 作者本人: 什么都能改 (跟现在一致)
- 非作者 (有 write 权限): UI 上的 type 选择器 disable, tags / category 入口隐藏, 只让改正文. 后端 PATCH 守卫额外兜底 (剥 B/C 类字段, 静默忽略)
- 非作者 (没 write 权限): 根本进不了编辑器 (点编辑触发申请弹窗)

### 后端 PATCH 守卫

```ts
if (!isAuthor) {
  // 删除作者私域 + 类型/状态 + 分享设置字段 (前端 UI 已隐藏对应入口, 这里防御性兜底防旧客户端 / 直接调 API)
  delete data.category;
  delete data.tags;
  delete data.pinned;
  // type / todoStatus 看 isGroupAdmin: 是群管理员/群主则放行, 否则剥
  if (!isGroupAdmin) {
    delete data.type;
    delete data.todoStatus;
  }
  // visibility / sharedGroupIds / editPermission 已在 PR #5/5b 拦截
}
```

### 群组批量操作

- 普通成员: 群组页隐藏多选按钮 (`isGroupAdmin || isMyNote` 才显示)
- 管理员/群主: 多选可选含别人的, 批量操作时按权限筛
  - 批量删: 自己的 + 我管理的群里别人的, 都删. toast "已删 N 条, 跳过 M 条无权限"
  - 批量改 category / tags: 仅自己的笔记生效, 别人的跳过
  - 批量改 type / todoStatus: 自己的 + 群里别人的 (我是管理员/群主) 都生效

### "私密" 字面改 "私人"

编辑器底部分享设置里"私密 / 共享"中的"私密"统一改"私人" (语义更软). 影响 RichEditor.vue / NoteEditModal.vue / Settings.vue (如果有) 等少量文案.

### 作者删 fork 版给提示

作者通过自己列表看到 fork 出来的版本 (parentNoteId 非空) 想删时, 弹特殊确认: 
"这个版本由 @B @C 编辑过, 共 N 处修改. 确认删除？"
跟现有"确认删 @张三 的笔记"弹窗模式一致, 但是给作者看的.

### 自测清单

- tsc 双 EXIT=0
- 后端 PATCH 守卫: sqlite 构造数据后用 curl 模拟非作者 PATCH 传 tags / category → 应静默忽略
- chrome-devtools 注入检查: NoteCard 三点菜单按钮 v-if 跟 isMyNote / isGroupAdmin 联动正确
- 后端 POST /:id/duplicate: curl 调用看返回的副本 note 字段正确

### 手测清单

1. **作者本人在自己 NoteCard 上**: 三点菜单全显示 (含主页置顶 / 编辑 / 标完成 / 设提醒 / 另存为 / 多选 / 删除)
2. **群成员看群里别人笔记** (普通 member 角色): 隐藏 "主页置顶" / "标完成" / "设群提醒" / "多选" / "删除"; 显示 "编辑" "设提醒" (个人) "另存为"
3. **群管理员/群主**看群里别人笔记: 隐藏 "主页置顶"; 显示其余全部 (含"设群提醒"/"多选"/"删除")
4. **点"另存为"**: 副本出现在自己列表, type 跟原一致, 正文开头有"原作者: @xxx"
5. **没编辑权的人点"编辑"**: 弹"申请编辑权"对话框 (不是直接进编辑器)
6. **作者删自己 fork 出去的版本**: 弹"这个版本由 @B @C 编辑过, N 处修改"特殊确认

---

## PR #10 通知中心 (pending)

**目标**: 加全局通知系统, 集中所有"用户该被告知"的事件. OS 通知 + 通知页双保险, 不再依赖 toast 一闪而过.

### 数据库表设计

```sql
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id), -- 收件人
  category TEXT NOT NULL, -- 'content' / 'reminder' / 'group' (对应 UI 的 3 个 tab)
  type TEXT NOT NULL, -- 'edit-request' / 'edit-request-approved' / 'duplicated' / 'reminder-due' / 'group-reminder-due' / 'note-deleted-by-admin' / 'comment-added' / 'comment-replied' / 'group-join-request' / 'group-joined' / 'group-removed' / 'group-promoted' / 'group-demoted' / 'group-dissolved' / 'fork-by-other' 等
  title TEXT NOT NULL, -- 通知标题, 显示在卡片
  body TEXT, -- 详情, 可选
  payload TEXT, -- JSON, 跳转/动作用 (含 noteId / groupId / fromUserId 等)
  read_at TEXT, -- NULL = 未读
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id, read_at) WHERE read_at IS NULL;
```

### 后端 API

- `GET /api/notifications?category=&page=&limit=` 列通知 (按 category 过滤, 时间倒序)
- `GET /api/notifications/unread-count` 拉未读数 (左上角图标徽章用)
- `POST /api/notifications/:id/read` 标已读
- `POST /api/notifications/read-all` 一键全标已读
- `DELETE /api/notifications/:id` 删一条
- `DELETE /api/notifications` 清空 (含 query `?category=`)

### 后端 helper

`createNotification(userId, category, type, title, body, payload)`: 写表 + SSE publish `notification-new` 给该用户 (前端通知页 + 徽章自动更新).

### 接入点 (替换现有 SSE / toast)

| 事件 | 旧实现 | 新实现 |
|---|---|---|
| 提醒到点 (reminder-due) | reminder/sender.ts publish `reminder` SSE → 前端 OS Notification + toast | 仍 OS Notification, 但额外 `createNotification(userId, 'reminder', ...)` 写一条 |
| 群提醒到点 (group-reminder-due) | (PR #11 新加) | 给群里 active 成员 (含订阅开启的) 各 `createNotification` 一条 |
| 申请编辑权 (edit-request) | PR #5b toast 给作者+admin | `createNotification` 给作者+admin, 同时仍 OS Notification (作者期望立即知道) |
| 申请审批结果 (edit-request-resolved) | PR #5b toast 给申请人 | `createNotification` 给申请人 |
| 被另存为 (duplicated) | PR #9 toast 给原作者 | `createNotification` 给原作者 |
| 笔记被群管理员删 (note-deleted-by-admin) | (没有) | `createNotification` 给作者 |
| 笔记被别人 fork (fork-by-other) | (没有) | `createNotification` 给作者 (告知该笔记在 X 群被 @Y fork 走了) |
| 评论我的笔记 (comment-added) | PR #6 SSE → CommentThread 增量 | 额外 `createNotification` 给作者. 评论自己创的 thread 给其他评论者. reaction 不进通知 (频率太高) |
| 群里有人申请加入 (group-join-request) | PR #1 SSE → owner toast | `createNotification` 给 owner + admin |
| 我被加入新群 (group-joined) | (没有) | `createNotification` 给新成员 |
| 我被踢出群 (group-removed) | (没有) | `createNotification` |
| 被任命管理员 (group-promoted) | (没有) | `createNotification` |
| 取消管理员 (group-demoted) | (没有) | `createNotification` |
| 群被解散 (group-dissolved) | (没有) | `createNotification` 给所有 active 成员 |

### 前端 view

新加 `views/Notifications.vue` 路由 `/notifications`. 跟 Resources.vue 同款顶部布局:
- 标题 "消息通知" + 未读数量 + 刷新按钮 (没搜索框)
- 4 个 tab: 全部 / 内容 / 提醒 / 群组 (UI 同 Resources 的 type 切换)
- 列表: 一行一条通知, 含 icon (按 type) + title + body 截断 + 时间 + 未读小圆点
- 点击通知: 跳到关联资源 (noteId 跳 NoteDetail, groupId 跳 GroupDetail) + 标已读
- 右键 (或长按) 单条: 删除 / 标已读
- 顶部"全标已读" / "清空当前 tab" 按钮

### 入口

左上角头像点击展开的用户菜单, 在"传输列表"按钮**上方**加一行: "消息通知 [N]" (徽章显示未读数). 点击调 `router.push('/notifications')`.

### SSE 接入

`utils/sse.ts` 新加 `notification-new` handler: 派 window 事件 → 通知页监听 reload + 徽章自动更新.

### 自测清单

- tsc 双 EXIT=0
- 后端启动 schema migration
- sqlite 模拟插入几条通知 → GET /api/notifications 返回正确
- 前端通知页空状态 + 加载状态 UI 正确

### 手测清单

1. 用 A 账号给 B 共享笔记, B 申请编辑权 → A 通知页"内容"tab 收到一条
2. 设个 2 分钟后的提醒 → 到点 OS 弹通知 + 通知页"提醒"tab 多一条
3. C 把 B 拉进群 → B 通知页"群组"tab 多"被加入新群"
4. 标记已读 → 徽章数字减 1
5. 点击通知 → 跳对应笔记/群

---

## PR #11 提醒分家 (pending)

**目标**: 把现在挂在 notes.todo_due 上的"作者私域提醒"模式改成: 每个人对每个笔记都能设自己的私人提醒 (含非作者); 群管理员/群主额外可设"群提醒"群里所有人收.

### 概念

- **个人提醒**: 任何用户对任何笔记都能设. 多对多关系. 别人看不到. 笔记删了也响 (蘑菇决策: 待办被删除时发通知告知"提醒失效").
- **群提醒**: 群主/管理员对某共享笔记设 (笔记必须在该群里 share). 群所有 active 成员 (且开启接收开关的) 都收. 公开可见 (谁设的写在通知里).

### 数据库表

```sql
-- 个人提醒 (替代 notes.todo_due / todo_remind_rrule / todo_remind_sent_at 三列)
CREATE TABLE note_personal_reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  note_id TEXT NOT NULL REFERENCES notes(id),
  due_at TEXT NOT NULL, -- ISO datetime
  rrule TEXT, -- RFC 5545 RRULE 字符串, NULL = 单次
  remind_sent_at TEXT, -- 防重发
  created_at TEXT NOT NULL,
  UNIQUE (user_id, note_id) -- 一个用户对一个笔记最多 1 条
);
CREATE INDEX idx_personal_reminders_due ON note_personal_reminders(due_at) WHERE remind_sent_at IS NULL;

-- 群提醒
CREATE TABLE note_group_reminders (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  due_at TEXT NOT NULL,
  rrule TEXT,
  remind_sent_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id), -- 谁设的, 通知里显示
  created_at TEXT NOT NULL,
  UNIQUE (note_id, group_id) -- 一个笔记在一个群最多 1 条群提醒
);
CREATE INDEX idx_group_reminders_due ON note_group_reminders(due_at) WHERE remind_sent_at IS NULL;

-- 群提醒接收开关 (每用户每群可关)
CREATE TABLE group_reminder_subscriptions (
  user_id TEXT NOT NULL REFERENCES users(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  enabled INTEGER NOT NULL DEFAULT 1, -- 默认接收
  PRIMARY KEY (user_id, group_id)
);
```

### 数据迁移

启动时把现有 notes 里有 todo_due 的, 写一条对应的 note_personal_reminders (user_id = 作者):
```sql
INSERT INTO note_personal_reminders (id, user_id, note_id, due_at, rrule, remind_sent_at, created_at)
SELECT nanoid12(), user_id, id, todo_due, todo_remind_rrule, todo_remind_sent_at, datetime('now')
FROM notes WHERE todo_due IS NOT NULL;
```
(nanoid12 需要在 JS 层生成, SQL 里不行, 实际用 better-sqlite3 拉数据 → JS 循环 INSERT).

迁移完成后: notes 表里 todo_due / todo_remind_sent_at / todo_remind_rrule 三列**保留不删** (避免破坏老客户端读), 但新版后端不再写它们. 未来某个 PR 才彻底删.

### Scheduler 重构

`packages/server/src/reminder/scheduler.ts` 当前扫 notes.todo_due. 改成: 同时扫 note_personal_reminders 跟 note_group_reminders 两张表.

- 个人提醒: 命中 → publish `reminder` SSE 给该 user_id (前端弹 OS 通知) + PR #10 接入 `createNotification(userId, 'reminder', ...)` 写通知
- 群提醒: 命中 → 拉群里所有 active 成员 + 该用户开了 group_reminder_subscriptions.enabled → 给每个 user_id 同上处理
- 笔记被软删 (deleted_at NOT NULL): 提醒**仍然扫得到但不发**, 改成 `createNotification(userId, 'reminder', '待办已被删除, 提醒失效')` 标记发过. RRULE 重复的也只发一次"失效"通知, 然后从表里删

### NoteCard 三点菜单变化

- 普通成员 (含 grants): 「设置提醒」(个人) — 调 `POST /api/notes/:id/personal-reminder`
- 群管理员/群主: 「设置提醒」+「设置群提醒」两个 — 群提醒调 `POST /api/notes/:id/group-reminder?groupId=`

### GroupDetail 加群提醒接收开关

群详情页 (`packages/web/src/components/GroupDetail.vue`) 在公告下面加一个开关: "接收本群提醒" (默认开). 调 `PATCH /api/groups/:id/reminder-subscription` 改.

### API

- `POST /api/notes/:id/personal-reminder` body `{ dueAt, rrule? }` (个人)
- `DELETE /api/notes/:id/personal-reminder`
- `POST /api/notes/:id/group-reminder` body `{ groupId, dueAt, rrule? }` (群管理员)
- `DELETE /api/notes/:id/group-reminder?groupId=`
- `GET /api/notes/:id/reminders` 拉某笔记的所有提醒 (自己的个人 + 我所在群的群提醒) 给 NoteCard 显示用
- `PATCH /api/groups/:id/reminder-subscription` body `{ enabled }`
- `GET /api/groups/:id/reminder-subscription`

### NoteCard 提醒图标显示

原来铃铛只显示作者的 todoDue. 改成: 任何用户看 NoteCard 时, 铃铛显示:
- 优先级: 我的个人提醒 > 我所在群的群提醒 > 没提醒不显示
- title hover 显示提醒来源 (个人 / 群名)

### 自测清单

- tsc 双 EXIT=0
- 数据迁移: sqlite 查 note_personal_reminders 应跟原 notes.todo_due 一一对应
- scheduler 重构后扫 2 张表逻辑正确 (sqlite 插入 past due 的 reminder 看是否 publish 出来)

### 手测清单

1. A 给 B 共享待办笔记 → B 点 NoteCard 三点菜单 → 应有"设置提醒" (个人)
2. B 设个人提醒 2 分钟后 → 到点 B 收 OS 通知, A 不收
3. A 把 B 升级管理员 → B 再开 NoteCard 三点菜单 → 应多出"设置群提醒"
4. B 设群提醒 → 群里 A 跟其它成员都收到 OS 通知
5. B 在群详情页关闭"接收本群提醒" → 群提醒到点 B 不收 OS 通知 (但通知页可能仍有? 跟 PR #10 联调时决定)
6. A 删除该笔记 → B 收"待办已被删除, 提醒失效"通知

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
