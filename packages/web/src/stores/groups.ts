import { defineStore } from 'pinia';
import { ref, computed, reactive } from 'vue';
import { api, type Group, type GroupDetail, type GroupJoinRequest } from '@/api';

// 群组共享: 我的群列表 + 当前群详情 + 待审申请角标
// SSE 群组事件由 App.vue 监听 (复用现有 SSE 通道), 命中后调本 store 方法同步状态
export const useGroupsStore = defineStore('groups', () => {
  // 我的群列表 (createdAt DESC)
  const groups = ref<Group[]>([]);
  // 当前打开的群详情 (含成员). 路由切走时清空避免脏数据
  const currentDetail = ref<GroupDetail | null>(null);
  // 各群待审申请数, 用于 sidebar 群组项角标. 只有 owner/admin 才会有 entries
  const pendingCount = reactive<Record<string, number>>({});
  // 当前群的待审申请列表 (仅 owner/admin 打开群详情时加载, 切走清)
  const currentJoinRequests = ref<GroupJoinRequest[]>([]);
  const loading = ref(false);

  // 我是否任何群的 owner/admin (用于 sidebar 显示"待审"角标总数)
  const totalPendingCount = computed(() => {
    let sum = 0;
    for (const id in pendingCount) sum += pendingCount[id];
    return sum;
  });

  async function loadGroups() {
    loading.value = true;
    try {
      const res = await api.getGroups();
      groups.value = res.data;
      // 为 owner/admin 的群预拉 pending count (sidebar 角标)
      for (const g of res.data) {
        if (g.myRole === 'owner' || g.myRole === 'admin') {
          refreshPendingCount(g.id).catch(() => {});
        }
      }
    } finally {
      loading.value = false;
    }
  }

  async function loadGroup(id: string) {
    const res = await api.getGroup(id);
    currentDetail.value = res.data;
    return res.data;
  }

  async function refreshPendingCount(groupId: string) {
    try {
      const res = await api.getJoinRequests(groupId);
      pendingCount[groupId] = res.data.length;
    } catch {
      // 无权限或群已解散 → 删 entry 不报错 (SSE dissolved 可能先到, 这里兜底)
      delete pendingCount[groupId];
    }
  }

  async function createGroup(data: { name: string; autoJoin?: boolean }) {
    const res = await api.createGroup(data);
    groups.value = [res.data, ...groups.value];
    return res.data;
  }

  async function updateGroup(id: string, data: { name?: string; autoJoin?: boolean; avatar?: string | null; announcement?: string | null }) {
    const res = await api.updateGroup(id, data);
    const idx = groups.value.findIndex(g => g.id === id);
    if (idx >= 0) groups.value[idx] = res.data;
    if (currentDetail.value?.id === id) {
      // Object.assign 而非 reassign: 保留 members (PATCH 接口不返成员列表)
      Object.assign(currentDetail.value, res.data);
    }
    return res.data;
  }

  async function dissolveGroup(id: string) {
    await api.dissolveGroup(id);
    groups.value = groups.value.filter(g => g.id !== id);
    delete pendingCount[id];
    if (currentDetail.value?.id === id) currentDetail.value = null;
  }

  async function resetInvite(id: string) {
    const res = await api.resetInvite(id);
    const idx = groups.value.findIndex(g => g.id === id);
    if (idx >= 0) {
      groups.value[idx] = { ...groups.value[idx], inviteToken: res.data.inviteToken, inviteExpiresAt: res.data.inviteExpiresAt };
    }
    if (currentDetail.value?.id === id) {
      currentDetail.value.inviteToken = res.data.inviteToken;
      currentDetail.value.inviteExpiresAt = res.data.inviteExpiresAt;
    }
    return res.data;
  }

  async function closeInvite(id: string) {
    await api.closeInvite(id);
    const idx = groups.value.findIndex(g => g.id === id);
    if (idx >= 0) {
      groups.value[idx] = { ...groups.value[idx], inviteToken: null, inviteExpiresAt: null };
    }
    if (currentDetail.value?.id === id) {
      currentDetail.value.inviteToken = null;
      currentDetail.value.inviteExpiresAt = null;
    }
  }

  async function loadJoinRequests(id: string) {
    const res = await api.getJoinRequests(id);
    currentJoinRequests.value = res.data;
    pendingCount[id] = res.data.length;
    return res.data;
  }

  async function approveRequest(groupId: string, requestId: string) {
    await api.approveJoinRequest(groupId, requestId);
    currentJoinRequests.value = currentJoinRequests.value.filter(r => r.id !== requestId);
    pendingCount[groupId] = Math.max(0, (pendingCount[groupId] || 1) - 1);
    // 同步成员数 + 成员列表 (在群详情页时)
    if (currentDetail.value?.id === groupId) {
      await loadGroup(groupId);
    } else {
      // 不在详情页也要把 groups 列表里的 memberCount 加 1 (sidebar 显示)
      const idx = groups.value.findIndex(g => g.id === groupId);
      if (idx >= 0) groups.value[idx] = { ...groups.value[idx], memberCount: groups.value[idx].memberCount + 1 };
    }
  }

  async function rejectRequest(groupId: string, requestId: string) {
    await api.rejectJoinRequest(groupId, requestId);
    currentJoinRequests.value = currentJoinRequests.value.filter(r => r.id !== requestId);
    pendingCount[groupId] = Math.max(0, (pendingCount[groupId] || 1) - 1);
  }

  // 踢人 / 自己退群: 同一 API, 后端按 meId === targetId 区分. 前端把 groups 里移除 (自己) / 同步成员列表 (别人)
  async function removeMember(groupId: string, userId: string, currentUserId: string) {
    await api.removeMember(groupId, userId);
    const isSelf = userId === currentUserId;
    if (isSelf) {
      groups.value = groups.value.filter(g => g.id !== groupId);
      delete pendingCount[groupId];
      if (currentDetail.value?.id === groupId) currentDetail.value = null;
    } else if (currentDetail.value?.id === groupId) {
      currentDetail.value.members = currentDetail.value.members.filter(m => m.userId !== userId);
      currentDetail.value.memberCount = Math.max(0, currentDetail.value.memberCount - 1);
      const idx = groups.value.findIndex(g => g.id === groupId);
      if (idx >= 0) groups.value[idx] = { ...groups.value[idx], memberCount: currentDetail.value.memberCount };
    }
  }

  async function patchMemberRole(groupId: string, userId: string, role: 'admin' | 'member') {
    await api.patchMemberRole(groupId, userId, role);
    // 重拉 group 让 server 重排序成员 (admin 升到 owner 下方 / 降到 member 行列)
    // SSE broadcast 给其他成员让他们也自动刷新 (broadcastGroupChanged 在 patchMemberRole 路由内)
    if (currentDetail.value?.id === groupId) {
      await loadGroup(groupId);
    }
  }

  // ── SSE 事件处理 (App.vue 监听 group-* 后调本组方法) ──

  // 收到新申请: pending++ + 如果当前正在看这个群, 自动 reload 待审列表 (不让用户点刷新)
  function onJoinRequest(groupId: string) {
    pendingCount[groupId] = (pendingCount[groupId] || 0) + 1;
    if (currentDetail.value?.id === groupId) {
      loadJoinRequests(groupId).catch(() => {});
    }
  }

  // 被同意/被加入: 刷新群列表 (能看到新加的群)
  async function onJoinApproved() {
    await loadGroups();
  }

  // 群解散: 从列表移除 (无论我是 owner / member 都一样, owner 自己解散时也走这条)
  function onDissolved(groupId: string) {
    groups.value = groups.value.filter(g => g.id !== groupId);
    delete pendingCount[groupId];
    if (currentDetail.value?.id === groupId) currentDetail.value = null;
  }

  // 自己被踢: 同 onDissolved (从列表移除). 别人被踢: 在详情页则刷新成员
  function onMemberRemoved(groupId: string, selfRemoved: boolean) {
    if (selfRemoved) {
      onDissolved(groupId);
    } else if (currentDetail.value?.id === groupId) {
      loadGroup(groupId).catch(() => {});
    }
  }

  // autoJoin 模式有新成员加入: 详情页时刷新成员; 否则只更新 memberCount
  function onMemberJoined(groupId: string) {
    if (currentDetail.value?.id === groupId) {
      loadGroup(groupId).catch(() => {});
    } else {
      const idx = groups.value.findIndex(g => g.id === groupId);
      if (idx >= 0) groups.value[idx] = { ...groups.value[idx], memberCount: groups.value[idx].memberCount + 1 };
    }
  }

  // SSE 上下线: 后端 bus.ts 检测某 user 第一条 SSE 上线/最后一条断开 → 推同群其他成员.
  // 直接 mutate 当前打开的详情页成员的 online 字段, Vue reactive 自动更新圆点
  function onPresenceChanged(userId: string, online: boolean) {
    if (!currentDetail.value) return;
    const m = currentDetail.value.members.find(x => x.userId === userId);
    if (m) m.online = online;
  }

  // 登出时清状态 (auth store logout 调)
  function reset() {
    groups.value = [];
    currentDetail.value = null;
    currentJoinRequests.value = [];
    for (const k in pendingCount) delete pendingCount[k];
  }

  return {
    groups, currentDetail, currentJoinRequests, pendingCount, totalPendingCount, loading,
    loadGroups, loadGroup, refreshPendingCount, createGroup, updateGroup, dissolveGroup,
    resetInvite, closeInvite, loadJoinRequests, approveRequest, rejectRequest,
    removeMember, patchMemberRole,
    onJoinRequest, onJoinApproved, onDissolved, onMemberRemoved, onMemberJoined, onPresenceChanged,
    reset,
  };
});
