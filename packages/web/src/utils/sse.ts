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

// 通用通知 payload (兼容老 reminder 的 noteId, 新增 path 给群组等场景)
type NotifyPayload = { title: string; body: string; tag?: string; path?: string };

let es: EventSource | null = null;

// 用 Electron 原生通知 / 浏览器 Notification 显示桌面通知
function showNotification(p: NotifyPayload) {
  const desk = (window as any).quinkDesktop;
  if (desk?.showNotification) {
    // Electron IPC: 走主进程 new Notification, 比 renderer 的 Notification 更显眼 + 任务栏闪
    // path 优先, noteId 老兼容 (preload-main.ts 已扩展接收 path 字段)
    desk.showNotification({ title: p.title, body: p.body, noteId: p.tag, path: p.path });
    return;
  }
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') {
    console.warn('[sse] 浏览器通知未授权, 跳过. 去 Settings > 提醒 申请权限');
    return;
  }
  try {
    const n = new Notification(p.title, { body: p.body, tag: p.tag });
    n.onclick = () => {
      window.focus();
      // path 优先 (群组), 老 reminder 走 /note/<tag>
      if (p.path) window.location.href = p.path;
      else if (p.tag) window.location.href = `/note/${p.tag}`;
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
      showNotification({ title: data.title, body: data.body, tag: data.noteId });
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
  // group-join-request: owner 收到 "X 申请加入" → pendingCount++ + toast + 桌面通知 (蘑菇要求 owner 离线/不在 Quink 窗口时能收到)
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
      // OS 桌面通知 (任务栏闪 + Win 通知中心收纳). 点击跳群组详情页直接看待审申请
      showNotification({
        title: '群组申请',
        body: `${data.applicant.nickname} 申请加入「${data.groupName}」`,
        tag: `group-join-${data.requestId}`,
        path: `/groups/${data.groupId}`,
      });
    } catch (e) { console.error('[sse] group-join-request parse failed:', e); }
  });

  // group-join-approved: 我被同意 → 刷新群列表 + toast + 桌面通知 (点击进新群)
  es.addEventListener('group-join-approved', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { groupId: string };
      Promise.all([import('@/stores/groups'), import('@/composables/useToast')]).then(([{ useGroupsStore }, { useToast }]) => {
        useGroupsStore().onJoinApproved();
        useToast().show('申请已通过, 加入群组成功', 'success');
      });
      showNotification({
        title: '加群成功',
        body: '你的申请已通过, 点击进入群组',
        tag: `group-approved-${data.groupId}`,
        path: `/groups/${data.groupId}`,
      });
    } catch (e) { console.error('[sse] group-join-approved parse failed:', e); }
  });

  // group-join-rejected: 我被拒绝 → toast + 桌面通知
  es.addEventListener('group-join-rejected', (_ev) => {
    import('@/composables/useToast').then(({ useToast }) => {
      useToast().show('管理员拒绝了你的申请', 'error');
    });
    showNotification({
      title: '申请被拒绝',
      body: '管理员拒绝了你的申请',
    });
  });

  // group-dissolved: 我所在群被 owner 解散 → 从 sidebar 移除 + toast + 桌面通知
  es.addEventListener('group-dissolved', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { groupId: string };
      Promise.all([import('@/stores/groups'), import('@/composables/useToast')]).then(([{ useGroupsStore }, { useToast }]) => {
        useGroupsStore().onDissolved(data.groupId);
        useToast().show('群组已被解散', 'default');
      });
      showNotification({
        title: '群组已解散',
        body: '你所在的一个群组已被创建者解散',
        tag: `group-dissolved-${data.groupId}`,
      });
    } catch (e) { console.error('[sse] group-dissolved parse failed:', e); }
  });

  // group-member-removed: 我被踢 (self=true) 或 别人被踢 (self=false). 只在自己被踢时桌面通知
  es.addEventListener('group-member-removed', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { groupId: string; by: string; self: boolean };
      Promise.all([import('@/stores/groups'), import('@/composables/useToast')]).then(([{ useGroupsStore }, { useToast }]) => {
        useGroupsStore().onMemberRemoved(data.groupId, data.self);
        if (data.self) useToast().show('你已被移出群组', 'error');
      });
      if (data.self) {
        showNotification({
          title: '已被移出群组',
          body: '管理员将你移出了一个群组',
          tag: `group-removed-${data.groupId}`,
        });
      }
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

  // PR #2 阶段 5c: group-notes-changed - 共享笔记 POST/PATCH/DELETE 时给目标群成员推, 触发群 feed 自动刷新
  // 派 window 事件让 GroupDetail.vue 监听 (sse.ts 拿不到 component instance / router)
  es.addEventListener('group-notes-changed', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { groupId: string };
      window.dispatchEvent(new CustomEvent('quink-group-notes-changed', { detail: { groupId: data.groupId } }));
    } catch (e) { console.error('[sse] group-notes-changed parse failed:', e); }
  });

  // PR #5b 编辑权限申请: note-edit-request - 申请人提交申请, 作者+群 admin 收实时提示 + 桌面通知
  // toast 加"同意"action 让收件人一键审批 (拒绝走默认: 不操作即 toast 消失, 后续 PR 加完整审批面板)
  es.addEventListener('note-edit-request', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as {
        requestId: string; noteId: string; requesterId: string; requesterNickname: string; message: string | null;
      };
      Promise.all([import('@/composables/useToast'), import('@/api')]).then(([{ useToast }, { api }]) => {
        const toast = useToast();
        toast.show(`${data.requesterNickname} 申请编辑你的笔记`, {
          kind: 'success',
          duration: 10000,
          action: {
            label: '同意',
            onClick: async () => {
              try {
                await api.approveNoteEditRequest(data.noteId, data.requestId);
                toast.show('已同意, 申请人获得编辑权限', 'success', 2500);
              } catch (e: any) {
                toast.show('同意失败: ' + (e.message || '未知错误'), 'error', 3000);
              }
            },
          },
        });
      });
      showNotification({
        title: '笔记编辑权限申请',
        body: `${data.requesterNickname} 申请编辑笔记${data.message ? '：' + data.message : ''}`,
        tag: `note-edit-request-${data.requestId}`,
        path: `/note/${data.noteId}`,
      });
      // 让 GroupDetail 自动刷新待审列表 (跟 group-notes-changed 同款 window event 模式)
      window.dispatchEvent(new CustomEvent('quink-edit-request-changed'));
    } catch (e) { console.error('[sse] note-edit-request parse failed:', e); }
  });

  // PR #5b: note-edit-request-resolved - 申请人收到处理结果 (approved/rejected)
  es.addEventListener('note-edit-request-resolved', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { noteId: string; status: 'approved' | 'rejected' };
      const approved = data.status === 'approved';
      import('@/composables/useToast').then(({ useToast }) => {
        useToast().show(
          approved ? '你的编辑权限申请已通过' : '你的编辑权限申请被拒绝',
          approved ? 'success' : 'error',
          3500,
        );
      });
      showNotification({
        title: approved ? '编辑权限申请通过' : '编辑权限申请被拒',
        body: approved ? '现在可以编辑这条笔记了' : '作者或管理员拒绝了你的申请',
        tag: `note-edit-resolved-${data.noteId}`,
        path: `/note/${data.noteId}`,
      });
    } catch (e) { console.error('[sse] note-edit-request-resolved parse failed:', e); }
  });

