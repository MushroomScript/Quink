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
| **#4 SSE 拓展 + AI 共享上下文** | AI RAG 拉笔记范围扩到群组 (SSE note-shared 群播已在 PR #2 一起做了) | 🔜 next | ~100 行 (变少了, SSE 部分已 done) |
| **#5 编辑锁（极简）** | lock/heartbeat/release API + 心跳 + sendBeacon + 提示 toast + version 校验 | pending | ~350 行 |
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

## PR #4 SSE 群播 + AI 共享上下文

### SSE 事件

- `note-shared`: 别人在群里发新笔记 → 推给所有群成员 → 前端 loadGroupNotes 刷 feed
- `note-updated`: 共享笔记被作者修改 → 推给群成员 → refreshSingleNote
- `note-deleted`: 作者删共享笔记 → 推给群成员 → splice 移除

### AI 上下文扩展

`packages/server/src/ai/` 内所有 `getNotes` / chat RAG 查询：

```ts
// 之前: WHERE user_id = me
// 改成: WHERE user_id = me OR id IN (note_shares where my groups)
```

让 AI 问 "上周咱们小组开会决定了什么" 能拿到群组共享笔记。

### 影响范围

- `ai-config.ts` 的 transcribe / polish 等只看作者自己（不动）
- `ai-chat.ts` 的 RAG 查询要扩到群组
- 自动打标签 / 自动分类（processNoteWithAi）只看作者自己（不动，私域操作）

---

## PR #5 编辑锁（极简版，蘑菇否决申请编辑权后简化）

### Schema 改动

```sql
ALTER TABLE notes ADD COLUMN edit_lock_by TEXT REFERENCES users(id);
ALTER TABLE notes ADD COLUMN edit_lock_expires_at TEXT;
ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
```

### 锁参数（蘑菇拍板）

- **5 分钟过期** + **30s 心跳** 续约
- 离开页面 → `navigator.sendBeacon('DELETE /lock')` 立即释放
- 5 分钟不续约 → server 定时清锁兜底

### API

```
POST   /notes/:id/lock          申请 → 返回 lockToken + expiresAt (5min)
POST   /notes/:id/lock/heartbeat  续约 (30s 一次)
DELETE /notes/:id/lock          释放 (sendBeacon)
PATCH  /notes/:id               提交时带 lockToken + version, server 校验 + version++ + 自动清锁
```

### 前端

- `NoteEditModal` / `RichEditor` 进入时调 POST /lock
  - 拿不到（409 别人持锁）→ 弹 toast「@A 正在编辑, 预计还有 N 分钟, 刷新后再试」, 编辑器不打开
  - 拿到 → 启心跳 setInterval(30s) + onBeforeUnmount sendBeacon
- 提交时带 lockToken + version → 409 (已过期/被抢) → toast 提示

### 冲突防御

- **同时刻只能一人持锁** → 串行化写入, 没有"覆盖"问题
- **乐观锁兜底**: 万一锁机制失效（server 重启清锁等极端 case）, version 校验拒绝旧版本提交

### 蘑菇明确否决的方案

- ❌ **申请编辑权 + owner 同意** 流程: 编辑频率太高干扰
- ❌ **协同编辑（CRDT/OT）**: Vditor 集成 yjs 工程量极大, 不做第一版

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
