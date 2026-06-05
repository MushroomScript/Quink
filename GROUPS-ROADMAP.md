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
| **#5b 编辑权限分级 + 申请流程** | 笔记加 edit_permission (admin/all 两档, 默认 admin) + 申请编辑权 API + admin 可删共享笔记 + 群组界面改权限 | pending | ~350 行 |
| **#5c scope preferences** | preferences.showSharedInMain 全局开关 (默认 false, 开后 3 主 view 显示共享笔记) + scope='all' 子查询 | pending | ~150 行 |
| **#6 表情 reaction + 评论** | note_reactions + note_comments thread + UI | pending | ~500 行 |

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

## PR #5b 编辑权限分级 + 申请流程（蘑菇决策已锁定）

PR #5 ship 后的延伸. 当前 PR #5 行为 = 所有群 active member 都能改共享笔记, 蘑菇要加权限分级 + 申请流程让作者能收紧.

### 权限两档（作者本人一直能改, 不算独立档）

- `admin`（默认） = 群 owner + admin 能改
- `all` = 所有 active member 能改

**注意 PR #5 默认是 `all`, PR #5b 把默认改为 `admin`**. 这是行为破坏式更新, dev 环境蘑菇自测, 不存在用户预期问题.

### Schema 改动

- `notes` 加 `edit_permission TEXT NOT NULL DEFAULT 'admin'`（enum: admin / all）
- 新表 `note_edit_grants`: (`note_id`, `user_id`, `granted_at`, `granted_by`)—— 申请通过后永久白名单
- 新表 `note_edit_requests`: (`id`, `note_id`, `user_id`, `status`, `created_at`, `handled_at`, `handled_by`)

### 鉴权扩展

`getNoteForAccess` 加 `mode='read'|'write'` 参数. write 模式额外校验 `edit_permission`:
- author_id = me → 永远放行
- `admin` + 我是该群 owner/admin → 放行
- `all` → 任何 active member 放行
- 在 `note_edit_grants` 白名单内 → 放行
- 否则 → 403（前端弹"申请编辑权"按钮）

PATCH /:id + chat `update_note` + DELETE /:id 都用扩展后的 helper.

### 申请流程 API

- `POST /api/notes/:id/edit-request` —— 申请编辑权（创建 pending request + SSE 推作者 + 群 admin）
- `POST /api/notes/:id/edit-request/:reqId/approve` —— 同意（作者 + 群 admin 都能批, 通过后写入 note_edit_grants + 删 request）
- `POST /api/notes/:id/edit-request/:reqId/reject` —— 拒绝
- `GET /api/notes/:id/edit-requests` —— 列待审申请（作者 + admin 看）

### admin 可删共享笔记

DELETE /api/notes/:id 当前限作者. 扩到 admin: getNoteForAccess(write mode) + visibility='shared'. admin 删别人的笔记弹"确认是否删除 @张三 的笔记"对话.

### 前端

- **编辑器界面不加权限 chip**（蘑菇明确: 保持编辑界面干净）
- 群组详情页笔记卡片右键 / 长按弹"修改编辑权限"（作者 + admin 能调）→ 弹 popover 选 admin/all
- 锁失败 toast 加"申请编辑权"按钮 → 调 POST .../edit-request → 提示"已发送"
- SSE `note-edit-request` 事件 → 作者 + admin 收实时提示 + desktop notification（跟 group-join-request 同款）
- 笔记设置入口（作者 + admin 看到）显示待审申请 + 已授权用户列表（能撤销）

### 决策锁定 ✓

- ✓ **申请通过后永久授权**（note_edit_grants）, 不是单次. 之前蘑菇否决"每次编辑都申请"是这意思
- ✓ **admin 跟 author 在权限上几乎等同**（改/删/批申请都行）, 唯一差异: admin 不能改 visibility / sharedGroupIds（仅作者控分享设置）
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

## PR #6 表情 reaction + 评论

### Schema

```sql
CREATE TABLE note_reactions (
  note_id TEXT NOT NULL REFERENCES notes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (note_id, user_id, emoji)
);

CREATE TABLE note_comments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  parent_id TEXT REFERENCES note_comments(id),  -- thread 支持
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### UI

- `NoteCard` 底部 reaction bar（共享笔记才显示）: 默认 emoji `👍 ❤️ 🤔 ✅`, 点击切换我自己的
- `NoteDetail` / `NoteEditModal` 加评论 thread 区
- SSE `note-reaction-changed` / `note-comment-added` 群播给群成员

---

## 扩展点子清单（PR #6 之后可选）

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
