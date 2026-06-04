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

  // ── 群组共享 PR #1 SSE 事件 ──
  // group-join-request: owner 收到 "X 申请加入" → pendingCount++ + toast
  es.addEventListener('group-join-request', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as {
        requestId: string; groupId: string; groupName: string;
        applicant: { id: string; username: string; nickname: string; avatar: string | null };
      };
      Promise.all([import('@/stores/groups'), import('@/composables/useToast')]).then(([{ useGroupsStore }, { useToast }]) => {
        useGroupsStore().onJoinRequest(data.groupId);
        // 5 秒 (默认 1.6s 太短易错过) + success 风格高亮重要事件
        useToast().show(`${data.applicant.nickname} 申请加入「${data.groupName}」`, { kind: 'success', duration: 5000 });
      });
    } catch (e) { console.error('[sse] group-join-request parse failed:', e); }
  });

  // group-join-approved: 我被同意 → 刷新群列表 + toast
  es.addEventListener('group-join-approved', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { groupId: string };
      Promise.all([import('@/stores/groups'), import('@/composables/useToast')]).then(([{ useGroupsStore }, { useToast }]) => {
        useGroupsStore().onJoinApproved();
        useToast().show('申请已通过, 加入群组成功', 'success');
        void data;
      });
    } catch (e) { console.error('[sse] group-join-approved parse failed:', e); }
  });

  // group-join-rejected: 我被拒绝 → toast (不存历史, 申请记录 server 保留)
  es.addEventListener('group-join-rejected', (_ev) => {
    import('@/composables/useToast').then(({ useToast }) => {
      useToast().show('管理员拒绝了你的申请', 'error');
    });
  });

  // group-dissolved: 我所在群被 owner 解散 → 从 sidebar 移除 + toast
  es.addEventListener('group-dissolved', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { groupId: string };
      Promise.all([import('@/stores/groups'), import('@/composables/useToast')]).then(([{ useGroupsStore }, { useToast }]) => {
        useGroupsStore().onDissolved(data.groupId);
        useToast().show('群组已被解散', 'default');
      });
    } catch (e) { console.error('[sse] group-dissolved parse failed:', e); }
  });

  // group-member-removed: 我被踢 (self=true) 或 别人被踢 (self=false)
  es.addEventListener('group-member-removed', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { groupId: string; by: string; self: boolean };
      Promise.all([import('@/stores/groups'), import('@/composables/useToast')]).then(([{ useGroupsStore }, { useToast }]) => {
        useGroupsStore().onMemberRemoved(data.groupId, data.self);
        if (data.self) useToast().show('你已被移出群组', 'error');
      });
    } catch (e) { console.error('[sse] group-member-removed parse failed:', e); }
  });

  // group-member-joined: autoJoin 模式下有新成员加入 (owner 收到, 不弹 toast 避免噪音, 仅同步状态)
  es.addEventListener('group-member-joined', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { groupId: string; userId: string };
      import('@/stores/groups').then(({ useGroupsStore }) => {
        useGroupsStore().onMemberJoined(data.groupId);
      });
      void data;
    } catch (e) { console.error('[sse] group-member-joined parse failed:', e); }
  });

  // group-changed: 任何群组写操作后 broadcast 给所有 active 成员 (排除操作者).
  // 触发场景: 成员变化 / 角色变更 / 群信息修改. 不弹 toast (避免噪音), 静默刷新当前打开的群 + 群列表
  es.addEventListener('group-changed', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { groupId: string };
      import('@/stores/groups').then(({ useGroupsStore }) => {
        const store = useGroupsStore();
        // 当前正在看这个群 → 刷新详情 + 待审 (owner/admin 才有 join requests 权限)
        if (store.currentDetail?.id === data.groupId) {
          store.loadGroup(data.groupId).catch(() => {});
          if (store.currentDetail?.myRole === 'owner' || store.currentDetail?.myRole === 'admin') {
            store.loadJoinRequests(data.groupId).catch(() => {});
          }
        }
        // 群列表也刷新 (memberCount / 群名 / 头像 变化)
        store.loadGroups().catch(() => {});
      });
    } catch (e) { console.error('[sse] group-changed parse failed:', e); }
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
