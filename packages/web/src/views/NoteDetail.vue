<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, inject, watch, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useNotesStore } from '@/stores/notes';
import { useAuthStore } from '@/stores/auth';
import { useGroupsStore } from '@/stores/groups';
import { useToast } from '@/composables/useToast';
import { useEscToClose } from '@/composables/useEscToClose';
import { resolveFileUrl, resolveFileThumbUrl, thumbErrorFallback } from '@/utils/fileUrl';
import { unzoomRect, unzoomViewport } from '@/utils/zoom';
import { api, type Note, type NoteEditGrant, type NoteEditHistoryRow, type NoteEditRequest } from '@/api';
import Vditor from 'vditor';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import {
  PhNotePencil,
  PhCaretLeft,
  PhPencilSimple,
  PhDotsThreeVertical,
  PhPushPin,
  PhMapPin,
  PhTrash,
  PhCheck,
  PhX,
  PhArrowCounterClockwise,
  PhLightbulb,
  PhCheckSquare,
  PhBell,
  PhBellSlash,
  PhBellRinging,
  PhUsersThree,
  PhCaretRight,
  PhArrowsClockwise,
} from '@phosphor-icons/vue';
import { REF_LINK_REGEX, renderRefLink, injectRefLinkIcons } from '@/utils/refLink';
import { resolveMarkdownFileUrls } from '@/utils/fileUrl';
import ReminderPicker from '@/components/ReminderPicker.vue';
import ReactionBar from '@/components/ReactionBar.vue';
import CommentThread from '@/components/CommentThread.vue';
import type { NoteReactionSummaryItem } from '@/api';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const route = useRoute();
const router = useRouter();
const store = useNotesStore();
const auth = useAuthStore();
const groupsStore = useGroupsStore();
const toast = useToast();
const note = ref<Note | null>(null);
const rendered = ref('');
const loading = ref(true);

// 详情页分享设置
const isMyNote = computed(() => note.value && (!note.value.userId || note.value.userId === auth.user?.id));
const isShared = computed(() => note.value?.visibility === 'shared');
const sharedGroupIds = computed(() => note.value?.sharedGroupIds ?? []);
const sharedGroupNames = computed(() =>
  sharedGroupIds.value.map(id => groupsStore.groups.find(g => g.id === id)?.name).filter(Boolean) as string[]
);
const editGrants = ref<NoteEditGrant[]>([]);
async function loadEditGrants() {
  if (!note.value || !isShared.value || !isMyNote.value) {
    editGrants.value = [];
    return;
  }
  try {
    const res = await api.listNoteEditGrants(note.value.id);
    editGrants.value = res.data;
  } catch { editGrants.value = []; }
}

// 待审编辑申请 section (仅 shared + 作者本人 + 有 pending 申请). 复用 GroupDetail 同款 API
const editRequests = ref<NoteEditRequest[]>([]);
const dismissedEditRequestIds = ref<Set<string>>(new Set());
const visibleEditRequests = computed(() => editRequests.value.filter(r => !dismissedEditRequestIds.value.has(r.id)));
async function loadEditRequests() {
  if (!note.value || !isShared.value || !isMyNote.value) {
    editRequests.value = [];
    return;
  }
  try {
    const res = await api.listNoteEditRequests(note.value.id);
    // 仅 pending 状态进 UI (后端可能返历史含 approved/rejected/canceled)
    editRequests.value = (res.data || []).filter(r => r.status === 'pending');
  } catch { editRequests.value = []; }
}
async function approveEditRequest(requestId: string) {
  if (!note.value) return;
  try {
    await api.approveNoteEditRequest(note.value.id, requestId);
    editRequests.value = editRequests.value.filter(r => r.id !== requestId);
    toast.show('已同意, 申请人获得编辑权限', 'success');
  } catch (e: any) {
    toast.show(e?.message || '操作失败', 'error');
  }
}
async function rejectEditRequest(requestId: string) {
  if (!note.value) return;
  try {
    await api.rejectNoteEditRequest(note.value.id, requestId);
    editRequests.value = editRequests.value.filter(r => r.id !== requestId);
    toast.show('已拒绝申请', 'success');
  } catch (e: any) {
    toast.show(e?.message || '操作失败', 'error');
  }
}
function dismissEditRequest(requestId: string) {
  // 忽略 = 仅本地从 UI 隐藏, 不调 API (申请仍 pending, server 状态不变, 下次刷新仍显示)
  dismissedEditRequestIds.value.add(requestId);
}
async function setEditPermission(perm: 'admin' | 'all') {
  if (!note.value) return;
  if ((note.value.editPermission || 'admin') === perm) return;
  try {
    const res = await store.updateNote(note.value.id, { editPermission: perm } as any);
    // store.updateNote 不一定同步 note.value (本地 ref 来自 api.getNote, 不在 store.notes 里时 watch 失效)
    // 直接 mutate 字段保证 reactive UI 立刻反映
    note.value.editPermission = res.editPermission ?? perm;
    toast.show(perm === 'admin' ? '已设为仅管理员可编辑' : '已设为所有人可编辑', 'success');
  } catch (e: any) {
    toast.show(e?.message || '操作失败', 'error');
  }
}
const confirmRevokeGrant = ref<{ userId: string; nickname: string } | null>(null);
useEscToClose(confirmRevokeGrant, null);
function askRevokeGrant(userId: string, nickname: string) {
  // bug 修: 同时关 grants popover, 防 popover (z=9999) 浮在 modal (z=200) 之上挡住确认按钮
  showGrantsPopup.value = false;
  confirmRevokeGrant.value = { userId, nickname };
}
async function doRevokeGrant() {
  if (!confirmRevokeGrant.value || !note.value) return;
  const targetUserId = confirmRevokeGrant.value.userId;
  confirmRevokeGrant.value = null;
  try {
    await api.revokeNoteEditGrant(note.value.id, targetUserId);
    editGrants.value = editGrants.value.filter(g => g.userId !== targetUserId);
    toast.show('已撤销编辑权限', 'success');
  } catch (e: any) {
    toast.show(e?.message || '操作失败', 'error');
  }
}
// 群名展开 popover
const showSharedGroupsPopup = ref(false);
// 已授权 popover: 收到胶囊里, 点击展开 (不常用功能不独占一行)
const showGrantsPopup = ref(false);