// PR #6: 共享笔记 reaction / 评论增删改事件. server publish 给该笔记所属群所有 active member + 作者.
  // 前端 dispatchEvent 让打开的 NoteDetail / NoteEditModal / CommentThread 接住做增量更新.
  // NoteCard 不直接监听 (避免 N 个 listener), 它的 commentCount/reactionSummary 等下次 fetchNotes / group-notes-changed 时同步.
  es.addEventListener('note-reaction-changed', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { noteId: string; summary: any[] };
      window.dispatchEvent(new CustomEvent('quink-note-reaction-changed', { detail: data }));
    } catch (e) { console.error('[sse] note-reaction-changed parse failed:', e); }
  });

  es.addEventListener('note-comment-added', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { noteId: string; comment: any };
      window.dispatchEvent(new CustomEvent('quink-note-comment-added', { detail: data }));
    } catch (e) { console.error('[sse] note-comment-added parse failed:', e); }
  });

  es.addEventListener('note-comment-updated', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { noteId: string; commentId: string; content: string; updatedAt: string };
      window.dispatchEvent(new CustomEvent('quink-note-comment-updated', { detail: data }));
    } catch (e) { console.error('[sse] note-comment-updated parse failed:', e); }
  });

  es.addEventListener('note-comment-deleted', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { noteId: string; commentId: string };
      window.dispatchEvent(new CustomEvent('quink-note-comment-deleted', { detail: data }));
    } catch (e) { console.error('[sse] note-comment-deleted parse failed:', e); }
  });

  // presence-changed: 同群成员上下线 (bus.ts subscribe size 从 0→1 / 1→0 触发).
  // 只在打开群详情页时有意义, 静默 mutate currentDetail.members[i].online, 不弹 toast
  es.addEventListener('presence-changed', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { userId: string; online: boolean };
      import('@/stores/groups').then(({ useGroupsStore }) => {
        useGroupsStore().onPresenceChanged(data.userId, data.online);
      });
    } catch (e) { console.error('[sse] presence-changed parse failed:', e); }
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
