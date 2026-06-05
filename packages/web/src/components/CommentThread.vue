<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { api, type NoteComment } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import { resolveFileThumbUrl, resolveFileUrl, thumbErrorFallback } from '@/utils/fileUrl';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import {
  PhPaperPlaneTilt,
  PhPencilSimple,
  PhTrash,
  PhArrowBendUpLeft,
} from '@phosphor-icons/vue';

dayjs.extend(relativeTime);

const props = defineProps<{
  noteId: string;
  // 笔记作者 + 群 admin 才能删任何评论. 其他人只能删自己的 (内部 canDelete 用)
  canDeleteAny?: boolean;
}>();

const auth = useAuthStore();
const toast = useToast();
const comments = ref<NoteComment[]>([]);
const loading = ref(false);
const loaded = ref(false);

// 输入区: replyingTo = null = 顶层评论, 否则 = 顶层评论 id (单层 thread, 二级及以下挂同一 root)
const replyingTo = ref<string | null>(null);
const replyingNickname = ref<string>('');
const inputContent = ref('');
const sending = ref(false);
const inputRef = ref<HTMLTextAreaElement | null>(null);

// 编辑模式: 同时只能编辑 1 条 (editingId 唯一), 用 data-editing-id 选择器 focus 避免 v-for ref 数组问题
const editingId = ref<string | null>(null);
const editingContent = ref('');

const confirmDeleteId = ref<string | null>(null);

// 顶层评论 (parentId === null) 按 createdAt ASC
const rootComments = computed(() =>
  comments.value.filter(c => c.parentId === null).slice().sort(byCreated)
);

// 每个顶层下的回复 map: { rootId: NoteComment[] ASC }
const repliesMap = computed(() => {
  const m = new Map<string, NoteComment[]>();
  for (const c of comments.value) {
    if (!c.parentId) continue;
    const arr = m.get(c.parentId) || [];
    arr.push(c);
    m.set(c.parentId, arr);
  }
  for (const arr of m.values()) arr.sort(byCreated);
  return m;
});

function byCreated(a: NoteComment, b: NoteComment) {
  return a.createdAt < b.createdAt ? -1 : 1;
}

// SSE 事件 listener (App.vue / sse.ts 收 SSE 后 dispatchEvent, 这里 quink-* 接住做增量更新)
function onCommentAdded(e: any) {
  const { noteId, comment } = e.detail || {};
  if (noteId !== props.noteId || !comment) return;
  if (comments.value.some(c => c.id === comment.id)) return; // 防重 (自 POST + SSE 不会推自己, 兜底)
  comments.value = [...comments.value, comment];
}
function onCommentUpdated(e: any) {
  const { noteId, commentId, content, updatedAt } = e.detail || {};
  if (noteId !== props.noteId) return;
  const idx = comments.value.findIndex(c => c.id === commentId);
  if (idx >= 0) comments.value[idx] = { ...comments.value[idx], content, updatedAt };
}
function onCommentDeleted(e: any) {
  const { noteId, commentId } = e.detail || {};
  if (noteId !== props.noteId) return;
  comments.value = comments.value.filter(c => c.id !== commentId);
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const { data } = await api.listNoteComments(props.noteId);
    comments.value = data;
    loaded.value = true;
  } catch (e: any) {
    console.error('[CommentThread] load failed:', e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  load();
  window.addEventListener('quink-note-comment-added' as any, onCommentAdded);
  window.addEventListener('quink-note-comment-updated' as any, onCommentUpdated);
  window.addEventListener('quink-note-comment-deleted' as any, onCommentDeleted);
});
onUnmounted(() => {
  window.removeEventListener('quink-note-comment-added' as any, onCommentAdded);
  window.removeEventListener('quink-note-comment-updated' as any, onCommentUpdated);
  window.removeEventListener('quink-note-comment-deleted' as any, onCommentDeleted);
});

// noteId 变 (复用组件跨笔记) → reload
watch(() => props.noteId, () => {
  comments.value = [];
  loaded.value = false;
  load();
});

