<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick, computed } from 'vue';
import { useNotesStore } from '@/stores/notes';
import { useToast } from '@/composables/useToast';
import RichEditor from './RichEditor.vue';
import type { Note } from '@/api';
import { PhXCircle } from '@phosphor-icons/vue';

const props = defineProps<{ note: Note; initialFullscreen?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useNotesStore();
const toast = useToast();
const saving = ref(false);
const editorRef = ref<InstanceType<typeof RichEditor>>();
const modalCardRef = ref<HTMLElement>();
const showConfirm = ref(false);

// PR #5 编辑锁: 仅 shared 笔记走 (private 不需要协作锁, 直接编辑).
// onMounted 先 try acquire, 失败 → 不打开 modal 直接 emit close;
// 成功 → showInner = true 启动 enter 动画 + 30s 心跳续约.
// onBeforeUnmount → fetch keepalive DELETE 释放锁 (兼容页面 unload + Vue unmount 两种 case).
const isSharedNote = computed(() => props.note.visibility === 'shared');
const lockToken = ref<string | null>(null);
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const showInner = ref(false);

async function acquireLock(): Promise<boolean> {
  if (!isSharedNote.value) return true;
  const tok = localStorage.getItem('quink_token');
  try {
    const res = await fetch(`/api/notes/${props.note.id}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as any));
      if (res.status === 409 && body.error === 'locked') {
        toast.show(`「${body.lockByNickname}」正在编辑此笔记，稍后再试`, 'error', 3500);
      } else {
        toast.show('无法获取编辑锁：' + (body.error || res.statusText), 'error', 3000);
      }
      return false;
    }
    const data = await res.json();
    lockToken.value = data.data.lockToken;
    startHeartbeat();
    return true;
  } catch (e: any) {
    toast.show('编辑锁请求失败：' + (e.message || '未知错误'), 'error', 3000);
    return false;
  }
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  // 30s 一次, server TTL 5min, 4-5 次心跳过期; 心跳失败 = 锁丢, 提示用户重新打开
  heartbeatTimer = setInterval(async () => {
    if (!lockToken.value) return;
    const tok = localStorage.getItem('quink_token');
    try {
      const res = await fetch(`/api/notes/${props.note.id}/lock/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ lockToken: lockToken.value }),
      });
      if (!res.ok) {
        toast.show('编辑锁已失效，请关闭后重新打开笔记', 'error', 3000);
        stopHeartbeat();
        lockToken.value = null;
      }
    } catch (e) { /* 网络抖动忽略, 下次心跳重试 */ }
  }, 30 * 1000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// fetch keepalive: 页面 unload 时也能完成发送 (跟 sendBeacon 同语义但支持 DELETE method).
// 兼容 Vue component unmount + 浏览器关 tab 两种场景, 不用区分.
function releaseLockOnUnmount() {
  if (!lockToken.value) return;
  const tok = localStorage.getItem('quink_token');
  fetch(`/api/notes/${props.note.id}/lock`, {
    method: 'DELETE',
    keepalive: true,
    headers: { Authorization: `Bearer ${tok}` },
  }).catch(() => {});
  lockToken.value = null;
  stopHeartbeat();
}

onMounted(async () => {
  const ok = await acquireLock();
  if (!ok) {
    // 拿不到锁直接 emit close, 不走 enter 动画
    emit('close');
    return;
  }
  nextTick(() => { showInner.value = true; });
});

async function onSubmit(data: { html: string; type: string; tags: string[]; visibility: 'private' | 'shared'; sharedGroupIds: string[] }) {
  if (saving.value) return;
  saving.value = true;
  try {
    const patchData: any = {
      content: data.html,
      type: data.type as any,
      tags: data.tags,
      // PR #2: 传 visibility / sharedGroupIds 让 server 重建 note_shares (整批替换)
      visibility: data.visibility,
      sharedGroupIds: data.sharedGroupIds,
    };
    // PR #5: shared 笔记必须带 lockToken + version (server 校验 + 自增清锁)
    if (isSharedNote.value && lockToken.value) {
      patchData.lockToken = lockToken.value;
      patchData.version = props.note.version || 1;
    }
    await store.updateNote(props.note.id, patchData);
    // 提交成功 server 自动清锁, lockToken 失效, 心跳无效 → 停掉
    lockToken.value = null;
    stopHeartbeat();
    showInner.value = false;
  } catch (e: any) {
    const msg = e.message || '';
    if (msg.includes('version_conflict')) {
      toast.show('笔记已被其他人修改，请关闭后重新打开看最新版', 'error', 3500);
    } else if (msg.includes('lock_')) {
      toast.show('编辑锁已失效，请关闭后重新打开笔记', 'error', 3000);
    } else {
      toast.show('保存失败：' + (msg || '未知错误'), 'error', 3000);
    }
  } finally { saving.value = false; }
}

