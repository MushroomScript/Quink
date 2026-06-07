import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // nanoid
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  nickname: text('nickname').notNull(),
  avatar: text('avatar'), // URL or base64
  preferences: text('preferences', { mode: 'json' }).$type<Record<string, any>>().default({}),
  // 安全审计 M2: token 版本号. 改密码 / 主动登出所有设备 时 ++ → 旧 token 立即失效.
  // JWT 长效不变 (蘑菇拍板"不希望用一阵就重新登陆"), 仅改密码需要让旧 token 失效
  tokenVersion: integer('token_version').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(), // nanoid
  userId: text('user_id').notNull().references(() => users.id),
  content: text('content').notNull(),
  // 全拼 + 首字母拼接串(toPinyinSearchable 生成),让搜索框支持拼音输入"zb/zhoubao"命中"周报"
  contentPinyin: text('content_pinyin'),
  summary: text('summary'),
  category: text('category'), // e.g. "编程/踩坑记录"
  tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
  // PR #8 命名重整 (2026-06-06): type 字段值重新对齐 UI. 历史 quirk 已修正:
  // quink=灵感页 (原'note'), note=笔记页 (原'snippet'), todo=待办页 (不变). link 类型废弃删除.
  type: text('type', { enum: ['quink', 'note', 'todo'] }).notNull().default('quink'),
  todoStatus: text('todo_status', { enum: ['pending', 'done'] }),
  todoDue: text('todo_due'), // ISO datetime, 复用为"提醒时间"。到此刻 scheduler 触发推送。
  todoRemindSentAt: text('todo_remind_sent_at'), // 上次发送时间, 防重发。改 todoDue 时由 PATCH 重置为 null
  todoRemindRrule: text('todo_remind_rrule'), // RFC 5545 RRULE 字符串, null = 单次提醒
  aiProcessed: integer('ai_processed', { mode: 'boolean' }).notNull().default(false),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'), // 软删除时间，null 表示未删除
  // PR #2 群组共享: 'private' 仅作者可见; 'shared' 走 note_shares 表关联到指定群
  visibility: text('visibility', { enum: ['private', 'shared'] }).notNull().default('private'),
  // PR #5 编辑锁: 仅 shared 笔记走锁逻辑 (private 不需要协作所以不锁). 4 列联动:
  // editLockBy 当前持锁用户 id, null = 无锁; editLockToken 申请时 nanoid 生成, PATCH 必须匹配 (防同用户多设备冲突);
  // editLockExpiresAt ISO datetime 5 分钟过期, cron 60s 扫清; version 乐观锁兜底, server 重启等极端 case 锁失效时拒绝旧版本提交
  editLockBy: text('edit_lock_by').references(() => users.id),
  editLockToken: text('edit_lock_token'),
  editLockExpiresAt: text('edit_lock_expires_at'),
  version: integer('version').notNull().default(1),
  // PR #5b 编辑权限分级: shared 笔记加这字段控制谁能改, private 笔记忽略 (作者直接改).
  // 'admin' (默认) = 群 owner + admin 能改; 'all' = 所有 active member 能改. 作者本人永远能改.
  // 没权限的可申请加入 note_edit_grants 白名单 (永久授权)
  editPermission: text('edit_permission', { enum: ['admin', 'all'] }).notNull().default('admin'),
  // PR #7 COW 分叉模型: 共享笔记被非作者改 / 作者从群组页改时触发 fork, 新建一行 parent_note_id 指向原始 root.
  // root note 该字段 NULL; fork 出来的 child note 指向其 root note id (单层链, 不嵌套 fork-of-fork).
  // 跟 noteComments.parentId / folders.parentId / categories.parentId 同款约定不加 drizzle references 自引用,
  // SQLite 层一致弱约束 (业务保证只往 root 指, 不构造循环).
  // 7a 阶段仅加字段不动 PATCH 逻辑, 等 7b fork 写入逻辑接入.
  parentNoteId: text('parent_note_id'),
});

// PR #2 群组共享: 笔记 → 群组多对多. 一条笔记可分享到多个群, 删 group_members 不影响共享
// (member 被踢出群后看不到, 但作者重新加群能恢复可见性). 作者软删笔记不动 note_shares 保留意图
export const noteShares = sqliteTable('note_shares', {
  noteId: text('note_id').notNull().references(() => notes.id),
  groupId: text('group_id').notNull().references(() => groups.id),
  // 分享时间, 群组 feed 默认按这个 DESC 排序 (最近被分享冲顶), 而不是笔记 createdAt
  sharedAt: text('shared_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.noteId, table.groupId] }),
}));

