<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, provide } from 'vue';
import { useRouter } from 'vue-router';
import { useGroupsStore } from '@/stores/groups';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import { useEscToClose } from '@/composables/useEscToClose';
import { resolveFileUrl, resolveFileThumbUrl, thumbErrorFallback } from '@/utils/fileUrl';
import { api } from '@/api';
import dayjs from 'dayjs';
import {
  PhUsersThree, PhCopy, PhArrowsClockwise, PhX, PhCheck, PhTrash,
  PhCaretRight, PhCaretDown, PhPencilSimple, PhCamera, PhNote, PhMegaphone,
  PhEye, PhEyeSlash, PhBell,
} from '@phosphor-icons/vue';
import NoteCard from './NoteCard.vue';
import type { Note, GroupNoteEditRequestRow, GroupMemberInfo } from '@/api';

const props = defineProps<{ groupId: string }>();

const router = useRouter();
const store = useGroupsStore();
const auth = useAuthStore();
const toast = useToast();

const groupId = computed(() => props.groupId);
const detail = computed(() => store.currentDetail);
const isOwner = computed(() => detail.value?.myRole === 'owner');
const isOwnerOrAdmin = computed(() => detail.value?.myRole === 'owner' || detail.value?.myRole === 'admin');

// 安全审计 S6: 我在该群的隐身状态 (后端返 members[i].hidePresence 仅对本人非 undefined)
const myHidePresence = computed(() => {
  const me = detail.value?.members.find((m: any) => m.userId === auth.user?.id);
  return !!(me as any)?.hidePresence;
});
const togglingPresence = ref(false);
async function togglePresenceMode() {
  if (!detail.value || togglingPresence.value) return;
  togglingPresence.value = true;
  const next = !myHidePresence.value;
  try {
    await api.setGroupPresenceMode(detail.value.id, next);
    // 本地立刻 mutate 让 UI 立即反映 (SSE 给其他设备由后端 publish 'group-changed' 触发刷新)
    const me = detail.value.members.find((m: any) => m.userId === auth.user?.id);
    if (me) (me as any).hidePresence = next;
    toast.show(next ? '已在该群隐身 (仍能正常收消息)' : '已取消隐身', 'success', 2500);
  } catch (e: any) {
    toast.show('切换失败: ' + (e.message || '未知错误'), 'error', 3000);
  } finally {
    togglingPresence.value = false;
  }
}

// 给子 NoteCard provide 群角色, 让 NoteCard 的"群内置顶"菜单项按 owner/admin 才显示
provide('groupRole', computed(() => detail.value?.myRole || null));

// 成员列表显示用: server 已按 (role asc, joinedAt asc) 排好, 这里只把"自己"提到所在角色段首位.
// 其他人保持加入时间顺序不动 (owner 段一般只 1 人无影响, admin / member 段才有效果).
const sortedMembers = computed<GroupMemberInfo[]>(() => {
  if (!detail.value) return [];
  const list = [...detail.value.members];
  const meId = auth.user?.id;
  if (!meId) return list;
  const meIdx = list.findIndex(m => m.userId === meId);
  if (meIdx <= 0) return list;
  const me = list[meIdx];
  const segStart = list.findIndex(m => m.role === me.role);
  if (segStart === meIdx) return list;
  list.splice(meIdx, 1);
  list.splice(segStart, 0, me);
  return list;
});

const loading = ref(false);
const errorMsg = ref('');

