<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useGroupsStore } from '@/stores/groups';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import { useEscToClose } from '@/composables/useEscToClose';
import { resolveFileUrl, resolveFileThumbUrl, thumbErrorFallback } from '@/utils/fileUrl';
import { api } from '@/api';
import dayjs from 'dayjs';
import {
  PhUsersThree, PhCopy, PhArrowsClockwise, PhX, PhCheck, PhSignOut, PhTrash,
  PhCaretRight, PhPencilSimple, PhCamera, PhNote,
} from '@phosphor-icons/vue';
import NoteCard from './NoteCard.vue';
import type { Note } from '@/api';

const props = defineProps<{ groupId: string }>();

const router = useRouter();
const store = useGroupsStore();
const auth = useAuthStore();
const toast = useToast();

const groupId = computed(() => props.groupId);
const detail = computed(() => store.currentDetail);
const isOwner = computed(() => detail.value?.myRole === 'owner');
const isOwnerOrAdmin = computed(() => detail.value?.myRole === 'owner' || detail.value?.myRole === 'admin');

const loading = ref(false);
const errorMsg = ref('');

async function load() {
  if (!groupId.value) return;
  loading.value = true;
  errorMsg.value = '';
  try {
    await store.loadGroup(groupId.value);
    // owner/admin 拉待审列表
    if (store.currentDetail?.myRole === 'owner' || store.currentDetail?.myRole === 'admin') {
      await store.loadJoinRequests(groupId.value);
    }
    // PR #2 阶段 5a: 拉群内笔记 (跟群详情并发)
    loadGroupNotes(true);
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
      // 去重 (server 分页边界可能有重叠)
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

// groupId 切 (左侧群列表点击切换) → 重新拉
watch(groupId, load);
onMounted(() => {
  load();
  window.addEventListener('quink-group-notes-changed', onGroupNotesChanged);
});
onUnmounted(() => {
  store.currentDetail = null;
  store.currentJoinRequests = [];
  window.removeEventListener('quink-group-notes-changed', onGroupNotesChanged);
});

// PR #2 阶段 5c: 收到 sse group-notes-changed (别人加/改/删了共享笔记) → 当前打开的就是这个群时 reload
function onGroupNotesChanged(e: Event) {
  const detail = (e as CustomEvent).detail;
  if (detail?.groupId === groupId.value) loadGroupNotes(true);
}

// ── 邀请链接管理 ──

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

// ── 成员操作 ──

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
    if (isSelf) router.push('/');
  } catch (e: any) {
    toast.show(e?.message || '操作失败', 'error');
  }
}

// 角色变更确认弹窗 (提升 admin / 降级 member 都过这道关, 避免 hover 误点)
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
  // 复用现有 /api/upload/avatar 接口 (2MB 限制), 拿 url 后 PATCH group.avatar
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
    (e.target as HTMLInputElement).value = ''; // 让相同文件再选也能触发 change
  }
}

// autoJoin 切换
async function toggleAutoJoin() {
  if (!groupId.value || !detail.value) return;
  try {
    await store.updateGroup(groupId.value, { autoJoin: !detail.value.autoJoin });
    toast.show(detail.value.autoJoin ? '已切换为自动加入' : '已切换为申请审批', 'success');
  } catch (e: any) {
    toast.show(e?.message || '切换失败', 'error');
  }
}
</script>