// PR #5b 编辑权限白名单: 申请编辑权通过后写一条, 永久授权 (跟 group_members 一样属于"成员关系"模型).
// 作者 / admin 可撤销 (DELETE) 让该 user 回到没权限状态. 笔记被永久删除时 cascade 清.
export const noteEditGrants = sqliteTable('note_edit_grants', {
  noteId: text('note_id').notNull().references(() => notes.id),
  userId: text('user_id').notNull().references(() => users.id),
  grantedAt: text('granted_at').notNull(),
  grantedBy: text('granted_by').notNull().references(() => users.id), // 批准人 (作者或群 admin)
}, (table) => ({
  pk: primaryKey({ columns: [table.noteId, table.userId] }),
}));

// PR #5b 编辑权限申请: 没 write 权限的群成员可申请, 作者+群 admin 都能批. 通过后写 noteEditGrants 表.
// status 保留历史: 'pending' / 'approved' / 'rejected' / 'canceled' (申请人主动撤回)
export const noteEditRequests = sqliteTable('note_edit_requests', {
  id: text('id').primaryKey(), // nanoid
  noteId: text('note_id').notNull().references(() => notes.id),
  userId: text('user_id').notNull().references(() => users.id), // 申请人
  status: text('status', { enum: ['pending', 'approved', 'rejected', 'canceled'] }).notNull().default('pending'),
  message: text('message'), // 申请理由 (可选)
  createdAt: text('created_at').notNull(),
  handledAt: text('handled_at'),
  handledBy: text('handled_by').references(() => users.id), // 处理人 (作者或群 admin)
});

// PR #6 表情 reaction: 群共享笔记上的快速表态. 复合主键 (note_id, user_id, emoji) 保证每人每 emoji 最多 1 条.
// emoji 字段为前端固定 5 个之一 (后端白名单校验), 防极端搞怪与垃圾数据. 取消 = 直接 DELETE 行 (无审计需求, 不做软删)
export const noteReactions = sqliteTable('note_reactions', {
  noteId: text('note_id').notNull().references(() => notes.id),
  userId: text('user_id').notNull().references(() => users.id),
  emoji: text('emoji').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.noteId, table.userId, table.emoji] }),
}));

// PR #6 评论 thread: 共享笔记下挂评论, parent_id 单层 thread (二层及以下 normalize 到根 parent).
// 软删 deleted_at: 删除后前端直接隐藏 (不像 notes 走 30 天回收站, 评论不需要恢复入口). 计数也不算.
// parent_id 不加 drizzle references 自引用 (跟 categories/folders 同款约定保持一致, SQLite 层强约束在 db/index.ts)
export const noteComments = sqliteTable('note_comments', {
  id: text('id').primaryKey(), // nanoid
  noteId: text('note_id').notNull().references(() => notes.id),
  userId: text('user_id').notNull().references(() => users.id),
  parentId: text('parent_id'), // 单层 thread: 顶层评论 null; 一级回复 = 顶层 id; 二级及以下也存顶层 id (后端 normalize)
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const categories = sqliteTable('categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  parentId: integer('parent_id'),
  icon: text('icon'),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  filename: text('filename').notNull(),
  // 历史 displayName 列表(JSON 数组),重命名时把旧名追加。让笔记里 label 是"曾经的文件名"也能识别为可同步
  filenameHistory: text('filename_history'),
  url: text('url').notNull(),
  mimeType: text('mime_type').notNull(),
  category: text('category').notNull(), // image, audio, document
  size: integer('size').notNull(),
  // folderId: null = 根目录, 非 null = 在指定文件夹内 (嵌套树状, folders.parentId 递归)
  folderId: text('folder_id'),
  createdAt: text('created_at').notNull(),
});

// 嵌套文件夹: parentId null = 根目录的文件夹, 非 null = 子文件夹 (递归)
export const folders = sqliteTable('folders', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  parentId: text('parent_id'), // 嵌套支持: 自引用
  createdAt: text('created_at').notNull(),
});

export const aiConfigs = sqliteTable('ai_configs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  provider: text('provider').notNull(), // openai, claude, ollama, custom
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key'),
  model: text('model').notNull(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
});

export const aiPrompts = sqliteTable('ai_prompts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  feature: text('feature').notNull(), // auto_tag, auto_classify, polish, expand, write, chat
  prompt: text('prompt').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const config = sqliteTable('config', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }),
});

export const aiConversations = sqliteTable('ai_conversations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  title: text('title').notNull().default('新对话'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const aiMessages = sqliteTable('ai_messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => aiConversations.id),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  sources: text('sources', { mode: 'json' }).$type<string[]>().default([]),
  createdAt: text('created_at').notNull(),
});