async function load() {
  if (!groupId.value) return;
  loading.value = true;
  errorMsg.value = '';
  try {
    await store.loadGroup(groupId.value);
    if (store.currentDetail?.myRole === 'owner' || store.currentDetail?.myRole === 'admin') {
      await store.loadJoinRequests(groupId.value);
    }
    loadGroupNotes(true);
    loadEditRequests();
  } catch (e: any) {
    errorMsg.value = e?.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

// PR #2 群内笔记 feed: 单列垂直 stack NoteCard, 分页 "加载更多". 默认 sharedAt DESC
const groupNotes = ref<Note[]>([]);
const groupNotesTotal = ref(0);
const groupNotesPage = ref(1);
const groupNotesLoading = ref(false);
const GROUP_NOTES_LIMIT = 30;

async function loadGroupNotes(reset = false) {
  if (!groupId.value || groupNotesLoading.value) return;
  groupNotesLoading.value = true;
  try {
    if (reset) {
      groupNotesPage.value = 1;
      groupNotes.value = [];
    }
    const res = await api.getGroupNotes(groupId.value, { page: groupNotesPage.value, limit: GROUP_NOTES_LIMIT });
    if (reset) {
      groupNotes.value = res.data;
    } else {
      const existing = new Set(groupNotes.value.map(n => n.id));
      for (const n of res.data) if (!existing.has(n.id)) groupNotes.value.push(n);
    }
    groupNotesTotal.value = res.pagination.total;
  } catch {} finally {
    groupNotesLoading.value = false;
  }
}

function loadMoreGroupNotes() {
  groupNotesPage.value++;
  loadGroupNotes(false);
}

// 蘑菇 2026-06-09: 群级"接收本群通知"开关已移除. 想关单条群提醒走 NoteCard 三点菜单"屏蔽此待办群提醒"

watch(groupId, () => {
  // 切群: 关掉所有临时浮层 (邀请折叠 / 公告编辑 / 右键菜单), 防残留
  inviteOpen.value = false;
  announcementEditing.value = false;
  ctxMenu.value = null;
  load();
});
onMounted(() => {
  load();
  window.addEventListener('quink-group-notes-changed', onGroupNotesChanged);
  window.addEventListener('quink-edit-request-changed', onEditRequestChanged);
  window.addEventListener('quink-group-trash-changed', onGroupTrashChanged);
});
onUnmounted(() => {
  store.currentDetail = null;
  store.currentJoinRequests = [];
  window.removeEventListener('quink-group-notes-changed', onGroupNotesChanged);
  window.removeEventListener('quink-edit-request-changed', onEditRequestChanged);
  window.removeEventListener('quink-group-trash-changed', onGroupTrashChanged);
});

function onEditRequestChanged() {
  loadEditRequests();
  // PR #13 补丁: 申请审批 / 撤销授权后 NoteCard 的 canWrite 字段变 (后端 enrich 重算).
  // GroupDetail 用本地 ref groupNotes (不在 store viewState), 必须重拉才能让 NoteCard 拿到新 canWrite
  loadGroupNotes(true);
}

function onGroupNotesChanged(e: Event) {
  const detail = (e as CustomEvent).detail;
  if (detail?.groupId === groupId.value) loadGroupNotes(true);
}

// PR #12: 群回收站变化 (admin 删别人 / 恢复 / 永久删 / 清空) → 重拉 group detail 刷 trashCount.
// 事件源: 本设备发起方 NoteCard.doDelete / GroupTrash 4 操作 dispatch + 其他设备 SSE handler (sse.ts) 派
function onGroupTrashChanged(e: Event) {
  const detail = (e as CustomEvent).detail;
  if (detail?.groupId === groupId.value) store.loadGroup(groupId.value);
}

// PR #5b 待审编辑申请 (跨笔记汇总, 折叠 >3 条)
const editRequests = ref<GroupNoteEditRequestRow[]>([]);
const editRequestsExpanded = ref(false);
const COLLAPSE_LIMIT = 3;
const visibleEditRequests = computed(() =>
  editRequestsExpanded.value ? editRequests.value : editRequests.value.slice(0, COLLAPSE_LIMIT)
);

async function loadEditRequests() {
  if (!groupId.value || !isOwnerOrAdmin.value) return;
  try {
    const res = await api.listGroupEditRequests(groupId.value);
    editRequests.value = res.data;
  } catch {}
}

async function approveEditRequest(reqId: string, noteId: string) {
  try {
    await api.approveNoteEditRequest(noteId, reqId);
    toast.show('已同意', 'success');
    editRequests.value = editRequests.value.filter(r => r.id !== reqId);
  } catch (e: any) { toast.show(e?.message || '操作失败', 'error'); }
}

async function rejectEditRequest(reqId: string, noteId: string) {
  try {
    await api.rejectNoteEditRequest(noteId, reqId);
    toast.show('已拒绝', 'success');
    editRequests.value = editRequests.value.filter(r => r.id !== reqId);
  } catch (e: any) { toast.show(e?.message || '操作失败', 'error'); }
}

// ── 邀请链接管理 (折叠胶囊触发) ──

const inviteOpen = ref(false);

const inviteUrl = computed(() => {
  if (!detail.value?.inviteToken) return '';
  return `${location.origin}/invite/${detail.value.inviteToken}`;
});
const inviteExpiresHuman = computed(() => {
  if (!detail.value?.inviteExpiresAt) return '永不过期';
  return `${dayjs(detail.value.inviteExpiresAt).format('YYYY-MM-DD HH:mm')} 过期`;
});

async function copyInvite() {
  if (!inviteUrl.value) return;
  try {
    await navigator.clipboard.writeText(inviteUrl.value);
    toast.show('邀请链接已复制', 'success');
  } catch {
    toast.show('复制失败, 请手动选中链接', 'error');
  }
}

async function resetInvite() {
  if (!groupId.value) return;
  try {
    await store.resetInvite(groupId.value);
    toast.show('邀请链接已重置, 旧链接失效', 'success');
  } catch (e: any) {
    toast.show(e?.message || '重置失败', 'error');
  }
}

const confirmCloseInvite = ref(false);
useEscToClose(confirmCloseInvite);
async function doCloseInvite() {
  if (!groupId.value) return;
  confirmCloseInvite.value = false;
  try {
    await store.closeInvite(groupId.value);
    toast.show('邀请已关闭, 当前没人能加入', 'success');
  } catch (e: any) {
    toast.show(e?.message || '关闭失败', 'error');
  }
}

// ── 申请审批 ──

async function approveReq(reqId: string) {
  if (!groupId.value) return;
  try {
    await store.approveRequest(groupId.value, reqId);
    toast.show('已同意', 'success');
  } catch (e: any) {
    toast.show(e?.message || '失败', 'error');
  }
}

async function rejectReq(reqId: string) {
  if (!groupId.value) return;
  try {
    await store.rejectRequest(groupId.value, reqId);
    toast.show('已拒绝', 'success');
  } catch (e: any) {
    toast.show(e?.message || '失败', 'error');
  }
}

// ── 成员操作 (全部走右键菜单) ──

const confirmRemoveId = ref('');
const confirmRemoveName = ref('');
useEscToClose(confirmRemoveId, '');

function askRemoveMember(userId: string, nickname: string) {
  confirmRemoveId.value = userId;
  confirmRemoveName.value = nickname;
}

async function doRemoveMember() {
  if (!groupId.value || !confirmRemoveId.value) return;
  const isSelf = confirmRemoveId.value === auth.user?.id;
  try {
    await store.removeMember(groupId.value, confirmRemoveId.value, auth.user?.id || '');
    toast.show(isSelf ? '已退群' : `已移除 ${confirmRemoveName.value}`, 'success');
    confirmRemoveId.value = '';
    confirmRemoveName.value = '';
    if (isSelf) router.push('/quink');
  } catch (e: any) {
    toast.show(e?.message || '操作失败', 'error');
  }
}

const confirmRoleChange = ref<{ userId: string; nickname: string; action: 'promote' | 'demote' } | null>(null);
useEscToClose(confirmRoleChange, null);

function askChangeRole(userId: string, nickname: string, action: 'promote' | 'demote') {
  confirmRoleChange.value = { userId, nickname, action };
}

async function doChangeRole() {
  if (!groupId.value || !confirmRoleChange.value) return;
  const { userId, action } = confirmRoleChange.value;
  const role = action === 'promote' ? 'admin' : 'member';
  const successMsg = action === 'promote' ? '已设为管理员' : '已取消管理员';
  confirmRoleChange.value = null;
  try { await store.patchMemberRole(groupId.value, userId, role); toast.show(successMsg, 'success'); }
  catch (e: any) { toast.show(e?.message || '失败', 'error'); }
}

// ── 右键菜单 (成员列表) ──

type CtxItem = { label: string; action: () => void; danger?: boolean };
const ctxMenu = ref<{ x: number; y: number; items: CtxItem[] } | null>(null);
useEscToClose(ctxMenu, null);

function openCtxMenu(e: MouseEvent, m: GroupMemberInfo) {
  const items: CtxItem[] = [];
  const isSelf = m.userId === auth.user?.id;
  if (isSelf) {
    // 自己: 仅非 owner 可退群 (owner 退群语义不通, 要么解散要么先转让)
    if (!isOwner.value) {
      items.push({ label: '退出群组', danger: true, action: () => askRemoveMember(m.userId, m.nickname || '') });
    }
  } else if (isOwner.value) {
    // owner 操作 admin/member
    if (m.role === 'member') items.push({ label: '设为管理员', action: () => askChangeRole(m.userId, m.nickname || m.username, 'promote') });
    if (m.role === 'admin') items.push({ label: '取消管理员', action: () => askChangeRole(m.userId, m.nickname || m.username, 'demote') });
    if (m.role !== 'owner') items.push({ label: '移出群组', danger: true, action: () => askRemoveMember(m.userId, m.nickname || m.username) });
  } else if (detail.value?.myRole === 'admin' && m.role === 'member') {
    // admin 只能对 member 操作 (不能动其他 admin / owner)
    items.push({ label: '移出群组', danger: true, action: () => askRemoveMember(m.userId, m.nickname || m.username) });
  }
  if (items.length === 0) return; // 无可用操作 → 静默 (浏览器原生右键也不弹)
  // 边界检测: 防菜单溢出视口右下
  const W = 160, H = items.length * 32 + 8;
  let x = e.clientX, y = e.clientY;
  if (x + W > window.innerWidth - 8) x = window.innerWidth - W - 8;
  if (y + H > window.innerHeight - 8) y = window.innerHeight - H - 8;
  ctxMenu.value = { x, y, items };
}

function runCtxItem(item: CtxItem) {
  const fn = item.action;
  ctxMenu.value = null;
  fn();
}

// 点击菜单外关闭 (菜单内点击 stop propagation)
function onDocClickToCloseCtx(e: MouseEvent) {
  if (!ctxMenu.value) return;
  const el = (e.target as HTMLElement).closest?.('.group-ctx-menu');
  if (!el) ctxMenu.value = null;
}
onMounted(() => {
  document.addEventListener('click', onDocClickToCloseCtx);
  window.addEventListener('blur', () => { ctxMenu.value = null; });
  window.addEventListener('resize', () => { ctxMenu.value = null; });
});
onUnmounted(() => document.removeEventListener('click', onDocClickToCloseCtx));

// ── 解散群 ──

const confirmDissolve = ref(false);
useEscToClose(confirmDissolve);

async function doDissolve() {
  if (!groupId.value) return;
  confirmDissolve.value = false;
  try {
    await store.dissolveGroup(groupId.value);
    toast.show('群组已解散', 'success');
    router.push('/groups');
  } catch (e: any) {
    toast.show(e?.message || '解散失败', 'error');
  }
}

// ── 改群组名 (inline 编辑) ──

const editingName = ref(false);
const nameInput = ref('');
function startEditName() {
  if (!detail.value) return;
  nameInput.value = detail.value.name;
  editingName.value = true;
}
async function saveName() {
  if (!groupId.value || !detail.value) return;
  const v = nameInput.value.trim();
  if (!v || v === detail.value.name) { editingName.value = false; return; }
  try {
    await store.updateGroup(groupId.value, { name: v });
    toast.show('群组名已更新', 'success');
  } catch (e: any) {
    toast.show(e?.message || '更新失败', 'error');
  }
  editingName.value = false;
}

// ── 头像上传 (owner only) ──

const avatarInputEl = ref<HTMLInputElement | null>(null);
const uploadingAvatar = ref(false);
function pickAvatar() {
  if (!isOwner.value || uploadingAvatar.value) return;
  avatarInputEl.value?.click();
}
async function onAvatarPicked(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file || !groupId.value) return;
  if (file.size > 2 * 1024 * 1024) {
    toast.show('头像不能超过 2MB', 'error');
    (e.target as HTMLInputElement).value = '';
    return;
  }
  uploadingAvatar.value = true;
  try {
    const res = await api.uploadAvatar(file);
    await store.updateGroup(groupId.value, { avatar: res.data.url });
    toast.show('群头像已更新', 'success');
  } catch (err: any) {
    toast.show(err?.message || '上传失败', 'error');
  } finally {
    uploadingAvatar.value = false;
    (e.target as HTMLInputElement).value = '';
  }
}

async function toggleAutoJoin() {
  if (!groupId.value || !detail.value) return;
  try {
    await store.updateGroup(groupId.value, { autoJoin: !detail.value.autoJoin });
    toast.show(detail.value.autoJoin ? '已切换为自动加入' : '已切换为申请审批', 'success');
  } catch (e: any) {
    toast.show(e?.message || '切换失败', 'error');
  }
}

// ── 群公告 (owner+admin 可编辑) ──

const announcementEditing = ref(false);
const announcementInput = ref('');
const announcementInputEl = ref<HTMLTextAreaElement | null>(null);
// 长公告: 显示态 line-clamp-5 截断, "查看全文"按钮弹 Modal 看完整.
// 估算"是否需要展开": 换行数 > 5 或字符 > 80 (右栏 ~208px / 12px 字 ≈ 16 字一行, 5 行 ~80 字).
// 不用 scrollHeight 测量 — Vue ref + nextTick + raf 时序在字体异步加载下不稳, 估算就够.
const announcementDetailOpen = ref(false);
useEscToClose(announcementDetailOpen);

const announcementShouldExpand = computed(() => {
  const a = detail.value?.announcement;
  if (!a) return false;
  return a.split('\n').length > 5 || a.length > 80;
});

function startEditAnnouncement() {
  if (!isOwnerOrAdmin.value) return;
  announcementInput.value = detail.value?.announcement || '';
  announcementEditing.value = true;
  // nextTick + focus 让用户直接键入
  setTimeout(() => announcementInputEl.value?.focus(), 0);
}
function cancelEditAnnouncement() {
  announcementEditing.value = false;
  announcementInput.value = '';
}
async function saveAnnouncement() {
  if (!groupId.value) return;
  const v = announcementInput.value.trim();
  try {
    await store.updateGroup(groupId.value, { announcement: v || null });
    toast.show(v ? '群公告已更新' : '群公告已清空', 'success');
    announcementEditing.value = false;
  } catch (e: any) {
    toast.show(e?.message || '更新失败', 'error');
  }
}
</script>

<template>
  <div class="h-full overflow-y-auto px-4 md:px-8 py-6">
    <div class="max-w-6xl mx-auto w-full">
      <!-- 加载/错误 -->
      <div v-if="loading" class="text-center py-16 text-sm text-gray-400">加载中...</div>
      <div v-else-if="errorMsg" class="text-center py-16">
        <p class="text-sm text-red-500 mb-2">{{ errorMsg }}</p>
        <button @click="router.push('/groups')" class="text-xs text-gray-500 hover:underline">返回群组</button>
      </div>
      <div v-else-if="detail" class="space-y-5">
        <!-- Header: 头像 + 群名 + 角色 [邀请胶囊] [解散] -->
        <div class="flex items-center gap-3">
          <div class="relative w-12 h-12 shrink-0 group/avatar"
            :class="isOwner ? 'cursor-pointer' : ''"
            @click="pickAvatar">
            <img v-if="detail.avatar" :src="resolveFileThumbUrl(detail.avatar)"
              @error="thumbErrorFallback($event, resolveFileUrl(detail.avatar))"
              alt="头像" class="w-12 h-12 rounded-xl object-cover" />
            <div v-else class="w-12 h-12 rounded-xl bg-primary/15 text-primary-dark flex items-center justify-center">
              <PhUsersThree size="1.5rem" weight="fill" />
            </div>
            <div v-if="isOwner"
              class="absolute inset-0 rounded-xl bg-black/50 text-white flex items-center justify-center opacity-0 group-hover/avatar:opacity-100 transition-opacity"
              :class="uploadingAvatar ? 'opacity-100' : ''">
              <PhCamera v-if="!uploadingAvatar" size="1rem" weight="fill" />
              <PhArrowsClockwise v-else size="1rem" weight="fill" class="animate-spin" />
            </div>
            <input ref="avatarInputEl" type="file" accept="image/*" class="hidden" @change="onAvatarPicked" />
          </div>
          <div class="flex-1 min-w-0">
            <div v-if="editingName" class="flex items-center gap-1">
              <input v-model="nameInput" maxlength="50" @keydown.enter="saveName" @blur="saveName" autofocus
                class="text-lg font-medium px-2 py-0.5 border border-gray-200 rounded outline-none focus:ring-2 focus:ring-primary/20" />
            </div>
            <div v-else class="flex items-center gap-1 group">
              <h2 class="text-lg font-medium truncate">{{ detail.name }}</h2>
              <button v-if="isOwner" @click="startEditName" class="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-600 transition-opacity">
                <PhPencilSimple size="0.875rem" />
              </button>
            </div>
            <div class="text-xs text-gray-400 mt-0.5">{{ detail.memberCount }} 位成员 · {{ isOwner ? '创建者' : detail.myRole === 'admin' ? '管理员' : '成员' }}</div>
          </div>
          <div class="flex items-center gap-2">
            <!-- 安全审计 S6: 群内隐身切换. 隐身时其他成员看不到我在线, 但我仍能收所有消息提醒 -->
            <button @click="togglePresenceMode" :disabled="togglingPresence"
              class="px-3 py-1 text-xs rounded-lg font-medium inline-flex items-center gap-1 transition-colors"
              :class="myHidePresence
                ? 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                : 'bg-primary-light text-primary-dark hover:bg-primary/20'"
              :title="myHidePresence ? '当前隐身中, 点击恢复显示在线' : '点击隐身 (仍能收消息)'">
              <PhEyeSlash v-if="myHidePresence" size="0.75rem" weight="fill" />
              <PhEye v-else size="0.75rem" weight="fill" />
              {{ myHidePresence ? '隐身中' : '在线' }}
            </button>
            <button v-if="isOwnerOrAdmin" @click="inviteOpen = !inviteOpen"
              class="px-3 py-1 text-xs rounded-lg font-medium bg-primary-light text-primary-dark hover:bg-primary/20 inline-flex items-center gap-1"
              :class="inviteOpen ? 'ring-1 ring-primary/30' : ''">
              邀请
              <PhCaretDown size="0.75rem" weight="bold" :class="['transition-transform', inviteOpen ? 'rotate-180' : '']" />
            </button>
            <!-- PR #12: 回收站胶囊, 仅 owner+admin 可见. 点跳 /groups/:id/trash. trashCount 为 0 时仍显示让 admin 知道入口在 -->
            <button v-if="isOwnerOrAdmin" @click="$router.push(`/groups/${groupId}/trash`)"
              class="px-3 py-1 text-xs rounded-lg font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 inline-flex items-center gap-1">
              <PhTrash size="0.75rem" weight="fill" />
              回收站<span v-if="(detail as any)?.trashCount" class="tabular-nums">({{ (detail as any).trashCount }})</span>
            </button>
            <button v-if="isOwner" @click="confirmDissolve = true"
              class="px-3 py-1 text-xs rounded-lg font-medium bg-red-50 text-red-500 hover:bg-red-100 inline-flex items-center gap-1">
              <PhTrash size="0.75rem" weight="fill" /> 解散群
            </button>
          </div>
        </div>

        <!-- 邀请管理 (折叠胶囊触发, owner+admin 可见) -->
        <section v-if="isOwnerOrAdmin && inviteOpen" class="bg-gray-50 rounded-xl p-4">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-medium">邀请链接</h3>
            <div v-if="isOwner" class="inline-flex items-center bg-white border border-gray-200 rounded-full p-0.5 gap-0.5">
              <button @click="detail.autoJoin || toggleAutoJoin()" type="button"
                class="px-3 py-1 text-[11px] font-medium rounded-full transition-colors"
                :class="detail.autoJoin ? 'bg-primary-light text-primary-dark' : 'text-gray-500 hover:text-gray-700'">
                <span class="relative -top-[0.5px]">自动加入</span>
              </button>
              <button @click="!detail.autoJoin || toggleAutoJoin()" type="button"
                class="px-3 py-1 text-[11px] font-medium rounded-full transition-colors"
                :class="!detail.autoJoin ? 'bg-primary-light text-primary-dark' : 'text-gray-500 hover:text-gray-700'">
                <span class="relative -top-[0.5px]">管理员审核</span>
              </button>
            </div>
            <span v-else class="text-[11px] text-gray-400 px-2 py-1 bg-white border border-gray-200 rounded-full">
              {{ detail.autoJoin ? '自动加入' : '管理员审核' }}
            </span>
          </div>
          <div v-if="detail.inviteToken" class="space-y-2">
            <div class="flex items-center gap-2">
              <input :value="inviteUrl" readonly
                class="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-xs font-mono outline-none" />
              <button @click="copyInvite" class="px-3 py-2 text-xs rounded-lg bg-primary-light text-primary-dark hover:bg-primary/20 inline-flex items-center gap-1">
                <PhCopy size="0.875rem" weight="fill" /> 复制
              </button>
            </div>
            <div class="flex items-center justify-between text-[11px] text-gray-400">
              <span>{{ inviteExpiresHuman }}</span>
              <div class="flex items-center gap-3">
                <button @click="resetInvite" class="hover:text-gray-700 inline-flex items-center gap-1" title="重置后旧链接立即失效">
                  <PhArrowsClockwise size="0.75rem" weight="fill" /> 重置
                </button>
                <button @click="confirmCloseInvite = true" class="hover:text-red-500 inline-flex items-center gap-1">
                  <PhX size="0.75rem" weight="bold" /> 关闭
                </button>
              </div>
            </div>
          </div>
          <div v-else class="flex items-center justify-between">
            <span class="text-xs text-gray-400">邀请已关闭, 当前没人能加入</span>
            <button @click="resetInvite" class="px-3 py-1.5 text-xs rounded-lg bg-primary text-white hover:bg-primary-dark">
              重新生成
            </button>
          </div>
        </section>

        <!-- PR #5b: 待审编辑申请 (owner/admin, 全宽) -->
        <section v-if="isOwnerOrAdmin && editRequests.length > 0" class="bg-gray-50 rounded-xl p-4">
          <h3 class="text-sm font-medium mb-3">待审编辑申请 ({{ editRequests.length }})</h3>
          <div class="space-y-2">
            <div v-for="req in visibleEditRequests" :key="req.id"
              class="bg-white rounded-lg p-3 space-y-2">
              <div class="flex items-center gap-2">
                <img v-if="req.requesterAvatar" :src="resolveFileThumbUrl(req.requesterAvatar)"
                  @error="thumbErrorFallback($event, resolveFileUrl(req.requesterAvatar))"
                  alt="" class="w-7 h-7 rounded-full object-cover shrink-0" />
                <div v-else class="w-7 h-7 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold shrink-0">
                  {{ (req.requesterNickname || '?').charAt(0).toUpperCase() }}
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-sm">
                    <span class="font-medium">{{ req.requesterNickname || '群成员' }}</span>
                    <span class="text-gray-400 text-xs ml-2">{{ dayjs(req.createdAt).format('MM-DD HH:mm') }}</span>
                  </div>
                  <div class="text-[11px] text-gray-500 truncate">申请编辑 {{ req.authorNickname || '?' }} 的笔记</div>
                </div>
                <button @click="approveEditRequest(req.id, req.noteId)"
                  class="px-2 py-1 text-xs rounded-lg bg-primary-light text-primary-dark hover:bg-primary/20 inline-flex items-center gap-1">
                  <PhCheck size="0.75rem" weight="bold" /> 同意
                </button>
                <button @click="rejectEditRequest(req.id, req.noteId)"
                  class="px-2 py-1 text-xs rounded-lg bg-gray-200 text-gray-600 hover:bg-gray-300 inline-flex items-center gap-1">
                  <PhX size="0.75rem" weight="bold" /> 拒绝
                </button>
              </div>
              <div class="text-xs text-gray-600 pl-9 line-clamp-2">{{ req.notePreview }}</div>
              <div v-if="req.message" class="text-xs text-gray-500 pl-9 italic">"{{ req.message }}"</div>
            </div>
            <button v-if="editRequests.length > COLLAPSE_LIMIT"
              @click="editRequestsExpanded = !editRequestsExpanded"
              class="w-full text-xs text-gray-500 hover:text-gray-700 py-1.5 inline-flex items-center justify-center gap-1 transition-colors">
              {{ editRequestsExpanded ? '收起' : `展开剩余 ${editRequests.length - COLLAPSE_LIMIT} 条` }}
              <PhCaretRight size="0.625rem" weight="bold" :class="['transition-transform', editRequestsExpanded ? 'rotate-90' : '']" />
            </button>
          </div>
        </section>

        <!-- 待审申请 (owner/admin, 全宽) -->
        <section v-if="isOwnerOrAdmin && store.currentJoinRequests.length > 0" class="bg-gray-50 rounded-xl p-4">
          <h3 class="text-sm font-medium mb-3">待审申请 ({{ store.currentJoinRequests.length }})</h3>
          <div class="space-y-2">
            <div v-for="req in store.currentJoinRequests" :key="req.id"
              class="flex items-center gap-2 bg-white rounded-lg p-2.5">
              <img v-if="req.applicant.avatar" :src="resolveFileThumbUrl(req.applicant.avatar)"
                @error="thumbErrorFallback($event, resolveFileUrl(req.applicant.avatar))"
                alt="" class="w-8 h-8 rounded-full object-cover shrink-0" />
              <div v-else class="w-8 h-8 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold shrink-0">
                {{ (req.applicant.nickname || req.applicant.username).charAt(0).toUpperCase() }}
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium truncate">{{ req.applicant.nickname }}</div>
                <div class="text-[10px] text-gray-400 truncate">@{{ req.applicant.username }} · {{ dayjs(req.createdAt).format('MM-DD HH:mm') }}</div>
              </div>
              <button @click="approveReq(req.id)"
                class="px-2 py-1 text-xs rounded-lg bg-primary-light text-primary-dark hover:bg-primary/20 inline-flex items-center gap-1">
                <PhCheck size="0.75rem" weight="bold" /> 同意
              </button>
              <button @click="rejectReq(req.id)"
                class="px-2 py-1 text-xs rounded-lg bg-gray-200 text-gray-600 hover:bg-gray-300 inline-flex items-center gap-1">
                <PhX size="0.75rem" weight="bold" /> 拒绝
              </button>
            </div>
          </div>
        </section>

        <!-- 主体两栏: 左 群内笔记, 右 群公告 + 群组成员 -->
        <div class="flex gap-5 items-start">
          <!-- 左: 群内笔记 -->
          <section class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-3">
              <h3 class="text-sm font-medium">群内笔记</h3>
              <span class="text-xs text-gray-400 tabular-nums">{{ groupNotesTotal }}</span>
            </div>
            <div v-if="groupNotes.length === 0 && !groupNotesLoading" class="text-center py-12">
              <div class="mb-3 flex justify-center text-gray-300">
                <PhNote size="2.5rem" weight="fill" />
              </div>
              <p class="text-gray-500 text-sm">还没有共享内容</p>
              <p class="text-gray-400 text-xs mt-1">在编辑器底栏选择本群可见性, 内容会出现在这里</p>
            </div>
            <div v-else class="space-y-3">
              <NoteCard v-for="n in groupNotes" :key="n.id" :note="n" />
            </div>
            <div v-if="groupNotes.length < groupNotesTotal" class="text-center mt-4">
              <button @click="loadMoreGroupNotes" :disabled="groupNotesLoading"
                class="px-4 py-1.5 text-xs rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50">
                {{ groupNotesLoading ? '加载中...' : `加载更多 (${groupNotes.length}/${groupNotesTotal})` }}
              </button>
            </div>
          </section>

          <!-- 右: 公告 + 成员 (固定 13rem, 容纳头像 + 昵称 + chip) -->
          <aside class="w-52 shrink-0 space-y-5">
            <!-- 群公告 -->
            <section class="bg-gray-50 rounded-xl p-4">
              <div class="flex items-center justify-between mb-2">
                <h3 class="text-sm font-medium inline-flex items-center gap-1.5">
                  <PhMegaphone size="0.875rem" weight="fill" class="text-primary-dark" /> 群公告
                </h3>
                <button v-if="isOwnerOrAdmin && !announcementEditing" @click="startEditAnnouncement"
                  class="text-xs text-primary-dark hover:underline">
                  {{ detail.announcement ? '编辑' : '发布' }}
                </button>
              </div>
              <!-- 编辑态 -->
              <div v-if="announcementEditing" class="space-y-2">
                <textarea ref="announcementInputEl" v-model="announcementInput" rows="6" maxlength="2000"
                  class="w-full px-2 py-1.5 text-xs bg-white border border-gray-200 rounded resize-y outline-none focus:ring-2 focus:ring-primary/20"
                  placeholder="写点群成员需要知道的事..."></textarea>
                <div class="flex justify-end gap-2">
                  <button @click="cancelEditAnnouncement"
                    class="px-2 py-1 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
                  <button @click="saveAnnouncement"
                    class="px-3 py-1 text-xs rounded-lg bg-primary text-white hover:bg-primary-dark">保存</button>
                </div>
              </div>
              <!-- 显示态: 已有公告 (line-clamp 5 行截断, 长内容点"查看全文"弹 Modal).
                   leading-5 (20px) 整数像素, 避免 150% DPI 下浮点行距子像素舍入 1px 偏差 -->
              <template v-else-if="detail.announcement">
                <p class="text-xs text-gray-700 break-words leading-5 announcement-clamp">{{ detail.announcement }}</p>
                <div v-if="detail.announcementUpdatedByNickname || announcementShouldExpand"
                  class="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-gray-200">
                  <span class="text-[10px] text-gray-400 truncate">
                    <template v-if="detail.announcementUpdatedByNickname">
                      {{ detail.announcementUpdatedByNickname }} · {{ dayjs(detail.announcementUpdatedAt).format('MM-DD HH:mm') }}
                    </template>
                  </span>
                  <button v-if="announcementShouldExpand" @click="announcementDetailOpen = true"
                    class="px-2 py-0.5 text-[10px] rounded-full bg-primary-light text-primary-dark hover:bg-primary/20 shrink-0">
                    查看全文
                  </button>
                </div>
              </template>
              <!-- 显示态: 无公告 (owner/admin 点击发布 / 普通成员只看 placeholder) -->
              <div v-else-if="isOwnerOrAdmin"
                @click="startEditAnnouncement"
                class="text-xs text-gray-400 italic cursor-pointer hover:text-primary-dark py-2">
                暂无公告, 点击发布
              </div>
              <div v-else class="text-xs text-gray-400 italic py-2">
                群主还没发公告
              </div>
            </section>

            <!-- 蘑菇 2026-06-09: 群级"接收本群通知"开关已移除 (实际只控 group-reminder-set 一种), 单条群提醒走卡片三点菜单 -->

            <!-- 群组成员 -->
            <section>
              <h3 class="text-sm font-medium mb-3">群组成员 ({{ detail.memberCount }})</h3>
              <div class="space-y-0.5">
                <div v-for="m in sortedMembers" :key="m.userId"
                  @contextmenu.prevent="openCtxMenu($event, m)"
                  class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 transition-colors"
                  :title="m.online ? '在线 · 右键操作' : '离线 · 右键操作'">
                  <!-- 头像 + 在线圆点 (右下角) -->
                  <div class="relative shrink-0">
                    <img v-if="m.avatar" :src="resolveFileThumbUrl(m.avatar)"
                      @error="thumbErrorFallback($event, resolveFileUrl(m.avatar))"
                      alt="" class="w-7 h-7 rounded-full object-cover" />
                    <div v-else class="w-7 h-7 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold">
                      {{ (m.nickname || m.username).charAt(0).toUpperCase() }}
                    </div>
                    <span class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-gray-50"
                      :class="m.online ? 'bg-emerald-500' : 'bg-gray-300'" />
                  </div>
                  <div class="flex-1 min-w-0 text-sm truncate">
                    {{ m.nickname }}
                    <span v-if="m.userId === auth.user?.id" class="text-[10px] text-primary-dark ml-0.5">(我)</span>
                  </div>
                  <span class="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0" :class="{
                    'bg-amber-100 text-amber-700': m.role === 'owner',
                    'bg-sky-100 text-sky-700': m.role === 'admin',
                    'bg-gray-100 text-gray-500': m.role === 'member',
                  }">
                    {{ m.role === 'owner' ? '创建者' : m.role === 'admin' ? '管理员' : '成员' }}
                  </span>
                </div>
              </div>
            </section>
          </aside>
        </div>
      </div>

      <!-- 弹窗 + 右键菜单 -->
      <Teleport to="body">
        <!-- 关闭邀请确认 -->
        <Transition name="modal">
          <div v-if="confirmCloseInvite" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
            <div class="absolute inset-0 bg-black/30" @click="confirmCloseInvite = false" />
            <div class="relative bg-white rounded-xl shadow-xl p-5 w-80 text-center">
              <p class="text-sm text-gray-700 mb-1">确认关闭邀请</p>
              <p class="text-xs text-gray-400 mb-4">关闭后没人能通过链接加入, 需重新生成</p>
              <div class="flex gap-2 justify-center">
                <button @click="confirmCloseInvite = false"
                  class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
                <button @click="doCloseInvite"
                  class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">关闭邀请</button>
              </div>
            </div>
          </div>
        </Transition>

        <!-- 解散群确认 -->
        <Transition name="modal">
          <div v-if="confirmDissolve" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
            <div class="absolute inset-0 bg-black/30" @click="confirmDissolve = false" />
            <div class="relative bg-white rounded-xl shadow-xl p-5 w-80 text-center">
              <p class="text-sm text-gray-700 mb-1">确认解散群组</p>
              <p class="text-xs text-gray-400 mb-4">「{{ detail?.name }}」将立即消失, 所有成员被移除, 不可恢复</p>
              <div class="flex gap-2 justify-center">
                <button @click="confirmDissolve = false"
                  class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
                <button @click="doDissolve"
                  class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">解散</button>
              </div>
            </div>
          </div>
        </Transition>

        <!-- 退群/移除成员确认 -->
        <Transition name="modal">
          <div v-if="confirmRemoveId" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
            <div class="absolute inset-0 bg-black/30" @click="confirmRemoveId = ''" />
            <div class="relative bg-white rounded-xl shadow-xl p-5 w-80 text-center">
              <p class="text-sm text-gray-700 mb-1">
                {{ confirmRemoveId === auth.user?.id ? '确认退出群组' : '确认移除成员' }}
              </p>
              <p class="text-xs text-gray-400 mb-4">
                {{ confirmRemoveId === auth.user?.id ? `退出「${detail?.name}」后需重新申请加入` : `将「${confirmRemoveName}」移出群组` }}
              </p>
              <div class="flex gap-2 justify-center">
                <button @click="confirmRemoveId = ''"
                  class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
                <button @click="doRemoveMember"
                  class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">
                  {{ confirmRemoveId === auth.user?.id ? '退群' : '移除' }}
                </button>
              </div>
            </div>
          </div>
        </Transition>

        <!-- 角色变更确认 -->
        <Transition name="modal">
          <div v-if="confirmRoleChange" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
            <div class="absolute inset-0 bg-black/30" @click="confirmRoleChange = null" />
            <div class="relative bg-white rounded-xl shadow-xl p-5 w-80 text-center">
              <p class="text-sm text-gray-700 mb-1">
                {{ confirmRoleChange?.action === 'promote' ? '设为管理员' : '取消管理员' }}
              </p>
              <p class="text-xs text-gray-400 mb-4">
                {{ confirmRoleChange?.action === 'promote'
                  ? `「${confirmRoleChange.nickname}」将获得审批申请 / 踢人权限`
                  : `「${confirmRoleChange?.nickname}」将变回普通成员` }}
              </p>
              <div class="flex gap-2 justify-center">
                <button @click="confirmRoleChange = null"
                  class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
                <button @click="doChangeRole"
                  class="px-4 py-1.5 text-xs rounded-lg text-white font-medium"
                  :class="confirmRoleChange?.action === 'promote' ? 'bg-primary hover:bg-primary-dark' : 'bg-gray-500 hover:bg-gray-600'">
                  {{ confirmRoleChange?.action === 'promote' ? '提升' : '降级' }}
                </button>
              </div>
            </div>
          </div>
        </Transition>

        <!-- 成员右键菜单 -->
        <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95"
          leave-active-class="transition duration-75 ease-in" leave-to-class="opacity-0 scale-95">
          <div v-if="ctxMenu"
            class="group-ctx-menu fixed z-[var(--z-context-menu)] bg-white rounded-lg shadow-xl border border-gray-200 py-1 min-w-[140px] origin-top-left"
            :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
            @click.stop>
            <button v-for="(item, i) in ctxMenu.items" :key="i"
              @click="runCtxItem(item)"
              class="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 transition-colors"
              :class="item.danger ? 'text-red-500 hover:bg-red-50' : 'text-gray-700'">
              {{ item.label }}
            </button>
          </div>
        </Transition>

        <!-- 公告全文 Modal (长文截断时弹) -->
        <Transition name="modal">
          <div v-if="announcementDetailOpen && detail?.announcement" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center px-4">
            <div class="absolute inset-0 bg-black/30" @click="announcementDetailOpen = false" />
            <div class="relative bg-white rounded-xl shadow-xl p-5 w-full max-w-lg max-h-[80vh] flex flex-col">
              <div class="flex items-center justify-between mb-3 pb-3 border-b border-gray-100">
                <h3 class="text-sm font-medium inline-flex items-center gap-1.5">
                  <PhMegaphone size="0.875rem" weight="fill" class="text-primary-dark" /> 群公告
                </h3>
                <button @click="announcementDetailOpen = false"
                  class="text-gray-400 hover:text-gray-600">
                  <PhX size="0.875rem" weight="bold" />
                </button>
              </div>
              <p class="text-sm text-gray-700 whitespace-pre-wrap break-words leading-6 overflow-y-auto flex-1">{{ detail.announcement }}</p>
              <div v-if="detail.announcementUpdatedByNickname" class="text-[11px] text-gray-400 mt-3 pt-3 border-t border-gray-100">
                {{ detail.announcementUpdatedByNickname }} · {{ dayjs(detail.announcementUpdatedAt).format('YYYY-MM-DD HH:mm') }}
              </div>
            </div>
          </div>
        </Transition>
      </Teleport>
    </div>
  </div>
</template>

<style scoped>
/* 公告显示态: 限制 5 行 + 保留 textarea 换行符. tailwind line-clamp 不带 white-space, 自己写 */
.announcement-clamp {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 5;
  overflow: hidden;
  white-space: pre-wrap;
}
</style>