function startClose() {
  // 关闭瞬间用 cloneNode 把 vditor-wrapper 替换成静态 HTML 副本。
  // 用 chrome-devtools-mcp + MutationObserver 实测的 root cause:
  //   按 Esc 后 ~3ms 内 vditor.destroy() 就被触发(Vue Transition leave 期间 RichEditor
  //   并没有像预期那样保留到动画完成,destroy 把 toolbar + content 两个子节点直接从
  //   wrapper 里移除,然后剩下的 175ms 用户看到的就是 "空 wrapper + bottom bar 上移补位"
  //   一起 fade out。lock height / visibility / GPU layer 都被 vditor 内部 setAttribute 覆盖。
  // 偷天换日: clone 原 wrapper 当前 DOM 状态(含所有 style/class/子节点),replaceChild 让
  // staticCopy 占据 DOM 位置,原 wrapper 变游离节点。vditor 内部 destroy 操作的是游离节点
  // (不在 DOM 树),DOM 里的 staticCopy 是静态 HTML,modal fade 期间视觉完全稳定。
  if (modalCardRef.value) {
    const wrapper = modalCardRef.value.querySelector('.vditor-wrapper') as HTMLElement | null;
    if (wrapper && wrapper.parentElement) {
      const r = wrapper.getBoundingClientRect();
      const staticCopy = wrapper.cloneNode(true) as HTMLElement;
      staticCopy.style.height = r.height + 'px';
      staticCopy.style.width = r.width + 'px';
      staticCopy.style.flex = 'none';
      wrapper.parentElement.replaceChild(staticCopy, wrapper);
    }
  }
  showInner.value = false;
}

function tryClose() {
  if (editorRef.value?.isDirty) {
    showConfirm.value = true;
  } else {
    startClose();
  }
}

function confirmDiscard() {
  showConfirm.value = false;
  startClose();
}

function onAfterLeave() {
  emit('close');
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  // stopImmediatePropagation 拦截所有后续 listener(包括 document 上 NoteDetail / 列表页等
  // 监听 Esc 做"退回上一层"的逻辑)。否则在详情页编辑时按 Esc,modal 关了又退到列表。
  e.stopImmediatePropagation();
  if (showConfirm.value) {
    showConfirm.value = false;
  } else {
    tryClose();
  }
}

// document level + capture 阶段挂载: 比 NoteDetail.onKeydown 的 bubble 阶段更早执行,
// 而且不依赖 focus 在 modal 内(focus 在 body 时事件也能被拦截)
onMounted(() => { document.addEventListener('keydown', onKeydown, true); });
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
  // PR #5: 关 modal 同时释放编辑锁 (fetch keepalive 保证 page unload 也能发出)
  releaseLockOnUnmount();
});
</script>

<template>
  <Teleport to="body">
    <!-- 全屏打开走 modal-fade(无 scale): scale 动画期间 transform 会让内部 RichEditor 的
         fixed inset-0 被困在小窗口尺寸里(transform 祖先成为 containing block),
         看着像"小窗一闪过"。非全屏走 modal(有 scale,正常体验)。 -->
    <Transition :name="initialFullscreen ? 'modal-fade' : 'modal'" @after-leave="onAfterLeave">
    <div v-if="showInner" class="fixed inset-0 z-[var(--z-modal-edit)] flex items-center justify-center">
      <!-- Backdrop: 毛玻璃 -->
      <div class="absolute inset-0 bg-black/40 backdrop-blur-md" @click="tryClose" />

      <!-- Modal -->
      <div ref="modalCardRef" class="relative bg-white rounded-2xl shadow-2xl w-full max-w-4xl mx-4 max-h-[80vh] flex flex-col overflow-hidden ring-1 ring-black/5">
        <!-- Header -->
        <div class="flex items-center justify-between px-5 py-3 bg-gray-50/80">
          <span class="text-xs font-medium text-gray-500">编辑笔记</span>
          <div class="flex items-center gap-3">
            <span class="text-[11px] text-gray-400 hidden sm:inline">
              <kbd class="px-1.5 py-0.5 bg-gray-200/60 rounded text-[10px]">Esc</kbd> 关闭
              <kbd class="px-1.5 py-0.5 bg-gray-200/60 rounded text-[10px] ml-1">Ctrl+Enter</kbd> 保存
            </span>
            <button @click="tryClose" class="p-1 rounded-lg hover:bg-gray-200/60 text-gray-400 transition-colors">
              <PhXCircle size="1rem" weight="fill" />
            </button>
          </div>
        </div>

        <!-- Shared RichEditor -->
        <div class="overflow-hidden">
          <RichEditor
            ref="editorRef"
            :initial-content="note.content"
            :initial-type="note.type"
            :initial-tags="note.tags || []"
            :initial-fullscreen="initialFullscreen"
            :initial-visibility="(note as any).visibility || 'private'"
            :initial-shared-group-ids="(note as any).sharedGroupIds || []"
            :focus-end="true"
            :max-height="450"
            submit-label="保存"
            @submit="onSubmit"
          />
        </div>
      </div>

      <!-- 未保存确认弹窗 -->
      <Transition enter-active-class="transition duration-150 ease-out" enter-from-class="opacity-0 scale-95"
        leave-active-class="transition duration-100 ease-in" leave-from-class="opacity-100 scale-100" leave-to-class="opacity-0 scale-95">
        <div v-if="showConfirm" class="absolute inset-0 z-[var(--z-sticky)] flex items-center justify-center">
          <div class="absolute inset-0 bg-black/20" @click="showConfirm = false" />
          <div class="relative bg-white rounded-xl shadow-xl p-6 w-80 text-center">
            <p class="text-sm text-gray-700 mb-1">内容尚未保存</p>
            <p class="text-xs text-gray-400 mb-5">关闭后未保存的修改将丢失</p>
            <div class="flex gap-3 justify-center">
              <button @click="showConfirm = false"
                class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">
                继续编辑
              </button>
              <button @click="confirmDiscard"
                class="px-4 py-1.5 text-xs rounded-lg text-white transition-colors"
                style="background: rgb(var(--c-accent-dark))">
                放弃修改
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </div>
    </Transition>
  </Teleport>
</template>