// 提醒通道: 每行一个 channel (browser / email / bark / wecom_bot / dingtalk_bot / feishu_bot / telegram / webhook)
// config JSON 各 type 字段不同 (email: smtp_host/port/user/pass/from/to; bark: url; webhook: url/method/headers; telegram: bot_token/chat_id; ...)
export const reminderChannels = sqliteTable('reminder_channels', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  type: text('type', { enum: ['browser', 'email', 'bark', 'wecom_bot', 'dingtalk_bot', 'feishu_bot', 'telegram', 'webhook'] }).notNull(),
  name: text('name').notNull(),
  config: text('config', { mode: 'json' }).$type<Record<string, any>>().notNull().default({}),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
});

// browser channel 离线时挂起的提醒. user SSE ready 时补送 (Q1: 防离线丢; Q2: sent_at 防重复).
// 只追 browser channel (其他 channel: email/bark/webhook 不依赖在线连接, 发完就送达)
export const reminderPending = sqliteTable('reminder_pending', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  // JSON {noteId, title, body, remindAt} — 跟 sse 事件 payload 一致, ready 时 write 'reminder' event 直接吐
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull(),
  // 上线推送后标. 多端登录时 atomic update 保证只推一次 (where sent_at IS NULL)
  sentAt: text('sent_at'),
});

export const voiceTranscriptions = sqliteTable('voice_transcriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  audioUrl: text('audio_url').notNull(),
  text: text('text').default(''),
  status: text('status', { enum: ['pending', 'done', 'failed'] }).notNull().default('pending'),
  createdAt: text('created_at').notNull(),
});

// 群组共享 PR #1: 用户可建群组邀请别人加入, 后续 PR 用 note_shares 决定笔记可见性
export const groups = sqliteTable('groups', {
  id: text('id').primaryKey(), // nanoid
  ownerId: text('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  avatar: text('avatar'), // 复用 uploads/ 文件 URL 或 null
  // 当前有效邀请 token (重置后旧 token 立即失效). null = 邀请关闭
  inviteToken: text('invite_token'),
  inviteExpiresAt: text('invite_expires_at'), // ISO datetime, null = 永不过期
  // 0 = 申请审批模式 (默认, owner SSE 收申请), 1 = 自动加入模式 (信任圈子)
  autoJoin: integer('auto_join', { mode: 'boolean' }).notNull().default(false),
  // 群公告 (markdown), 全群只 1 条, owner/admin 可编辑
  announcement: text('announcement'),
  announcementUpdatedAt: text('announcement_updated_at'),
  announcementUpdatedBy: text('announcement_updated_by').references(() => users.id),
  createdAt: text('created_at').notNull(),
});

// 复合主键 (groupId, userId): 一个用户在一个群最多一条记录. status='removed' 保留审计痕迹, 不物理删
export const groupMembers = sqliteTable('group_members', {
  groupId: text('group_id').notNull().references(() => groups.id),
  userId: text('user_id').notNull().references(() => users.id),
  role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull().default('member'),
  status: text('status', { enum: ['active', 'removed'] }).notNull().default('active'),
  // 安全审计 S6: 在该群隐身. true 时本人上下线不给群其他成员推 presence-changed,
  // 但隐身用户仍正常收所有事件 (笔记变更 / 评论 / 申请通知 等). 蘑菇明示"隐身不影响收提示消息"
  hidePresence: integer('hide_presence', { mode: 'boolean' }).notNull().default(false),
  joinedAt: text('joined_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.groupId, table.userId] }),
}));

// 操作审计日志 (蘑菇 2026-06-07 拍板): 所有写 endpoint 关键位置记录, 文本字段为主, 占空间不大
// 不分级, 全部 INFO 级别. 攻击追溯 / 用户自查"我啥时候改过啥"双用. 当前不暴露 admin 界面, 后续加 /api/admin/audit-logs
export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),    // 不加 FK 防用户删除时影响审计
  action: text('action').notNull(),     // e.g. 'note.create' / 'note.delete' / 'group.kick' / 'auth.login' / 'auth.password_change'
  targetType: text('target_type'),      // e.g. 'note' / 'group' / 'user' / 'comment'
  targetId: text('target_id'),
  meta: text('meta', { mode: 'json' }).$type<Record<string, any>>(),
  ip: text('ip'),
  createdAt: text('created_at').notNull(),
});

// 申请加入记录: pending → owner 审批 → approved/rejected. cancelled = 申请人主动撤回
export const groupJoinRequests = sqliteTable('group_join_requests', {
  id: text('id').primaryKey(), // nanoid
  groupId: text('group_id').notNull().references(() => groups.id),
  userId: text('user_id').notNull().references(() => users.id),
  status: text('status', { enum: ['pending', 'approved', 'rejected', 'cancelled'] }).notNull().default('pending'),
  inviteToken: text('invite_token'), // 申请时用的 token (审计用, 后续 token 重置不影响历史记录)
  createdAt: text('created_at').notNull(),
  handledAt: text('handled_at'), // owner 处理时间
  handledBy: text('handled_by').references(() => users.id), // 谁处理的 (owner 或 admin)
});

