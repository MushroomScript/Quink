// 提醒 SSE 客户端
// 连 /api/sse?token=xxx, 监听 'reminder' 事件 → 弹通知
// EventSource 不能传 Authorization header, 所以走 query token (跟 request() 用同一 quink_token)
// EventSource 内置自动重连 (默认 3s), 但 401 后会无限重连. 我们手动检测 401 → 主动 close

import { getAuthToken } from '@/api';

type ReminderEvent = {
  noteId: string;
  title: string;
  body: string;
  remindAt: string;
};

let es: EventSource | null = null;

// 用 Electron 原生通知 / 浏览器 Notification 显示提醒
function showNotification(data: ReminderEvent) {
  const desk = (window as any).quinkDesktop;
  if (desk?.showNotification) {
    // Electron IPC: 走主进程 new Notification, 比 renderer 的 Notification 更显眼 + 任务栏闪
    desk.showNotification({ title: data.title, body: data.body, noteId: data.noteId });
    return;
  }
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') {
    console.warn('[sse] 浏览器通知未授权, 跳过. 去 Settings > 提醒 申请权限');
    return;
  }
  try {
    const n = new Notification(data.title, { body: data.body, tag: data.noteId });
    n.onclick = () => {
      window.focus();
      // 点击通知 → 跳转到笔记详情
      window.location.href = `/note/${data.noteId}`;
    };
  } catch (e) {
    console.error('[sse] Notification 创建失败:', e);
  }
}

export function startReminderSse() {
  if (es) return; // 已连
  const token = getAuthToken();
  if (!token) return;

  const url = `/api/sse?token=${encodeURIComponent(token)}`;
  es = new EventSource(url);

  es.addEventListener('ready', () => {
    console.log('[sse] connected');
  });

  es.addEventListener('reminder', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as ReminderEvent;
      console.log('[sse] reminder received:', data);
      showNotification(data);
    } catch (e) {
      console.error('[sse] parse reminder failed:', e);
    }
  });

  // note-updated: scheduler 触发提醒后 publish, 让前端刷新单条 note 字段
  // (避免单次提醒发完后 todoRemindSentAt 后端有值前端不知道, 卡片仍显示"未提醒"态)
  es.addEventListener('note-updated', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { noteId: string };
      // 动态 import 避免 sse.ts 跟 store 形成静态循环依赖
      import('@/stores/notes').then(({ useNotesStore }) => {
        useNotesStore().refreshSingleNote(data.noteId);
      });
    } catch (e) {
      console.error('[sse] note-updated parse failed:', e);
    }
  });

  es.onerror = (e) => {
    // EventSource readyState: 0=CONNECTING (重连中), 1=OPEN, 2=CLOSED
    // 401 时浏览器把状态置 CLOSED, 此时不会自动重连, 退出
    if (es && es.readyState === EventSource.CLOSED) {
      console.warn('[sse] connection closed (可能 token 失效)');
      es = null;
    } else {
      // CONNECTING 状态会自动重连, 不动
    }
  };
}

export function stopReminderSse() {
  if (es) {
    es.close();
    es = null;
  }
}
