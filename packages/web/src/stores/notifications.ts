// 通知中心 store
// 列表 + 未读数 + 标已读 / 删除 / 清空 + SSE in-place mutate.
//
// 多设备同步: 操作发起方本地 mutate UI 不等 SSE 回环 (sse.ts handler 用 isMyEvent 跳过自己的事件);
// 收到他人/其他设备触发的 notification-changed 重 load 当前 category + 未读数. notification-new
// 是后端 helper 推给收件人多设备的通用事件 (不带 _originClientId), 直接 head 插 + 未读 +1.

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api, type NotificationItem } from '@/api';

export type NotificationCategory = 'content' | 'reminder' | 'group';
export type TabKey = '' | NotificationCategory; // '' = 全部 tab

const PAGE_LIMIT = 20;

export const useNotificationsStore = defineStore('notifications', () => {
  const items = ref<NotificationItem[]>([]);
  const total = ref(0);
  const page = ref(1);
  const hasMore = computed(() => items.value.length < total.value);
  const loading = ref(false);

  // 当前 view 在看的 tab. view 切 tab 时 setTab 触发 reload
  const currentTab = ref<TabKey>('');

  // 未读数. total = 全部未读, content/reminder/group = 各 tab 未读. 给徽章 + tab 标小红点用
  const unread = ref({ total: 0, content: 0, reminder: 0, group: 0 });

  function categoryFilter(): NotificationCategory | undefined {
    return currentTab.value === '' ? undefined : currentTab.value;
  }

  async function loadList(opts?: { append?: boolean }) {
    if (loading.value) return;
    loading.value = true;
    try {
      const reqPage = opts?.append ? page.value + 1 : 1;
      const res = await api.getNotifications({
        category: categoryFilter(),
        page: reqPage,
        limit: PAGE_LIMIT,
      });
      if (opts?.append) {
        items.value = [...items.value, ...res.data];
        page.value = reqPage;
      } else {
        items.value = res.data;
        page.value = 1;
      }
      total.value = res.total;
    } finally {
      loading.value = false;
    }
  }

  async function loadUnreadCount() {
    try {
      const res = await api.getNotificationUnreadCount();
      unread.value = res.data;
    } catch (e) {
      console.error('[notifications] loadUnreadCount failed:', e);
    }
  }

  function setTab(tab: TabKey) {
    if (currentTab.value === tab) return;
    currentTab.value = tab;
    // 切 tab 立刻 reset items 让 UI 先空 + 触发 loading skeleton; loadList 完成后填充
    items.value = [];
    total.value = 0;
    page.value = 1;
    loadList().catch(() => {});
  }

  async function markRead(id: string) {
    const idx = items.value.findIndex((n) => n.id === id);
    if (idx >= 0 && !items.value[idx].readAt) {
      // 本地 mutate: readAt 立即设, unread 减 1 (按 category 减对应)
      const now = new Date().toISOString();
      items.value[idx] = { ...items.value[idx], readAt: now };
      const cat = items.value[idx].category;
      unread.value = {
        ...unread.value,
        total: Math.max(0, unread.value.total - 1),
        [cat]: Math.max(0, (unread.value as any)[cat] - 1),
      };
    }
    try {
      await api.markNotificationRead(id);
    } catch (e) {
      console.error('[notifications] markRead failed:', e);
    }
  }

  async function markReadAll() {
    const cat = categoryFilter();
    // 本地 mutate: 当前 tab 全部 readAt 设, 当前 tab 未读 → 0; 全部 tab 时全清
    const now = new Date().toISOString();
    items.value = items.value.map((n) => (n.readAt ? n : { ...n, readAt: now }));
    if (cat) {
      const decr = (unread.value as any)[cat];
      unread.value = {
        ...unread.value,
        total: Math.max(0, unread.value.total - decr),
        [cat]: 0,
      };
    } else {
      unread.value = { total: 0, content: 0, reminder: 0, group: 0 };
    }
    try {
      await api.markNotificationReadAll(cat);
    } catch (e) {
      console.error('[notifications] markReadAll failed:', e);
    }
  }

  async function deleteOne(id: string) {
    const idx = items.value.findIndex((n) => n.id === id);
    if (idx >= 0) {
      const n = items.value[idx];
      items.value = items.value.filter((x) => x.id !== id);
      total.value = Math.max(0, total.value - 1);
      // 未读项删 → unread 减 1
      if (!n.readAt) {
        unread.value = {
          ...unread.value,
          total: Math.max(0, unread.value.total - 1),
          [n.category]: Math.max(0, (unread.value as any)[n.category] - 1),
        };
      }
    }
    try {
      await api.deleteNotification(id);
    } catch (e) {
      console.error('[notifications] deleteOne failed:', e);
      // 失败回滚: 重 load (不是关键操作, 简单实现)
      loadList().catch(() => {});
      loadUnreadCount().catch(() => {});
    }
  }

  async function clearAll() {
    const cat = categoryFilter();
    // 本地清空当前 tab. 未读数按 category 减
    if (cat) {
      const decr = (unread.value as any)[cat];
      unread.value = {
        ...unread.value,
        total: Math.max(0, unread.value.total - decr),
        [cat]: 0,
      };
    } else {
      unread.value = { total: 0, content: 0, reminder: 0, group: 0 };
    }
    items.value = [];
    total.value = 0;
    page.value = 1;
    try {
      await api.clearNotifications(cat);
    } catch (e) {
      console.error('[notifications] clearAll failed:', e);
      loadList().catch(() => {});
      loadUnreadCount().catch(() => {});
    }
  }

  // SSE: notification-new (createNotification helper 推送给收件人多设备, 不带 _originClientId)
  // 给当前 tab 看的: head 插 + unread +1. 不是当前 tab 但是同账号: 仅 unread +1.
  function handleNotificationNew(n: NotificationItem) {
    // unread +1 (按 category)
    unread.value = {
      ...unread.value,
      total: unread.value.total + 1,
      [n.category]: (unread.value as any)[n.category] + 1,
    };
    // 当前 tab = 全部 or 命中本条 category → head 插
    const cat = categoryFilter();
    if (!cat || cat === n.category) {
      items.value = [n, ...items.value];
      total.value += 1;
    }
  }

  // SSE: notification-changed (其他设备触发本人的 read/delete/clear). 重 load 当前 tab + 未读数
  function handleNotificationChanged() {
    loadList().catch(() => {});
    loadUnreadCount().catch(() => {});
  }

  // 账号切换时清空 (auth clearUserData 调): 通知列表 + 分页 + 未读数
  function reset() {
    items.value = [];
    total.value = 0;
    page.value = 1;
    currentTab.value = '';
    unread.value = { total: 0, content: 0, reminder: 0, group: 0 };
  }

  return {
    items,
    total,
    page,
    hasMore,
    loading,
    currentTab,
    unread,
    loadList,
    loadUnreadCount,
    setTab,
    markRead,
    markReadAll,
    deleteOne,
    clearAll,
    reset,
    handleNotificationNew,
    handleNotificationChanged,
  };
});
