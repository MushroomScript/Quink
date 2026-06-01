// 提醒系统共享类型

export interface ReminderPayload {
  noteId: string;
  title: string; // 通常 "提醒: <内容截短>"
  body: string;  // 笔记内容截短(去 markdown 装饰)
  remindAt: string; // ISO datetime, 触发时刻
}

export interface AdapterContext {
  userId: string;
  config: Record<string, any>;
  payload: ReminderPayload;
}

export type AdapterFn = (ctx: AdapterContext) => Promise<void>;