// 编辑历史 popover (作者 + 群成员都能看, 仅 shared + editorCount > 0 显示). lazy load 不预拉.
const editorCount = computed(() => note.value?.editorCount ?? 0);
const editHistory = ref<NoteEditHistoryRow[]>([]);
const showEditHistoryPopup = ref(false);
async function toggleEditHistory() {
  showEditHistoryPopup.value = !showEditHistoryPopup.value;
  showSharedGroupsPopup.value = false;
  showGrantsPopup.value = false;
  if (showEditHistoryPopup.value && editHistory.value.length === 0 && note.value) {
    try {
      const res = await api.getNoteEditHistory(note.value.id);
      editHistory.value = res.data;
    } catch (e: any) {
      toast.show(e?.message || '加载编辑历史失败', 'error');
    }
  }
}
const openEditModal = inject<(note: Note, fullscreen?: boolean) => void>('openEditModal');
const detailTitle = inject<Ref<string>>('detailTitle');
const hasRefPreviewPending = inject<Ref<boolean>>('hasRefPreviewPending');
const restoreRefPreview = inject<() => void>('restoreRefPreview');

// 命名约定: quink=灵感, note=笔记, todo=待办. link 类型已废弃删
const typeLabels: Record<string, string> = { quink: '灵感', note: '笔记', todo: '待办' };
// type chip 颜色跟 NoteCard 完全一致 (避免三种 type 都用同主题色看着错乱)
// quink 固定 blueberry 不跟主题 (.type-chip-quink 定义在 style.css 含 dark 适配)
const typeColor: Record<string, string> = {
  quink: 'type-chip-quink',
  note: 'bg-emerald-100 text-emerald-600',
  todo: 'bg-amber-100 text-amber-600',
};
const sharedCount = computed(() => sharedGroupIds.value.length);

