<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useNotesStore } from '@/stores/notes';
import RichEditor from './RichEditor.vue';
import type { Note } from '@/api';
import { PhXCircle } from '@phosphor-icons/vue';

const props = defineProps<{ note: Note; initialFullscreen?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useNotesStore();
const saving = ref(false);
const editorRef = ref<InstanceType<typeof RichEditor>>();
const modalCardRef = ref<HTMLElement>();
const showConfirm = ref(false);

// 内部 v-if，配合 Transition 实现 enter/leave 动画。
// mount 后下一帧设 true 触发 enter；关闭时先设 false 触发 leave，等 @after-leave 再真 emit close
const showInner = ref(false);
onMounted(() => { nextTick(() => { showInner.value = true; }); });

async function onSubmit(data: { html: string; type: string; tags: string[] }) {
  if (saving.value) return;
  saving.value = true;
  try {
    await store.updateNote(props.note.id, {
      content: data.html,
      type: data.type as any,
      tags: data.tags,
    });
    showInner.value = false;
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
onBeforeUnmount(() => { document.removeEventListener('keydown', onKeydown, true); });
</script>

<template>
  <Teleport to="body">
    <!-- 全屏打开走 modal-fade(无 scale): scale 动画期间 transform 会让内部 RichEditor 的
         fixed inset-0 被困在小窗口尺寸里(transform 祖先成为 containing block),
         看着像"小窗一闪过"。非全屏走 modal(有 scale,正常体验)。 -->
    <Transition :name="initialFullscreen ? 'modal-fade' : 'modal'" @after-leave="onAfterLeave">
    <div v-if="showInner" class="fixed inset-0 z-[100] flex items-center justify-center">
      <!-- Backdrop: 毛玻璃 -->
      <div class="absolute inset-0 bg-black/40 backdrop-blur-md" @click="tryClose" />

      <!-- Modal -->
      <div ref="modalCardRef" class="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col overflow-hidden ring-1 ring-black/5">
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
            :focus-end="true"
            :max-height="450"
            submit-label="保存"
            :z-index="110"
            @submit="onSubmit"
          />
        </div>
      </div>

      <!-- 未保存确认弹窗 -->
      <Transition enter-active-class="transition duration-150 ease-out" enter-from-class="opacity-0 scale-95"
        leave-active-class="transition duration-100 ease-in" leave-from-class="opacity-100 scale-100" leave-to-class="opacity-0 scale-95">
        <div v-if="showConfirm" class="absolute inset-0 z-10 flex items-center justify-center">
          <div class="absolute inset-0 bg-black/20" @click="showConfirm = false" />
          <div class="relative bg-white rounded-xl shadow-xl p-6 w-80 text-center">
            <p class="text-sm text-gray-700 mb-1">内容尚未保存</p>
            <p class="text-xs text-gray-400 mb-5">关闭后未保存的修改将丢失</p>
            <div class="flex gap-3 justify-center">
              <button @click="showConfirm = false"
                class="px-4 pt-[0.32rem] pb-[0.43rem] text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">
                继续编辑
              </button>
              <button @click="confirmDiscard"
                class="px-4 pt-[0.32rem] pb-[0.43rem] text-xs rounded-lg text-white transition-colors"
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
