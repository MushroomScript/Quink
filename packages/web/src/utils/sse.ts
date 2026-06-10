// 提醒 SSE 客户端
// 连 /api/sse?token=xxx, 监听 'reminder' 事件 → 弹通知
// EventSource 不能传 Authorization header, 所以走 query token (跟 request() 用同一 quink_token)
// EventSource 内置自动重连 (默认 3s), 但 401 后会无限重连. 我们手动检测 401 → 主动 close

import { getAuthToken } from '@/api';
import { backendBaseUrl } from './backendUrl';
import { isMyEvent } from './clientId';

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

  // SSE 直连 backend 绕开 vite proxy 转发 (避免长连接占用 :24888 socket 池).
  // 详见 utils/backendUrl.ts 的根因说明
  const url = `${backendBaseUrl()}/api/sse?token=${encodeURIComponent(token)}`;
  es = new EventSource(url);

  es.addEventListener('ready', () => {
    console.log('[sse] connected');
  });

  es.addEventListener('reminder', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as ReminderEvent;
      if (isMyEvent(data)) return;
      console.log('[sse] reminder received:', data);
      showNotification({ title: data.title, body: data.body, tag: data.noteId });
    } catch (e) {
      console.error('[sse] parse reminder failed:', e);
    }
  });

  // note-updated: scheduler 触发提醒后 publish, 让前端刷新单条 note 字段
  // (避免单次提醒发完后 todoRemindSentAt 后端有值前端不知道, 卡片仍显示"未提醒"态)
  // 也用于"作者本人多设备同步": PATCH 笔记后 server publish 给作者所有设备让其他设备 refreshSingleNote 拉新内容
  es.addEventListener('note-updated', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { noteId: string };
      if (isMyEvent(data)) return;
      // 动态 import 避免 sse.ts 跟 store 形成静态循环依赖
      import('@/stores/notes').then(({ useNotesStore }) => {
        useNotesStore().refreshSingleNote(data.noteId);
      });
    } catch (e) {
      console.error('[sse] note-updated parse failed:', e);
    }
  });

  // note-created: POST /notes 或 trash restore 后 server publish 给作者本人所有设备
  // → 其他设备 store 拉单条插入对应 viewState (跟 createNote 同款"首位 after pinned"插入)
  es.addEventListener('note-created', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { noteId: string };
      if (isMyEvent(data)) return;
      import('@/stores/notes').then(({ useNotesStore }) => {
        useNotesStore().syncNoteCreated(data.noteId);
      });
    } catch (e) {
      console.error('[sse] note-created parse failed:', e);
    }
  });

  // note-deleted: DELETE /:id (软删) 或 DELETE /trash/:id (彻底删除) 后 server publish 给作者本人所有设备
  // → 其他设备本地 store 从 viewState 移除该 id (不调 API 避免重复 DELETE)
  // Trash.vue 用本地 ref 自管 trashedNotes, 单独监听 quink-note-deleted CustomEvent
  es.addEventListener('note-deleted', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { noteId: string };
      if (isMyEvent(data)) return;
      import('@/stores/notes').then(({ useNotesStore }) => {
        useNotesStore().syncNoteDeleted(data.noteId);
      });
      // 派 CustomEvent 给 Trash / NoteDetail 等局部组件监听 (如果当前在 Trash 看回收站列表, 这条要从列表里清掉)
      window.dispatchEvent(new CustomEvent('quink-note-deleted', { detail: { noteId: data.noteId } }));
    } catch (e) {
      console.error('[sse] note-deleted parse failed:', e);
    }
  });

  // 通用 data-changed: 给非笔记/群组的其他界面 (categories / ai-configs / ai-prompts / ai-conversations / ai-messages / reminder-channels / resources / user-profile) 用.
  // 后端在写 endpoint 调 publish(userId, 'data-changed', { scope }, _ocid). 前端按 scope 派对应 CustomEvent 让 view onMounted listener 触发本地 refresh.
  // 不在 store 里因为这些 view 没有 pinia store, 用 window CustomEvent 让 view 内 onMounted 监听最简洁
  es.addEventListener('data-changed', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { scope?: string; [k: string]: any };
      if (isMyEvent(data)) return;
      if (!data.scope) return;
      // user-profile 是全局 (头像/昵称影响所有用到 auth.user 的 UI), 不依赖某个 view 监听, 直接调 fetchMe
      if (data.scope === 'user-profile') {
        import('@/stores/auth').then(({ useAuthStore }) => useAuthStore().fetchMe?.());
      }
      window.dispatchEvent(new CustomEvent(`quink-${data.scope}-changed`, { detail: data }));
    } catch (e) {
      console.error('[sse] data-changed parse failed:', e);
    }
  });

  // trash-cleared: DELETE /trash 清空回收站后 server publish 给作者本人所有设备
  // → 标所有主 view dirty 让下次 onActivated 触发刷新. Trash 用 CustomEvent 单独处理
  es.addEventListener('trash-cleared', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data || '{}') as { count?: number };
      if (isMyEvent(data)) return;
      import('@/stores/notes').then(({ useNotesStore }) => {
        useNotesStore().syncTrashCleared();
      });
      window.dispatchEvent(new CustomEvent('quink-trash-cleared'));
    } catch (e) {
      console.error('[sse] trash-cleared handler failed:', e);
    }
  });

  // ── 群组共享 SSE 事件 ──
  // group-join-request: owner 收到 "X 申请加入" → pendingCount++ + toast + 桌面通知 (owner 离线/不在 Quink 窗口时也能收到)
  es.addEventListener('group-join-request', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as {
        requestId: string; groupId: string; groupName: string;
        applicant: { id: string; username: string; nickname: string; avatar: string | null };
      };
      // toast 砍, OS 通知也砍, 由 browser channel 统一触发 (createNotification → dispatch)
      import('@/stores/groups').then(({ useGroupsStore }) => {
        useGroupsStore().onJoinRequest(data.groupId);
      });
    } catch (e) { console.error('[sse] group-join-request parse failed:', e); }
  });

  // group-join-approved: 我被同意 → 刷新群列表 + toast + 桌面通知 (点击进新群)
  es.addEventListener('group-join-approved', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { groupId: string };
      if (isMyEvent(data)) return;
      // OS 通知由 browser channel 统一触发
      import('@/stores/groups').then(({ useGroupsStore }) => {
        useGroupsStore().onJoinApproved();
      });
    } catch (e) { console.error('[sse] group-join-approved parse failed:', e); }
  });

  // group-join-rejected: 我被拒绝. OS 通知由 browser channel 统一触发, 此 handler 无 store side effect 实际可删
  es.addEventListener('group-join-rejected', () => {});

  // group-dissolved: 我所在群被 owner 解散 → 从 sidebar 移除 + toast + 桌面通知
  es.addEventListener('group-dissolved', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { groupId: string };
      if (isMyEvent(data)) return;
      // OS 通知由 browser channel 统一触发
      import('@/stores/groups').then(({ useGroupsStore }) => {
        useGroupsStore().onDissolved(data.groupId);
      });
    } catch (e) { console.error('[sse] group-dissolved parse failed:', e); }
  });

  // group-member-removed: 我被踢 (self=true) 或 别人被踢 (self=false). 只在自己被踢时桌面通知
  es.addEventListener('group-member-removed', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { groupId: string; by: string; self: boolean };
      if (isMyEvent(data)) return;
      // OS 通知由 browser channel 统一触发. 自己被踢的 toast 保留 (即时反馈)
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
      if (isMyEvent(data)) return;
      import('@/stores/groups').then(({ useGroupsStore }) => {
        useGroupsStore().onMemberJoined(data.groupId);
      });
      void data;
    } catch (e) { console.error('[sse] group-member-joined parse failed:', e); }
  });

  // group-notes-changed - 共享笔记 POST/PATCH/DELETE 时给目标群成员推, 触发群 feed 自动刷新
  // 派 window 事件让 GroupDetail.vue 监听 (sse.ts 拿不到 component instance / router).
  // 同时让主 view (Inspiration/Notes/Todos) 也同步 — sharedDisplay='all'/'others_shared' 时主 view 显示别人共享笔记.
  // store.refreshFromRemote 处理"当前主 view fetchNotes + 跨 view 标 dirty"逻辑
  es.addEventListener('group-notes-changed', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { groupId: string };
      if (isMyEvent(data)) return;
      window.dispatchEvent(new CustomEvent('quink-group-notes-changed', { detail: { groupId: data.groupId } }));
      import('@/stores/notes').then(({ useNotesStore }) => {
        useNotesStore().refreshFromRemote();
      });
    } catch (e) { console.error('[sse] group-notes-changed parse failed:', e); }
  });

  // 群组回收站: admin 删共享笔记 / 恢复 / 永久删 / 清空 时 server publish 给该群所有 owner+admin
  // 让 GroupTrash.vue 实时 reload 列表. 跟 group-notes-changed 同款 window event 模式
  es.addEventListener('group-trash-changed', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { groupId: string };
      if (isMyEvent(data)) return;
      window.dispatchEvent(new CustomEvent('quink-group-trash-changed', { detail: { groupId: data.groupId } }));
    } catch (e) { console.error('[sse] group-trash-changed parse failed:', e); }
  });

  // 编辑权限申请: note-edit-request - 申请人提交申请, 作者+群 admin 收实时提示 + 桌面通知
  // toast 加"同意"action 让收件人一键审批 (拒绝走默认: 不操作即 toast 消失, 后续补完整审批面板)
  es.addEventListener('note-edit-request', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as {
        requestId: string; noteId: string; requesterId: string; requesterNickname: string; message: string | null;
      };
      // 调整: note-edit-request toast 加回, 只显示「同意」quick-action 按钮.
      // 「拒绝」/「忽略」不放 toast (避免误点), 走通知中心或 NoteDetail 的"待审申请" section 操作.
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
      // OS 通知由 browser channel 统一触发
      // 让 GroupDetail 自动刷新待审列表 (跟 group-notes-changed 同款 window event 模式)
      window.dispatchEvent(new CustomEvent('quink-edit-request-changed'));
    } catch (e) { console.error('[sse] note-edit-request parse failed:', e); }
  });

  // note-duplicated - 别人复制了你的笔记, 给原作者 toast + 桌面通知
  es.addEventListener('note-duplicated', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as {
        originNoteId: string; newNoteId: string; duplicatorNickname: string;
      };
      if (isMyEvent(data)) return;
      // toast + OS 通知都砍, 通知中心 + browser channel 统一接管
      void data;
    } catch (e) { console.error('[sse] note-duplicated parse failed:', e); }
  });

  // note-edit-request-resolved - 申请人收到处理结果 (approved/rejected)
  es.addEventListener('note-edit-request-resolved', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { noteId: string; status: 'approved' | 'rejected' };
      if (isMyEvent(data)) return;
      const approved = data.status === 'approved';
      // OS 通知由 browser channel 统一触发
      // approved 时刷该笔记 canWrite. 三处需同步: (1) 主 view store viewState (2) 打开的 GroupDetail 群 feed (3) 申请审批面板.
      // 主 view 用 refreshSingleNote 拉单条; GroupDetail 不在 store, 用 window event quink-edit-request-changed (现有 listener 调 loadEditRequests, canWrite 同时刷 groupNotes)
      if (approved) {
        import('@/stores/notes').then(({ useNotesStore }) => {
          useNotesStore().refreshSingleNote(data.noteId);
        });
      }
      window.dispatchEvent(new CustomEvent('quink-edit-request-changed', { detail: { noteId: data.noteId, status: data.status } }));
    } catch (e) { console.error('[sse] note-edit-request-resolved parse failed:', e); }
  });

  // note-edit-grant-revoked - 我的编辑权被撤销 → 刷该笔记 canWrite (后端 enrich 现在返 false)
  es.addEventListener('note-edit-grant-revoked', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { noteId: string };
      if (isMyEvent(data)) return;
      import('@/stores/notes').then(({ useNotesStore }) => {
        useNotesStore().refreshSingleNote(data.noteId);
      });
      window.dispatchEvent(new CustomEvent('quink-edit-request-changed', { detail: { noteId: data.noteId, status: 'revoked' } }));
    } catch (e) { console.error('[sse] note-edit-grant-revoked parse failed:', e); }
  });