// PR #7 COW 修改历史: 每次共享笔记被编辑写一条 (作者改不算, 不然历史会被自己 spam),
// 给 UI "原作者发布 · @B、@C 编辑过" 用. 不带 content snapshot (空间换简洁, 只记 who+when).
// note 被永久删除时 cascade 清. 不软删 (历史无恢复需求).
export const noteEditHistory = sqliteTable('note_edit_history', {
  id: text('id').primaryKey(), // nanoid
  noteId: text('note_id').notNull().references(() => notes.id),
  userId: text('user_id').notNull().references(() => users.id),
  editedAt: text('edited_at').notNull(),
});

// 群内独立置顶: 复合主键 (groupId, noteId), 每个群每条笔记最多 1 条. 跟 notes.pinned (作者全局置顶) 完全独立.
// A 群置顶不影响 B 群 / 作者个人页. 权限: owner/admin 可操作 (避免普通成员误置顶刷屏)
export const groupNotePins = sqliteTable('group_note_pins', {
  groupId: text('group_id').notNull().references(() => groups.id),
  noteId: text('note_id').notNull().references(() => notes.id),
  pinnedBy: text('pinned_by').notNull().references(() => users.id),
  pinnedAt: text('pinned_at').notNull(), // ISO datetime, 多条置顶按时间 DESC (最新置顶冲顶)
}, (table) => ({
  pk: primaryKey({ columns: [table.groupId, table.noteId] }),
}));

// PR #10 通知中心: 集中所有"用户该被告知"的事件 (申请编辑权 / 另存为 / 提醒到点 / 群组变更 / 评论等),
// 不再依赖 toast 一闪而过. category 对应 UI 3 tab, type 是具体事件名 (字符串不 enum 防后续扩字段时全表 ALTER).
// payload 存 JSON 给"点击通知跳关联资源"用 (noteId / groupId / fromUserId 等). read_at NULL=未读, 标已读时填 ISO datetime
export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(), // nanoid
  userId: text('user_id').notNull().references(() => users.id), // 收件人 (不是事件触发者)
  category: text('category', { enum: ['content', 'reminder', 'group'] }).notNull(),
  type: text('type').notNull(), // 'edit-request' / 'duplicated' / 'reminder-due' / 'group-joined' 等 (字符串非 enum, 加新 type 不用迁移)
  title: text('title').notNull(), // 通知卡片标题
  body: text('body'), // 详情, 可选
  payload: text('payload', { mode: 'json' }).$type<Record<string, any>>().default({}), // 跳转/动作用 (noteId/groupId/fromUserId 等)
  readAt: text('read_at'), // NULL = 未读
  createdAt: text('created_at').notNull(),
});

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type GroupMember = typeof groupMembers.$inferSelect;
export type NewGroupMember = typeof groupMembers.$inferInsert;
export type GroupJoinRequest = typeof groupJoinRequests.$inferSelect;
export type NewGroupJoinRequest = typeof groupJoinRequests.$inferInsert;
export type GroupRole = GroupMember['role'];
export type GroupNotePin = typeof groupNotePins.$inferSelect;
export type NewGroupNotePin = typeof groupNotePins.$inferInsert;
export type NoteEditHistory = typeof noteEditHistory.$inferSelect;
export type NewNoteEditHistory = typeof noteEditHistory.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type FileRecord = typeof files.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type AiConfig = typeof aiConfigs.$inferSelect;
export type AiPrompt = typeof aiPrompts.$inferSelect;
export type AiConversation = typeof aiConversations.$inferSelect;
export type AiMessage = typeof aiMessages.$inferSelect;
export type VoiceTranscription = typeof voiceTranscriptions.$inferSelect;
export type ReminderPending = typeof reminderPending.$inferSelect;
export type NewReminderPending = typeof reminderPending.$inferInsert;
export type NoteShare = typeof noteShares.$inferSelect;
export type NoteEditGrant = typeof noteEditGrants.$inferSelect;
export type NewNoteEditGrant = typeof noteEditGrants.$inferInsert;
export type NoteEditRequest = typeof noteEditRequests.$inferSelect;
export type NewNoteEditRequest = typeof noteEditRequests.$inferInsert;
export type NoteReaction = typeof noteReactions.$inferSelect;
export type NewNoteReaction = typeof noteReactions.$inferInsert;
export type NoteComment = typeof noteComments.$inferSelect;
export type NewNoteComment = typeof noteComments.$inferInsert;
export type NewNoteShare = typeof noteShares.$inferInsert;
export type NoteVisibility = Note['visibility'];
export type ReminderChannel = typeof reminderChannels.$inferSelect;
export type NewReminderChannel = typeof reminderChannels.$inferInsert;
export type ReminderChannelType = ReminderChannel['type'];
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationCategory = Notification['category'];
