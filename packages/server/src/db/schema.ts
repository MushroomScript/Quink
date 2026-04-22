import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

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
  summary: text('summary'),
  category: text('category'), // e.g. "编程/踩坑记录"
  tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
  type: text('type', { enum: ['note', 'todo', 'snippet', 'link'] }).notNull().default('note'),
  todoStatus: text('todo_status', { enum: ['pending', 'done'] }),
  todoDue: text('todo_due'), // ISO date string
  aiProcessed: integer('ai_processed', { mode: 'boolean' }).notNull().default(false),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'), // 软删除时间，null 表示未删除
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
  url: text('url').notNull(),
  mimeType: text('mime_type').notNull(),
  category: text('category').notNull(), // image, audio, document
  size: integer('size').notNull(),
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

export const voiceTranscriptions = sqliteTable('voice_transcriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  audioUrl: text('audio_url').notNull(),
  text: text('text').default(''),
  status: text('status', { enum: ['pending', 'done', 'failed'] }).notNull().default('pending'),
  createdAt: text('created_at').notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type FileRecord = typeof files.$inferSelect;
export type AiConfig = typeof aiConfigs.$inferSelect;
export type AiPrompt = typeof aiPrompts.$inferSelect;
export type AiConversation = typeof aiConversations.$inferSelect;
export type AiMessage = typeof aiMessages.$inferSelect;
export type VoiceTranscription = typeof voiceTranscriptions.$inferSelect;