<template>
  <div class="h-full overflow-y-auto px-4 md:px-8 py-6 max-w-3xl mx-auto w-full">
    <!-- 加载/错误 -->
    <div v-if="loading" class="text-center py-16 text-sm text-gray-400">加载中...</div>
    <div v-else-if="errorMsg" class="text-center py-16">
      <p class="text-sm text-red-500 mb-2">{{ errorMsg }}</p>
      <button @click="router.push('/groups')" class="text-xs text-gray-500 hover:underline">返回群组</button>
    </div>
    <div v-else-if="detail" class="space-y-5">
      <!-- Header: 头像 + 群组名 + 人数 + 退群/解散 -->
      <div class="flex items-center gap-3">
        <!-- 头像: owner hover 显示相机遮罩 + 点击换. 非 owner 仅展示 -->
        <div class="relative w-12 h-12 shrink-0 group/avatar"
          :class="isOwner ? 'cursor-pointer' : ''"
          @click="pickAvatar">
          <img v-if="detail.avatar" :src="resolveFileThumbUrl(detail.avatar)"
            @error="thumbErrorFallback($event, resolveFileUrl(detail.avatar))"
            alt="头像" class="w-12 h-12 rounded-xl object-cover" />
          <div v-else class="w-12 h-12 rounded-xl bg-primary/15 text-primary-dark flex items-center justify-center">
            <PhUsersThree size="1.5rem" weight="fill" />
          </div>
          <!-- owner hover 遮罩 -->
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
          <button v-if="!isOwner" @click="askRemoveMember(auth.user!.id, auth.nickname || '')"
            class="px-3 py-1 text-xs rounded-lg font-medium bg-gray-200 text-gray-600 hover:bg-gray-300 inline-flex items-center gap-1">
            <PhSignOut size="0.75rem" weight="fill" /> 退群
          </button>
          <button v-if="isOwner" @click="confirmDissolve = true"
            class="px-3 py-1 text-xs rounded-lg font-medium bg-red-50 text-red-500 hover:bg-red-100 inline-flex items-center gap-1">
            <PhTrash size="0.75rem" weight="fill" /> 解散群
          </button>
        </div>
      </div>

      <!-- 邀请管理 (owner + admin 都可 reset/close, autoJoin 切换仅 owner 避免 admin 误改加群策略) -->
      <section v-if="isOwnerOrAdmin" class="bg-gray-50 rounded-xl p-4">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-medium">邀请链接</h3>
          <!-- 加入模式 segmented control: 仅 owner 看到 (admin 只用邀请, 不改策略) -->
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
          <!-- admin 看到当前模式只读标签 -->
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

      <!-- 待审申请 (owner/admin) -->
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

      <!-- 成员列表 -->
      <section>
        <h3 class="text-sm font-medium mb-3">成员 ({{ detail.memberCount }})</h3>
        <div class="space-y-1">
          <div v-for="m in detail.members" :key="m.userId"
            class="group flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-50 transition-colors">
            <img v-if="m.avatar" :src="resolveFileThumbUrl(m.avatar)"
              @error="thumbErrorFallback($event, resolveFileUrl(m.avatar))"
              alt="" class="w-8 h-8 rounded-full object-cover shrink-0" />
            <div v-else class="w-8 h-8 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold shrink-0">
              {{ (m.nickname || m.username).charAt(0).toUpperCase() }}
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm truncate">
                {{ m.nickname }}
                <span v-if="m.userId === auth.user?.id" class="text-[10px] text-primary-dark ml-1">(我)</span>
              </div>
              <div class="text-[10px] text-gray-400 truncate">@{{ m.username }}</div>
            </div>
            <!-- 操作按钮先(常驻占位 opacity-0): owner 可对 admin/member, admin 可对 member.
                 顺序: 操作 → chip, 让 chip 永远紧贴行尾对齐 (不会因为有/无操作 div 跳位置) -->
            <div v-if="m.userId !== auth.user?.id && (isOwner || (detail.myRole === 'admin' && m.role === 'member'))"
              class="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
              <button v-if="isOwner && m.role === 'member'" @click="askChangeRole(m.userId, m.nickname || m.username, 'promote')"
                class="p-1 text-gray-400 hover:text-sky-500" title="设为管理员">
                <PhCaretRight size="0.75rem" weight="bold" />
              </button>
              <button v-if="isOwner && m.role === 'admin'" @click="askChangeRole(m.userId, m.nickname || m.username, 'demote')"
                class="p-1 text-gray-400 hover:text-gray-700" title="取消管理员">
                <PhCaretRight size="0.75rem" weight="bold" class="rotate-180" />
              </button>
              <button @click="askRemoveMember(m.userId, m.nickname || m.username)"
                class="p-1 text-gray-400 hover:text-red-500" title="移除">
                <PhX size="0.75rem" weight="bold" />
              </button>
            </div>
            <!-- 角色 chip 最后, 永远紧贴行尾 (跟其他成员行 chip 对齐) -->
            <span class="text-[10px] px-2 py-0.5 rounded-full font-medium" :class="{
              'bg-amber-100 text-amber-700': m.role === 'owner',
              'bg-sky-100 text-sky-700': m.role === 'admin',
              'bg-gray-100 text-gray-500': m.role === 'member',
            }">
              {{ m.role === 'owner' ? '创建者' : m.role === 'admin' ? '管理员' : '成员' }}
            </span>
          </div>
        </div>
      </section>

      <!-- 群内笔记 feed (PR #2 群组共享). 单列垂直 stack NoteCard, sharedAt DESC, 分页加载更多 -->
      <section>
        <div class="flex items-center gap-2 mb-3">
          <h3 class="text-sm font-medium">群内笔记</h3>
          <span class="text-xs text-gray-400 tabular-nums">{{ groupNotesTotal }}</span>
        </div>
        <div v-if="groupNotes.length === 0 && !groupNotesLoading" class="text-center py-12">
          <div class="mb-3 flex justify-center text-gray-300">
            <PhNote size="2.5rem" weight="fill" />
          </div>
          <p class="text-gray-500 text-sm">还没有共享笔记</p>
          <p class="text-gray-400 text-xs mt-1">在编辑器底栏选择本群可见性, 笔记会出现在这里</p>
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
    </div>

    <!-- 关闭邀请确认 -->
    <Teleport to="body">
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

      <!-- 角色变更确认 (提升/降级) -->
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
    </Teleport>
  </div>
</template>