// 进入编辑模式时 focus textarea + 光标到末尾 (用 data-editing-id 选择器避免 v-for ref 数组)
watch(editingId, (newId) => {
  if (!newId) return;
  nextTick(() => {
    const ta = document.querySelector(`textarea[data-editing-id="${newId}"]`) as HTMLTextAreaElement | null;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  });
});

function startReply(comment: NoteComment) {
  // 单层 thread: 不管点的是顶层还是回复, 都挂到根 (parentId === null 时 root=comment.id; 否则 root=comment.parentId)
  const rootId = comment.parentId ?? comment.id;
  replyingTo.value = rootId;
  replyingNickname.value = comment.userNickname || '用户';
  inputContent.value = `@${replyingNickname.value} `;
  nextTick(() => {
    inputRef.value?.focus();
    inputRef.value?.setSelectionRange(inputContent.value.length, inputContent.value.length);
  });
}

function cancelReply() {
  replyingTo.value = null;
  replyingNickname.value = '';
  inputContent.value = '';
}

async function send() {
  const content = inputContent.value.trim();
  if (!content || sending.value) return;
  sending.value = true;
  try {
    const { data } = await api.createNoteComment(props.noteId, content, replyingTo.value);
    comments.value = [...comments.value, data];
    inputContent.value = '';
    replyingTo.value = null;
    replyingNickname.value = '';
  } catch (e: any) {
    console.error('[CommentThread] send failed:', e);
    toast.show('评论失败: ' + (e?.message || '未知错误'), 'error', 3000);
  } finally {
    sending.value = false;
  }
}

function startEdit(comment: NoteComment) {
  editingId.value = comment.id;
  editingContent.value = comment.content;
}
function cancelEdit() {
  editingId.value = null;
  editingContent.value = '';
}
async function saveEdit() {
  if (!editingId.value) return;
  const content = editingContent.value.trim();
  if (!content) return;
  try {
    const { data } = await api.updateNoteComment(props.noteId, editingId.value, content);
    const idx = comments.value.findIndex(c => c.id === editingId.value);
    // 不能直接 = data: 后端 PATCH 返回不带 userNickname/userAvatar (没 JOIN users),
    // 整体替换会把头像/昵称变成 undefined → UI 显示成 placeholder + "用户". spread merge 保留原 user info.
    if (idx >= 0) comments.value[idx] = { ...comments.value[idx], ...data };
    editingId.value = null;
    editingContent.value = '';
  } catch (e: any) {
    console.error('[CommentThread] edit failed:', e);
    toast.show('编辑失败: ' + (e?.message || '未知错误'), 'error', 3000);
  }
}

async function doDelete(id: string) {
  try {
    await api.deleteNoteComment(props.noteId, id);
    comments.value = comments.value.filter(c => c.id !== id);
    confirmDeleteId.value = null;
  } catch (e: any) {
    console.error('[CommentThread] delete failed:', e);
    toast.show('删除失败: ' + (e?.message || '未知错误'), 'error', 3000);
  }
}

function canEdit(c: NoteComment) {
  return c.userId === auth.user?.id;
}
function canDelete(c: NoteComment) {
  return c.userId === auth.user?.id || !!props.canDeleteAny;
}

function timeAgo(s: string) {
  return dayjs(s).locale('zh-cn').fromNow();
}

defineExpose({ reload: load });
</script>