async function renderContent(content: string): Promise<string> {
  try {
    // 历史污染清理: 旧版 RichEditor 的播放按钮 ▶/⏸ 被 Vditor 序列化进了 markdown,这里剥掉
    let md = content.replace(/[▶⏸]/g, '').replace(/^\* \[([ xX])\]/gm, (_, c) => `- [${c.toLowerCase()}]`);
    md = md.replace(REF_LINK_REGEX, (_, label, href) => renderRefLink(label, href, 30));
    md = resolveMarkdownFileUrls(md);  // 文件链接裸名拼 /api/uploads/ 前缀
    let html = await Vditor.md2html(md, { cdn: '/vditor' } as any);
    html = injectRefLinkIcons(html);
    // 详情页 task list checkbox 可点击: lute 默认输出 disabled,浏览器对 disabled input 不触发 click 事件。
    // 用 DOM API 稳剥(regex 易漏: 属性顺序 / 空值 disabled="" / 自闭合斜杠 等变体)
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('input[type="checkbox"]').forEach((i) => i.removeAttribute('disabled'));
    return tmp.innerHTML;
  } catch (e) {
    console.error('[NoteDetail] Vditor render failed:', e);
    const esc = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div style="white-space:pre-wrap">${esc}</div>`;
  }
}

async function loadNoteAndReminder() {
  await loadNote();
  await Promise.all([loadReminder(), loadEditRequests()]);
}
async function loadNote() {
  const id = route.params.id as string;
  try {
    const res = await api.getNote(id);
    note.value = res.data;
    if (detailTitle) detailTitle.value = typeLabels[res.data.type] + '详情';
    // 不直接渲染,let watch(note.value.content) 自动触发 renderContent(避免双重渲染)
    // shared 笔记并发拉群名 + 已授权列表
    if (res.data.visibility === 'shared') {
      if (groupsStore.groups.length === 0) groupsStore.loadGroups().catch(() => {});
      loadEditGrants();
    }
  } catch (e) {
    console.error('[NoteDetail] load note failed:', e);
    note.value = null;
  }
  loading.value = false;
}

// 任务列表 checkbox 点击 → toggle markdown 源里对应的 - [x] / - [ ] + 后台保存
// 注: lute md2html 输出的 task list ul 不一定带 .vditor-task 类(只有 IR 模式编辑器内才加),
// 所以这里不靠 class 过滤,直接拦截所有 input[type=checkbox] —— markdown 渲染产物里只有 task 才会产生 input
async function onContentClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target.tagName !== 'INPUT') return;
  const input = target as HTMLInputElement;
  if (input.type !== 'checkbox') return;
  if (!note.value) return;
  e.preventDefault();
  e.stopPropagation();

  // 算这是渲染区第几个 checkbox(用于跟 markdown 源里第 N 个 task 标记对应)
  const wrapper = e.currentTarget as HTMLElement;
  const allCheckboxes = Array.from(wrapper.querySelectorAll('input[type="checkbox"]'));
  const taskIndex = allCheckboxes.indexOf(input);
  if (taskIndex < 0) return;

  // markdown 源里按行匹配 task 标记: 兼容 `-` / `*` 列表标记 和 `[x] / [X] / [ ]` 三种状态。
  // 旧版 RichEditor 序列化的是 `* [X]`(大写 + 星号),新版应该是 `- [x]`,这里两种都支持。
  // 替换时保留原 marker(`-` 或 `*`),只 toggle 中间的 x ↔ space
  const oldContent = note.value.content;
  let idx = 0;
  const newContent = oldContent.replace(/^(\s*[-*]\s+\[)([xX ])(\])/gm, (match, prefix, mark, suffix) => {
    if (idx === taskIndex) { idx++; return `${prefix}${mark === ' ' ? 'x' : ' '}${suffix}`; }
    idx++; return match;
  });
  if (newContent === oldContent) return;

  // 乐观更新: 立即 mutate 本地 content,UI 通过 watch 自动重渲染;同时立即 toggle DOM 视觉
  input.checked = !input.checked;
  note.value.content = newContent;
  try {
    // version: 兜底 URL 直接打开 (note 不在 store viewState) 场景, store 自动注入路径走不到. res.version 回写避免连续 toggle 用旧 version
    const res = await store.updateNote(note.value.id, { content: newContent, version: note.value.version });
    if (res?.version != null && note.value) note.value.version = res.version;
  } catch (err) {
    if (note.value) note.value.content = oldContent;
    input.checked = !input.checked;
    console.error('[NoteDetail] toggle task failed:', err);
  }
}

// 监听 content 变化触发重渲染(loadNote / 编辑保存 / task toggle 都走这里统一)
// 防 race: 旧 content 的 renderContent 还 pending 时新内容触发,旧的若后完成会覆盖新 html。
// onCleanup 标记过期,过期结果不回写
watch(() => note.value?.content, async (newContent, _old, onCleanup) => {
  let cancelled = false;
  onCleanup(() => { cancelled = true; });
  if (!newContent) { rendered.value = ''; return; }
  const html = await renderContent(newContent);
  if (cancelled) return;
  rendered.value = html;
}, { immediate: true });

// store 重新 fetch 后笔记数组整体被替换,同步 note.value 引用(让后续 mutate 能直接生效)
watch(() => store.notes, () => {
  if (!note.value) return;
  const updated = store.notes.find(n => n.id === note.value!.id);
  if (updated && updated !== note.value) note.value = updated;
}, { deep: true });

// 三点菜单 (置顶 / 移至类型 / [todo] 标记完成 / 删除); 编辑保留 header 上独立按钮高频路径
const showMenu = ref(false);
const menuBtn = ref<HTMLElement>();
const menuPos = ref<{ top: string; right: string }>({ top: '0px', right: '0px' });
function toggleMenu() {
  if (showMenu.value) { showMenu.value = false; return; }
  if (menuBtn.value) {
    const r = unzoomRect(menuBtn.value);
    const { vw } = unzoomViewport();
    menuPos.value = {
      top: (r.bottom + 4) + 'px',
      right: (vw - r.right) + 'px',
    };
  }
  showMenu.value = true;
}

async function moveTo(type: 'quink' | 'note' | 'todo') {
  if (!note.value) return;
  const res = await store.updateNote(note.value.id, { type, version: note.value.version } as any);
  if (res && note.value) {
    note.value.type = res.type ?? type;
    if (res.version != null) note.value.version = res.version;
  }
  showMenu.value = false;
}

async function togglePin() {
  if (!note.value) return;
  await store.togglePin(note.value.id);
  showMenu.value = false;
}

async function toggleTodo() {
  if (!note.value || note.value.type !== 'todo') return;
  await store.toggleTodo(note.value.id);
  showMenu.value = false;
}

// 待办提醒: 点菜单"设置/编辑提醒" → 弹 ReminderPicker. 走 personal-reminder 接口.
const reminderPickerOpen = ref(false);
const myPersonalReminder = ref<{ dueAt: string; rrule: string | null } | null>(null);
const myGroupReminders = ref<Array<{ groupId: string; dueAt: string; rrule: string | null }>>([]);
const groupReminderMuted = ref(false);
async function loadReminder() {
  if (!note.value || note.value.type !== 'todo') return;
  try {
    const res = await api.getNoteReminders(note.value.id);
    myPersonalReminder.value = res.data.personal;
    myGroupReminders.value = res.data.group;
    groupReminderMuted.value = !!res.data.muted;
  } catch (e) {
    console.error('[NoteDetail] loadReminder failed:', e);
  }
}
// 个人提醒 + 群提醒并存时两个 chip 一起显示 (个人在前, 整行右对齐). 群名退到 title hover.
function fmtReminder(dueAt: string) { return dayjs(dueAt).format('YYYY-MM-DD HH:mm'); }
const groupReminderName = computed(() => {
  const gid = myGroupReminders.value[0]?.groupId;
  return gid ? groupsStore.groups.find(g => g.id === gid)?.name : '';
});
async function toggleGroupReminderMute() {
  if (!note.value) return;
  const next = !groupReminderMuted.value;
  groupReminderMuted.value = next;
  try {
    if (next) await api.muteNoteGroupReminder(note.value.id);
    else await api.unmuteNoteGroupReminder(note.value.id);
    toast.show(next ? '已屏蔽此待办的群提醒' : '已恢复接收', 'success');
  } catch (e: any) {
    groupReminderMuted.value = !next;
    toast.show(e?.message || '操作失败', 'error');
  }
}
function openReminderPicker() {
  showMenu.value = false;
  reminderPickerOpen.value = true;
}
async function saveReminder(payload: { remindAt: string | null; rrule: string | null }) {
  if (!note.value) return;
  // 切到 personal-reminder 接口 (老 todoDue/todoRemindRrule schema 列已删)
  try {
    if (payload.remindAt) {
      await api.setPersonalReminder(note.value.id, { dueAt: payload.remindAt, rrule: payload.rrule });
      myPersonalReminder.value = { dueAt: payload.remindAt, rrule: payload.rrule };
    } else {
      await api.deletePersonalReminder(note.value.id);
      myPersonalReminder.value = null;
    }
    toast.show(payload.remindAt ? '已设置提醒' : '已清除提醒', 'success');
  } catch (e) {
    console.error('[NoteDetail] saveReminder failed:', e);
    toast.show('保存失败', 'error');
  }
}

const confirmDelete = ref(false);
function askDelete() {
  showMenu.value = false;
  confirmDelete.value = true;
}
async function doDelete() {
  if (!note.value) return;
  const id = note.value.id;
  // 留个 snapshot 给撤销用 (跳页后 note ref 会被清, 必须先拷贝)
  const snapshot = { ...note.value };
  confirmDelete.value = false;
  // try-catch 兜底 — 后端 403 / 网络错时之前 await throw 后续语句全跳过 = "什么都不提示"
  try {
    await store.deleteNote(id);
  } catch (e: any) {
    toast.show(e?.message || '删除失败', 'error', 3000);
    return;
  }
  goBack();
  toast.show('已移到回收站', {
    duration: 5000,
    action: {
      label: '撤销',
      onClick: async () => {
        const n = await store.undoDelete([snapshot]);
        if (!n) toast.show('撤销失败', 'error');
      },
    },
  });
}

function goBack() {
  // 有预览栈等待恢复 → 先显示预览,不导航
  if (hasRefPreviewPending?.value) {
    restoreRefPreview?.();
    return;
  }
  if (window.history.length > 1) {
    router.back();
  } else {
    router.push('/quink');
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  // ESC 分级: 删除确认 modal > 三点菜单 > 返回页面 (避免 modal 开着按 ESC 顺带跳出详情页)
  if (confirmDelete.value) { confirmDelete.value = false; return; }
  if (showMenu.value) { showMenu.value = false; return; }
  goBack();
}

// reaction summary 本地 ref 让 ReactionBar 走 v-model 模式. loadNote 完成后从 note.value 同步过来.
// SSE 别人 reaction 变化时增量更新 (server publish 给所有共享群成员 + 作者).
const reactionSummary = ref<NoteReactionSummaryItem[]>([]);
function onReactionUpdate(newSummary: NoteReactionSummaryItem[]) {
  reactionSummary.value = newSummary;
  if (note.value) note.value.reactionSummary = newSummary;
}
function onReactionChangedSSE(e: any) {
  const { noteId, summary } = e.detail || {};
  if (!note.value || noteId !== note.value.id) return;
  reactionSummary.value = summary;
  note.value.reactionSummary = summary;
}
watch(() => note.value?.reactionSummary, (newSum) => {
  if (newSum) reactionSummary.value = newSum;
}, { immediate: true });

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('quink-note-reaction-changed' as any, onReactionChangedSSE);
  loadNoteAndReminder();
});


watch(() => route.params.id, () => { loadNoteAndReminder(); });
onUnmounted(() => {
  if (detailTitle) detailTitle.value = '';
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('quink-note-reaction-changed' as any, onReactionChangedSSE);
});
</script>

<template>
  <div class="px-4 md:px-8 py-6">
    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <div v-else-if="!note" class="text-center py-16">
      <div class="mb-3 flex justify-center text-gray-300">
        <PhNotePencil size="3rem" weight="fill" />
      </div>
      <p class="text-gray-500 text-sm">笔记不存在或已被删除</p>
      <button @click="goBack" class="mt-4 text-xs text-primary hover:underline">返回</button>
    </div>

    <div v-else>
      <!-- Header -->
      <div class="flex items-center gap-3 mb-6 flex-wrap">
        <button @click="goBack" class="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400">
          <PhCaretLeft size="1.25rem" weight="fill" />
        </button>
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-xs px-2 py-0.5 rounded-full font-medium shrink-0 whitespace-nowrap" :class="typeColor[note.type]">{{ typeLabels[note.type] }}</span>
          <!-- 跟 NoteCard 同款"已分享"/作者头像 chip -->
          <span v-if="isMyNote && isShared && sharedCount > 0"
            class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-primary-light text-primary-dark select-none shrink-0 whitespace-nowrap"
            :title="`已分享到 ${sharedCount} 个群`">
            <PhUsersThree size="0.75rem" weight="fill" />
            <span>已分享</span>
          </span>
          <span v-else-if="!isMyNote && (note as any).authorNickname"
            class="inline-flex items-center gap-1 text-xs text-gray-500 select-none min-w-0"
            :title="`@${(note as any).authorNickname}`">
            <img v-if="(note as any).authorAvatar" :src="resolveFileThumbUrl((note as any).authorAvatar)"
              @error="thumbErrorFallback($event, resolveFileUrl((note as any).authorAvatar))"
              class="w-5 h-5 rounded-full object-cover shrink-0" alt="" />
            <div v-else class="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[9px] font-bold shrink-0">
              {{ ((note as any).authorNickname || '?').charAt(0).toUpperCase() }}
            </div>
            <span class="truncate min-w-0">{{ (note as any).authorNickname }}</span>
          </span>
          <span v-if="note.category" class="text-xs text-gray-400 truncate min-w-0">{{ note.category }}</span>
        </div>
        <span class="ml-auto text-xs text-gray-400 shrink-0 whitespace-nowrap">{{ dayjs(note.createdAt).format('YYYY-MM-DD HH:mm') }}</span>
        <button @click="openEditModal?.(note)" class="px-3 py-1 text-xs rounded-lg hover:bg-gray-100 text-gray-400 inline-flex items-center gap-1">
          <PhPencilSimple size="0.875rem" weight="fill" />
          <span>编辑</span>
        </button>
        <button ref="menuBtn" @click.stop="toggleMenu" class="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400">
          <PhDotsThreeVertical size="1.25rem" weight="bold" />
        </button>
      </div>


      <!-- 三点菜单 popover (Teleport 避祖先 overflow + 同步遮罩, 跟 NoteCard 同模式) -->
      <Teleport to="body">
        <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95"
          leave-active-class="transition duration-75 ease-in" leave-to-class="opacity-0 scale-95">
          <div v-if="showMenu" class="fixed bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-[var(--z-overlay)] min-w-[130px] [&_svg]:mt-px"
            :style="menuPos">
            <button @click.stop="togglePin"
              class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
              <PhPushPin v-if="note.pinned" size="0.875rem" weight="fill" />
              <PhMapPin v-else size="0.875rem" weight="fill" />
              <span>{{ note.pinned ? '取消置顶' : '置顶' }}</span>
            </button>
            <button v-if="note.type === 'todo'" @click.stop="toggleTodo"
              class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
              <PhArrowCounterClockwise v-if="note.todoStatus === 'done'" size="0.875rem" weight="fill" />
              <PhCheck v-else size="0.875rem" weight="fill" />
              <span>{{ note.todoStatus === 'done' ? '标记未完成' : '标记已完成' }}</span>
            </button>
            <button v-if="note.type === 'todo'" @click.stop="openReminderPicker"
              class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
              <PhBell size="0.875rem" weight="fill" />
              <span>{{ myPersonalReminder ? '编辑个人提醒' : '设置个人提醒' }}</span>
            </button>
            <!-- 屏蔽此待办的群提醒 toggle, 跟 NoteCard 同款. 仅有可见群提醒时显示 -->
            <button v-if="note.type === 'todo' && myGroupReminders.length > 0" @click.stop="toggleGroupReminderMute(); showMenu = false"
              class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
              <PhBellSlash v-if="!groupReminderMuted" size="0.875rem" weight="fill" />
              <PhBell v-else size="0.875rem" weight="fill" />
              <span>{{ groupReminderMuted ? '恢复此待办群提醒' : '屏蔽此待办群提醒' }}</span>
            </button>
            <div class="border-t border-gray-100 my-0.5"></div>
            <!-- 移至类型 (quink=灵感, note=笔记): 当前 type 不显示, 避免"移至自身"无效项 -->
            <button v-if="note.type !== 'quink'" @click.stop="moveTo('quink')"
              class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
              <PhLightbulb size="0.875rem" weight="fill" />
              <span>移至灵感</span>
            </button>
            <button v-if="note.type !== 'note'" @click.stop="moveTo('note')"
              class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
              <PhNotePencil size="0.875rem" weight="fill" />
              <span>移至笔记</span>
            </button>
            <button v-if="note.type !== 'todo'" @click.stop="moveTo('todo')"
              class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
              <PhCheckSquare size="0.875rem" weight="fill" />
              <span>移至待办</span>
            </button>
            <!-- 非作者不显示删除按钮. NoteDetail 是独立 route 拿不到群上下文,
                 无法判断我是否该笔记某共享群的 admin → 别人的笔记一律隐藏删除, 让用户去群组页 NoteCard 删 -->
            <div v-if="isMyNote" class="border-t border-gray-100 my-0.5"></div>
            <button v-if="isMyNote" @click.stop="askDelete()"
              class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 transition-colors">
              <PhTrash size="0.875rem" weight="fill" />
              <span>删除</span>
            </button>
          </div>
        </Transition>
        <div v-if="showMenu" class="fixed inset-0 z-[var(--z-overlay-backdrop)]" @click="showMenu = false" />
      </Teleport>

      <!-- 提醒设置弹窗 -->
      <ReminderPicker
        v-model:open="reminderPickerOpen"
        :remind-at="myPersonalReminder?.dueAt ?? null"
        :rrule="myPersonalReminder?.rrule ?? null"
        @save="saveReminder"
      />

      <!-- 删除确认弹窗 (跟 TopBar 批量删除同模式) -->
      <Teleport to="body">
        <Transition name="modal">
          <div v-if="confirmDelete" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
            <div class="absolute inset-0 bg-black/30" @click="confirmDelete = false" />
            <div class="relative bg-white rounded-xl shadow-xl p-5 w-80 text-center">
              <p class="text-sm text-gray-700 mb-1">
                {{ isMyNote ? '删除内容' : `确认删除 @${(note as any)?.authorNickname || '某人'} 的笔记？` }}
              </p>
              <p class="text-xs text-gray-400 mb-4">
                {{ isMyNote ? '可在回收站找回' : '群成员将看不到这条笔记 (作者本人仍可恢复)' }}
              </p>
              <div class="flex gap-2 justify-center">
                <button @click="confirmDelete = false" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
                <button @click="doDelete" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
              </div>
            </div>
          </div>
        </Transition>
      </Teleport>

      <!-- Summary -->
      <p v-if="note.summary" class="text-sm text-gray-500 italic mb-4">{{ note.summary }}</p>

      <!-- Tags -->
      <div v-if="note.tags?.length" class="flex flex-wrap gap-1.5 mb-4">
        <span v-for="tag in note.tags" :key="tag" class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">#{{ tag }}</span>
      </div>

      <!-- 分享设置 (左, 仅作者+shared) + 提醒 chips (右, todo + 有提醒) 合并成一行. 任一条件成立都显示这行.
           -mt-4 抵消顶部 header 的 mb-6, 视觉间距 ~8px 紧贴 (跟其他次级行同款风格) -->
      <div v-if="(isShared && isMyNote) || (note.type === 'todo' && (myPersonalReminder || myGroupReminders.length > 0))"
        class="-mt-4 mb-4 flex items-center gap-2 text-xs relative flex-wrap">
        <!-- 左: 分享设置 (仅 shared + 作者本人) -->
        <template v-if="isShared && isMyNote">
          <button @click.stop="showSharedGroupsPopup = !showSharedGroupsPopup; showGrantsPopup = false"
            class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-light text-primary-dark font-medium hover:bg-primary/20 transition-colors">
            <PhUsersThree size="0.75rem" weight="fill" />
            已分享到 {{ sharedGroupIds.length }} 个群
          </button>
          <!-- 编辑权限胶囊 (单胶囊点击切换 admin/all, 后跟切换图标) -->
          <button @click="setEditPermission((note.editPermission || 'admin') === 'admin' ? 'all' : 'admin')"
            class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-light text-primary-dark font-medium hover:bg-primary/20 transition-colors">
            {{ (note.editPermission || 'admin') === 'admin' ? '管理员可编辑' : '所有人可编辑' }}
            <PhArrowsClockwise size="0.75rem" weight="bold" />
          </button>
          <!-- 已授权小胶囊 (仅 editPermission=admin 时有意义: 'all' 时所有人都能改, 白名单无用; >0 条才显示).
               包独立 relative 容器让 popover 锚定到按钮下方而非整行右边 -->
          <span v-if="(note.editPermission || 'admin') === 'admin' && editGrants.length > 0" class="relative inline-block">
            <button @click.stop="showGrantsPopup = !showGrantsPopup; showSharedGroupsPopup = false"
              class="px-2 py-0.5 rounded-full bg-primary-light text-primary-dark font-medium hover:bg-primary/20 transition-colors">
              额外授权 {{ editGrants.length }} 人
            </button>
            <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95"
              leave-active-class="transition duration-75 ease-in" leave-to-class="opacity-0 scale-95">
              <div v-if="showGrantsPopup"
                class="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2 z-[var(--z-overlay)] w-[260px] max-h-[280px] overflow-y-auto space-y-1">
                <div v-for="g in editGrants" :key="g.userId"
                  class="flex items-center gap-2 hover:bg-gray-50 rounded-lg p-1.5">
                  <img v-if="g.avatar" :src="resolveFileThumbUrl(g.avatar)"
                    @error="thumbErrorFallback($event, resolveFileUrl(g.avatar))"
                    class="w-6 h-6 rounded-full object-cover shrink-0" alt="" />
                  <div v-else class="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-bold shrink-0">
                    {{ (g.nickname || '?').charAt(0).toUpperCase() }}
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-xs font-medium truncate">{{ g.nickname || '?' }}</div>
                    <div class="text-[10px] text-gray-400">{{ dayjs(g.grantedAt).format('MM-DD HH:mm') }}</div>
                  </div>
                  <button @click="askRevokeGrant(g.userId, g.nickname || '?')"
                    class="px-2 py-1 text-[11px] rounded-lg bg-red-50 text-red-500 hover:bg-red-100 inline-flex items-center gap-1">
                    <PhTrash size="0.75rem" weight="bold" /> 撤销
                  </button>
                </div>
              </div>
            </Transition>
          </span>

          <!-- 群名 popover (锚定到整行 left, 因为分享胶囊在最左) -->
          <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95"
            leave-active-class="transition duration-75 ease-in" leave-to-class="opacity-0 scale-95">
            <div v-if="showSharedGroupsPopup && sharedGroupNames.length > 0"
              class="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2 z-[var(--z-overlay)] min-w-[160px] max-w-[280px]">
              <div v-for="name in sharedGroupNames" :key="name" class="text-xs text-gray-600 py-1 px-2 truncate">{{ name }}</div>
            </div>
          </Transition>

          <!-- 共用 backdrop 关两个 popover -->
          <div v-if="showSharedGroupsPopup || showGrantsPopup" class="fixed inset-0 z-[var(--z-overlay-backdrop)]"
            @click="showSharedGroupsPopup = false; showGrantsPopup = false" />
        </template>

        <!-- 右: 待办提醒 chips (个人 + 群并存时一起显示, 个人在前). 点个人 chip 改个人提醒; 点群 chip 切换 mute -->
        <div v-if="note.type === 'todo' && (myPersonalReminder || myGroupReminders.length > 0)"
          class="ml-auto flex items-center gap-3">
          <span v-if="myPersonalReminder"
            class="inline-flex items-center gap-1 cursor-pointer hover:opacity-70 whitespace-nowrap text-amber-600"
            :title="`${fmtReminder(myPersonalReminder.dueAt)}${myPersonalReminder.rrule ? '（重复: ' + myPersonalReminder.rrule + '）' : ''}（个人提醒）`"
            @click="openReminderPicker">
            <PhBellRinging v-if="myPersonalReminder.rrule" size="0.875rem" weight="fill" />
            <PhBell v-else size="0.875rem" weight="fill" />
            <span>个人提醒</span>
            <span class="tabular-nums">{{ fmtReminder(myPersonalReminder.dueAt) }}</span>
          </span>
          <span v-if="myGroupReminders.length > 0"
            class="inline-flex items-center gap-1 cursor-pointer hover:opacity-70 whitespace-nowrap"
            :class="groupReminderMuted ? 'text-gray-400' : 'text-amber-600'"
            :title="`${fmtReminder(myGroupReminders[0].dueAt)}${myGroupReminders[0].rrule ? '（重复: ' + myGroupReminders[0].rrule + '）' : ''}（群提醒${groupReminderName ? ' · ' + groupReminderName : ''}${groupReminderMuted ? ' · 已屏蔽' : ''}）`"
            @click="toggleGroupReminderMute">
            <PhBellSlash v-if="groupReminderMuted" size="0.875rem" weight="fill" />
            <PhBellRinging v-else-if="myGroupReminders[0].rrule" size="0.875rem" weight="fill" />
            <PhBell v-else size="0.875rem" weight="fill" />
            <span>群提醒</span>
            <span class="tabular-nums">{{ fmtReminder(myGroupReminders[0].dueAt) }}</span>
          </span>
        </div>
      </div>

      <!-- 待审编辑申请 section (仅 shared + 作者本人 + 有 pending). 同意/拒绝调 API, 忽略仅本地隐藏 -->
      <section v-if="isShared && isMyNote && visibleEditRequests.length > 0"
        class="mb-4 bg-gray-50 rounded-xl p-4">
        <h3 class="text-sm font-medium mb-3">待审编辑申请 ({{ visibleEditRequests.length }})</h3>
        <div class="space-y-2">
          <div v-for="req in visibleEditRequests" :key="req.id"
            class="bg-white rounded-lg p-3 space-y-2">
            <div class="flex items-center gap-2">
              <img v-if="req.avatar" :src="resolveFileThumbUrl(req.avatar)"
                @error="thumbErrorFallback($event, resolveFileUrl(req.avatar))"
                alt="" class="w-7 h-7 rounded-full object-cover shrink-0" />
              <div v-else class="w-7 h-7 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold shrink-0">
                {{ (req.nickname || '?').charAt(0).toUpperCase() }}
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-sm">
                  <span class="font-medium">{{ req.nickname || '群成员' }}</span>
                  <span class="text-gray-400 text-xs ml-2">{{ dayjs(req.createdAt).format('MM-DD HH:mm') }}</span>
                </div>
                <div class="text-[11px] text-gray-500">申请编辑这条笔记</div>
              </div>
              <button @click="approveEditRequest(req.id)"
                class="px-2 py-1 text-xs rounded-lg bg-primary-light text-primary-dark hover:bg-primary/20 inline-flex items-center gap-1">
                <PhCheck size="0.75rem" weight="bold" /> 同意
              </button>
              <button @click="rejectEditRequest(req.id)"
                class="px-2 py-1 text-xs rounded-lg bg-red-50 text-red-500 hover:bg-red-100 inline-flex items-center gap-1">
                <PhX size="0.75rem" weight="bold" /> 拒绝
              </button>
              <button @click="dismissEditRequest(req.id)"
                class="px-2 py-1 text-xs rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 inline-flex items-center gap-1"
                title="仅本地隐藏, 申请仍 pending">
                忽略
              </button>
            </div>
            <div v-if="req.message" class="text-xs text-gray-500 pl-9 italic">"{{ req.message }}"</div>
          </div>
        </div>
      </section>

      <!-- 编辑历史行 (shared 笔记 + editorCount > 0 时显示). 跟分享设置行分开避免破坏 isMyNote 条件. -->
      <div v-if="isShared && editorCount > 0" class="mb-4 flex items-center gap-2 text-xs relative flex-wrap">
        <span class="relative inline-block">
          <button @click.stop="toggleEditHistory"
            class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-light text-primary-dark font-medium hover:bg-primary/20 transition-colors">
            <PhPencilSimple size="0.75rem" weight="fill" />
            {{ editorCount }} 人编辑过
          </button>
          <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95"
            leave-active-class="transition duration-75 ease-in" leave-to-class="opacity-0 scale-95">
            <div v-if="showEditHistoryPopup"
              class="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2 z-[var(--z-overlay)] w-[280px] max-h-[320px] overflow-y-auto space-y-1">
              <div v-if="editHistory.length === 0" class="text-xs text-gray-400 px-2 py-3 text-center">暂无编辑记录</div>
              <div v-for="h in editHistory" :key="h.id"
                class="flex items-center gap-2 hover:bg-gray-50 rounded-lg p-1.5">
                <img v-if="h.avatar" :src="resolveFileThumbUrl(h.avatar)"
                  @error="thumbErrorFallback($event, resolveFileUrl(h.avatar))"
                  class="w-6 h-6 rounded-full object-cover shrink-0" alt="" />
                <div v-else class="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-bold shrink-0">
                  {{ (h.nickname || '?').charAt(0).toUpperCase() }}
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-xs font-medium truncate">{{ h.nickname || '?' }}</div>
                  <div class="text-[10px] text-gray-400">{{ dayjs(h.editedAt).format('MM-DD HH:mm') }}</div>
                </div>
              </div>
            </div>
          </Transition>
        </span>
        <div v-if="showEditHistoryPopup" class="fixed inset-0 z-[var(--z-overlay-backdrop)]"
          @click="showEditHistoryPopup = false" />
      </div>

      <!-- 撤销授权确认 modal -->
      <Teleport to="body">
        <Transition name="modal">
          <div v-if="confirmRevokeGrant" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
            <div class="absolute inset-0 bg-black/30" @click="confirmRevokeGrant = null" />
            <div class="relative bg-white rounded-xl shadow-xl p-5 w-80 text-center">
              <p class="text-sm text-gray-700 mb-1">撤销编辑权限</p>
              <p class="text-xs text-gray-400 mb-4">
                「{{ confirmRevokeGrant?.nickname }}」将失去编辑此笔记的权限，再次编辑需重新申请
              </p>
              <div class="flex gap-2 justify-center">
                <button @click="confirmRevokeGrant = null"
                  class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
                <button @click="doRevokeGrant"
                  class="px-4 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 font-medium">撤销</button>
              </div>
            </div>
          </div>
        </Transition>
      </Teleport>

      <!-- Content; @click 上拦截 task list checkbox 点击实现状态切换 -->
      <div class="bg-white rounded-2xl shadow-sm p-6 md:p-8 note-content note-detail-content" @click="onContentClick">
        <div class="vditor-reset" v-html="rendered" />
      </div>

      <!-- 共享笔记的 reaction + 评论区 (private 笔记无意义不显示) -->
      <section v-if="isShared" class="mt-4 bg-white rounded-2xl shadow-sm p-6 md:p-8">
        <div class="mb-4">
          <h3 class="text-xs font-medium text-gray-500 mb-2">反应</h3>
          <ReactionBar
            :note-id="note.id"
            :summary="reactionSummary"
            mode="full"
            @update:summary="onReactionUpdate"
          />
        </div>
        <div class="border-t border-gray-100 pt-4">
          <h3 class="text-xs font-medium text-gray-500 mb-3">评论</h3>
          <CommentThread
            :note-id="note.id"
            :can-delete-any="!!isMyNote"
          />
        </div>
      </section>
    </div>
  </div>
</template>