// 共享笔记 reaction / 评论增删改事件. server publish 给该笔记所属群所有 active member + 作者.
  // 前端 dispatchEvent 让打开的 NoteDetail / NoteEditModal / CommentThread 接住做增量更新.
  // NoteCard 不直接监听 (避免 N 个 listener), 它的 commentCount/reactionSummary 等下次 fetchNotes / group-notes-changed 时同步.
  es.addEventListener('note-reaction-changed', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { noteId: string; summary: any[] };
      if (isMyEvent(data)) return;
      window.dispatchEvent(new CustomEvent('quink-note-reaction-changed', { detail: data }));
    } catch (e) { console.error('[sse] note-reaction-changed parse failed:', e); }
  });

  es.addEventListener('note-comment-added', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { noteId: string; comment: any };
      if (isMyEvent(data)) return;
      window.dispatchEvent(new CustomEvent('quink-note-comment-added', { detail: data }));
    } catch (e) { console.error('[sse] note-comment-added parse failed:', e); }
  });

  es.addEventListener('note-comment-updated', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { noteId: string; commentId: string; content: string; updatedAt: string };
      if (isMyEvent(data)) return;
      window.dispatchEvent(new CustomEvent('quink-note-comment-updated', { detail: data }));
    } catch (e) { console.error('[sse] note-comment-updated parse failed:', e); }
  });

  es.addEventListener('note-comment-deleted', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { noteId: string; commentId: string };
      if (isMyEvent(data)) return;
      window.dispatchEvent(new CustomEvent('quink-note-comment-deleted', { detail: data }));
    } catch (e) { console.error('[sse] note-comment-deleted parse failed:', e); }
  });

  // presence-changed: 同群成员上下线 (bus.ts subscribe size 从 0→1 / 1→0 触发).
  // 只在打开群详情页时有意义, 静默 mutate currentDetail.members[i].online, 不弹 toast
  es.addEventListener('presence-changed', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { userId: string; online: boolean };
      if (isMyEvent(data)) return;
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
      if (isMyEvent(data)) return;
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

  // 通知中心 SSE.
  // notification-new: 后端 createNotification helper 推给收件人 (本人所有设备). 不带 _originClientId
  // (不是发起人触发的事件, 多设备都该收到). store handler 头插 + 未读数 +1
  // OS 通知不再由前端硬白名单触发, 完全由后端 browser channel.types 配置控制
  // (Settings 提醒页里勾选哪些 type → browser channel 收到后走 'reminder' SSE handler 弹 OS).
  // 这里只更新通知中心徽章, 不直接弹 OS
  es.addEventListener('notification-new', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as {
        id: string;
        category: 'content' | 'reminder' | 'group';
        type: string;
        title: string;
        body?: string | null;
        payload?: Record<string, any> | null;
        createdAt: string;
      };
      import('@/stores/notifications').then(({ useNotificationsStore }) => {
        useNotificationsStore().handleNotificationNew({
          id: data.id,
          category: data.category,
          type: data.type,
          title: data.title,
          body: data.body ?? null,
          payload: data.payload ?? null,
          readAt: null,
          createdAt: data.createdAt,
        });
      });
    } catch (e) { console.error('[sse] notification-new parse failed:', e); }
  });

  // notification-changed: 其他设备触发本人 read/delete/clear 后 publish. isMyEvent 跳过本设备
  // (本设备已直接 store mutate), 其他设备 reload 当前 tab + 未读数
  es.addEventListener('notification-changed', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as {
        scope: 'read' | 'read-all' | 'delete' | 'clear';
        id?: string;
        category?: string | null;
      };
      if (isMyEvent(data)) return;
      import('@/stores/notifications').then(({ useNotificationsStore }) => {
        useNotificationsStore().handleNotificationChanged();
      });
    } catch (e) { console.error('[sse] notification-changed parse failed:', e); }
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