<template>
  <div class="comment-thread">
    <!-- 输入框 (顶部固定) -->
    <div class="comment-input-area" :class="{ 'is-replying': replyingTo !== null }">
      <div v-if="replyingTo !== null" class="reply-hint">
        <span class="text-xs text-gray-500">回复 @{{ replyingNickname }}</span>
        <button class="text-xs text-gray-400 hover:text-gray-600" @click="cancelReply">取消</button>
      </div>
      <textarea
        ref="inputRef"
        v-model="inputContent"
        :placeholder="replyingTo !== null ? '回复内容...' : '说点什么...'"
        spellcheck="false"
        rows="2"
        class="comment-input"
        @keydown.ctrl.enter.exact="send"
        @keydown.meta.enter.exact="send"
      />
      <div class="comment-input-footer">
        <button
          class="send-btn"
          :disabled="!inputContent.trim() || sending"
          @click="send"
        >
          <PhPaperPlaneTilt size="0.875rem" weight="fill" />
          <span>{{ sending ? '发送中...' : '发送' }}</span>
        </button>
      </div>
    </div>

    <!-- 评论列表 -->
    <div v-if="loading && !loaded" class="text-center text-xs text-gray-400 py-4">加载中...</div>
    <div v-else-if="rootComments.length === 0" class="text-center text-xs text-gray-400 py-6">还没有评论, 来抢沙发吧</div>
    <div v-else class="comment-list">
      <div v-for="root in rootComments" :key="root.id" class="comment-group">
        <!-- 顶层评论 -->
        <article class="comment-item">
          <div class="avatar">
            <img v-if="root.userAvatar"
              :src="resolveFileThumbUrl(root.userAvatar)"
              @error="thumbErrorFallback($event, resolveFileUrl(root.userAvatar))"
              class="w-7 h-7 rounded-full object-cover" alt="" />
            <div v-else class="avatar-placeholder">{{ (root.userNickname || '?').charAt(0).toUpperCase() }}</div>
          </div>
          <div class="comment-body">
            <div class="comment-header">
              <span class="nickname">{{ root.userNickname || '用户' }}</span>
              <span class="time" :title="root.createdAt">{{ timeAgo(root.createdAt) }}</span>
              <span v-if="root.updatedAt !== root.createdAt" class="edited-badge" title="已编辑">已编辑</span>
            </div>
            <template v-if="editingId === root.id">
              <textarea
                v-model="editingContent"
                :data-editing-id="root.id"
                spellcheck="false"
                rows="2"
                class="comment-input editing"
                @keydown.ctrl.enter.exact="saveEdit"
                @keydown.meta.enter.exact="saveEdit"
                @keydown.escape="cancelEdit"
              />
              <div class="flex gap-2 mt-1">
                <button class="action-btn primary" @click="saveEdit">保存</button>
                <button class="action-btn" @click="cancelEdit">取消</button>
              </div>
            </template>
            <template v-else>
              <p class="content">{{ root.content }}</p>
              <div class="actions">
                <button class="action-btn" @click="startReply(root)">
                  <PhArrowBendUpLeft size="0.75rem" weight="bold" />
                  <span>回复</span>
                </button>
                <button v-if="canEdit(root)" class="action-btn" @click="startEdit(root)">
                  <PhPencilSimple size="0.75rem" weight="bold" />
                  <span>编辑</span>
                </button>
                <button v-if="canDelete(root)" class="action-btn danger" @click="confirmDeleteId = root.id">
                  <PhTrash size="0.75rem" weight="bold" />
                  <span>删除</span>
                </button>
              </div>
            </template>
          </div>
        </article>
        <!-- 一级回复 (单层 thread, 全挂在 root 下不再嵌套) -->
        <div v-if="(repliesMap.get(root.id) || []).length > 0" class="comment-replies">
          <article v-for="reply in repliesMap.get(root.id)" :key="reply.id" class="comment-item">
            <div class="avatar">
              <img v-if="reply.userAvatar"
                :src="resolveFileThumbUrl(reply.userAvatar)"
                @error="thumbErrorFallback($event, resolveFileUrl(reply.userAvatar))"
                class="w-6 h-6 rounded-full object-cover" alt="" />
              <div v-else class="avatar-placeholder small">{{ (reply.userNickname || '?').charAt(0).toUpperCase() }}</div>
            </div>
            <div class="comment-body">
              <div class="comment-header">
                <span class="nickname small">{{ reply.userNickname || '用户' }}</span>
                <span class="time" :title="reply.createdAt">{{ timeAgo(reply.createdAt) }}</span>
                <span v-if="reply.updatedAt !== reply.createdAt" class="edited-badge" title="已编辑">已编辑</span>
              </div>
              <template v-if="editingId === reply.id">
                <textarea
                  v-model="editingContent"
                  :data-editing-id="reply.id"
                  spellcheck="false"
                  rows="2"
                  class="comment-input editing"
                  @keydown.ctrl.enter.exact="saveEdit"
                  @keydown.meta.enter.exact="saveEdit"
                  @keydown.escape="cancelEdit"
                />
                <div class="flex gap-2 mt-1">
                  <button class="action-btn primary" @click="saveEdit">保存</button>
                  <button class="action-btn" @click="cancelEdit">取消</button>
                </div>
              </template>
              <template v-else>
                <p class="content">{{ reply.content }}</p>
                <div class="actions">
                  <button class="action-btn" @click="startReply(reply)">
                    <PhArrowBendUpLeft size="0.75rem" weight="bold" />
                    <span>回复</span>
                  </button>
                  <button v-if="canEdit(reply)" class="action-btn" @click="startEdit(reply)">
                    <PhPencilSimple size="0.75rem" weight="bold" />
                    <span>编辑</span>
                  </button>
                  <button v-if="canDelete(reply)" class="action-btn danger" @click="confirmDeleteId = reply.id">
                    <PhTrash size="0.75rem" weight="bold" />
                    <span>删除</span>
                  </button>
                </div>
              </template>
            </div>
          </article>
        </div>
      </div>
    </div>

    <!-- 删除确认弹窗 (跟 NoteCard 同款样式约定) -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="confirmDeleteId" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
          <div class="absolute inset-0 bg-black/30" @click="confirmDeleteId = null" />
          <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
            <p class="text-sm text-gray-700 mb-1">删除评论</p>
            <p class="text-xs text-gray-400 mb-4">删除后无法恢复</p>
            <div class="flex gap-2 justify-center">
              <button class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50" @click="confirmDeleteId = null">取消</button>
              <button class="px-4 py-1.5 text-xs rounded-lg bg-red-50 text-red-500 hover:bg-red-100 font-medium" @click="doDelete(confirmDeleteId!)">删除</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.comment-thread {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.comment-input-area {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.5rem 0.625rem;
  border: 1px solid rgb(229 231 235);
  border-radius: 0.5rem;
  background-color: rgb(249 250 251);
  transition: border-color 0.15s, background-color 0.15s;
}
.comment-input-area:focus-within {
  border-color: rgb(var(--c-accent) / 0.5);
  background-color: white;
}
.comment-input-area.is-replying {
  background-color: rgb(var(--c-accent-light));
}
.reply-hint {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.comment-input {
  width: 100%;
  border: none;
  outline: none;
  resize: vertical;
  min-height: 2.5rem;
  background: transparent;
  font-size: 0.875rem;
  color: rgb(31 41 55);
  line-height: 1.5;
  font-family: inherit;
}
.comment-input.editing {
  border: 1px solid rgb(var(--c-accent) / 0.5);
  border-radius: 0.375rem;
  padding: 0.375rem 0.5rem;
  background-color: white;
}
.comment-input::placeholder {
  color: rgb(156 163 175);
}
.comment-input-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
}
.send-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.625rem;
  border-radius: 0.375rem;
  font-size: 0.75rem;
  font-weight: 500;
  background-color: rgb(var(--c-accent-light));
  color: rgb(var(--c-accent-dark));
  border: 1px solid transparent;
  transition: background-color 0.15s;
}
.send-btn:hover {
  background-color: rgb(var(--c-accent) / 0.25);
}
.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.comment-list {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}
.comment-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.comment-item {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
}
.avatar {
  flex-shrink: 0;
}
.avatar-placeholder {
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 9999px;
  background-color: rgb(var(--c-accent) / 0.2);
  color: rgb(var(--c-accent-dark));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 700;
}
.avatar-placeholder.small {
  width: 1.5rem;
  height: 1.5rem;
  font-size: 0.625rem;
}
.comment-body {
  flex: 1;
  min-width: 0;
}
.comment-header {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  margin-bottom: 0.125rem;
  flex-wrap: wrap;
}
.nickname {
  font-size: 0.8125rem;
  font-weight: 500;
  color: rgb(55 65 81);
}
/* 不再给 reply nickname 缩小字号: 1px 字号差肉眼无视觉层级意义, 反而让一二级 line-box
   高度不同 (13px * 1.5 = 19.5 vs 12px * 1.5 = 18) → align-items: baseline 时主 baseline
   位置不同 → 胶囊框相对 line-box 中心偏差 ~1px. 视觉层级靠缩进 + 头像更小已足够区分 */
