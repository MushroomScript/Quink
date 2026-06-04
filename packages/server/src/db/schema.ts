import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // nanoid
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  nickname: text('nickname').notNull(),
  avatar: text('avatar'), // URL or base64
  preferences: text('preferences', { mode: 'json' }).$type<Record<string, any>>().default({}),
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
  type: text('type', { enum: ['note', 'todo', 'snippet', 'link'] }).notNull().default('note'),
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
  createdAt: text('created_at').notNull(),
});

// 复合主键 (groupId, userId): 一个用户在一个群最多一条记录. status='removed' 保留审计痕迹, 不物理删
export const groupMembers = sqliteTable('group_members', {
  groupId: text('group_id').notNull().references(() => groups.id),
  userId: text('user_id').notNull().references(() => users.id),
  role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull().default('member'),
  status: text('status', { enum: ['active', 'removed'] }).notNull().default('active'),
  joinedAt: text('joined_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.groupId, table.userId] }),
}));

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

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type GroupMember = typeof groupMembers.$inferSelect;
export type NewGroupMember = typeof groupMembers.$inferInsert;
export type GroupJoinRequest = typeof groupJoinRequests.$inferSelect;
export type NewGroupJoinRequest = typeof groupJoinRequests.$inferInsert;
export type GroupRole = GroupMember['role'];

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
export type NewNoteShare = typeof noteShares.$inferInsert;
export type NoteVisibility = Note['visibility'];
export type ReminderChannel = typeof reminderChannels.$inferSelect;
export type NewReminderChannel = typeof reminderChannels.$inferInsert;
export type ReminderChannelType = ReminderChannel['type'];