.nickname.small {
  font-size: 0.8125rem;
}
.time {
  font-size: 0.6875rem;
  color: rgb(156 163 175);
}
.edited-badge {
  font-size: 0.625rem;
  color: rgb(107 114 128);
  background-color: rgb(243 244 246);
  padding: 0.0625rem 0.375rem;
  border-radius: 9999px;
  line-height: 1.4;
  letter-spacing: 0.02em;
}
.content {
  font-size: 0.875rem;
  color: rgb(55 65 81);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.actions {
  display: flex;
  gap: 0.25rem;
  margin-top: 0.25rem;
  opacity: 0;
  transition: opacity 0.15s;
}
.comment-item:hover .actions {
  opacity: 1;
}
/* 触屏 hover 失效, 永远显示 actions */
@media (hover: none) {
  .actions { opacity: 1; }
}
.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.125rem;
  padding: 0.125rem 0.375rem;
  font-size: 0.6875rem;
  color: rgb(107 114 128);
  border-radius: 0.25rem;
  transition: background-color 0.15s, color 0.15s;
}
.action-btn:hover {
  background-color: rgb(243 244 246);
  color: rgb(55 65 81);
}
.action-btn.danger:hover {
  color: rgb(239 68 68);
  background-color: rgb(254 242 242);
}
.action-btn.primary {
  background-color: rgb(var(--c-accent-light));
  color: rgb(var(--c-accent-dark));
  font-weight: 500;
}
.action-btn.primary:hover {
  background-color: rgb(var(--c-accent) / 0.25);
}

.comment-replies {
  margin-left: 2.25rem;
  padding-left: 0.75rem;
  border-left: 2px solid rgb(229 231 235);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

/* 暗色主题 */
[data-theme="dark"] .comment-input-area {
  background-color: rgb(255 255 255 / 0.04);
  border-color: rgb(255 255 255 / 0.1);
}
[data-theme="dark"] .comment-input-area:focus-within {
  background-color: rgb(255 255 255 / 0.06);
}
[data-theme="dark"] .comment-input-area.is-replying {
  background-color: rgb(var(--c-accent) / 0.15);
}
[data-theme="dark"] .comment-input {
  color: rgb(255 255 255 / 0.85);
}
[data-theme="dark"] .comment-input.editing {
  background-color: rgb(255 255 255 / 0.08);
}
[data-theme="dark"] .comment-input::placeholder {
  color: rgb(255 255 255 / 0.35);
}
[data-theme="dark"] .nickname {
  color: rgb(255 255 255 / 0.85);
}
[data-theme="dark"] .content {
  color: rgb(255 255 255 / 0.8);
}
[data-theme="dark"] .action-btn:hover {
  background-color: rgb(255 255 255 / 0.06);
  color: rgb(255 255 255 / 0.9);
}
[data-theme="dark"] .comment-replies {
  border-left-color: rgb(255 255 255 / 0.15);
}
[data-theme="dark"] .edited-badge {
  color: rgb(255 255 255 / 0.55);
  background-color: rgb(255 255 255 / 0.08);
}
/* dark 下发送按钮是评论区主 action, 背景需明显才看得清. 原 0.2 在 #1e1e2a 上跟主背景几乎齐平 */
[data-theme="dark"] .send-btn {
  background-color: rgb(var(--c-accent) / 0.35);
  color: rgb(var(--c-accent-light));
  border-color: rgb(var(--c-accent) / 0.5);
}
[data-theme="dark"] .send-btn:hover {
  background-color: rgb(var(--c-accent) / 0.5);
}
[data-theme="dark"] .relative.bg-white.rounded-xl {
  background-color: rgb(40 42 56);
}
[data-theme="dark"] .relative.bg-white p {
  color: rgb(255 255 255 / 0.85);
}
</style>
