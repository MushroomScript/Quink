<script setup lang="ts">
import { ref, onMounted, onUnmounted, inject, watch, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useNotesStore } from '@/stores/notes';
import { api, type Note } from '@/api';
import Vditor from 'vditor';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { PhNotePencil, PhCaretLeft, PhPencilSimple } from '@phosphor-icons/vue';
import { REF_LINK_REGEX, renderRefLink, injectRefLinkIcons } from '@/utils/refLink';
import { resolveMarkdownFileUrls } from '@/utils/fileUrl';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const route = useRoute();
const router = useRouter();
const store = useNotesStore();
const note = ref<Note | null>(null);
const rendered = ref('');
const loading = ref(true);
const openEditModal = inject<(note: Note, fullscreen?: boolean) => void>('openEditModal');
const detailTitle = inject<Ref<string>>('detailTitle');
const hasRefPreviewPending = inject<Ref<boolean>>('hasRefPreviewPending');
const restoreRefPreview = inject<() => void>('restoreRefPreview');

const typeLabels: Record<string, string> = { note: '灵感', todo: '待办', snippet: '笔记', link: '链接' };

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

async function loadNote() {
  const id = route.params.id as string;
  try {
    const res = await api.getNote(id);
    note.value = res.data;
    if (detailTitle) detailTitle.value = typeLabels[res.data.type] + '详情';
    // 不直接渲染,let watch(note.value.content) 自动触发 renderContent(避免双重渲染)
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
    await store.updateNote(note.value.id, { content: newContent });
  } catch (err) {
    if (note.value) note.value.content = oldContent;
    input.checked = !input.checked;
    console.error('[NoteDetail] toggle task failed:', err);
  }
}

// 监听 content 变化触发重渲染(loadNote / 编辑保存 / task toggle 都走这里统一)
watch(() => note.value?.content, async (newContent) => {
  if (!newContent) { rendered.value = ''; return; }
  rendered.value = await renderContent(newContent);
}, { immediate: true });

// store 重新 fetch 后笔记数组整体被替换,同步 note.value 引用(让后续 mutate 能直接生效)
watch(() => store.notes, () => {
  if (!note.value) return;
  const updated = store.notes.find(n => n.id === note.value!.id);
  if (updated && updated !== note.value) note.value = updated;
}, { deep: true });

function goBack() {
  // 有预览栈等待恢复 → 先显示预览,不导航
  if (hasRefPreviewPending?.value) {
    restoreRefPreview?.();
    return;
  }
  if (window.history.length > 1) {
    router.back();
  } else {
    router.push('/');
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') goBack();
}

onMounted(() => { document.addEventListener('keydown', onKeydown); loadNote(); });


watch(() => route.params.id, () => { loadNote(); });
onUnmounted(() => {
  if (detailTitle) detailTitle.value = '';
  document.removeEventListener('keydown', onKeydown);
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
        <div class="flex items-center gap-2">
          <span class="text-xs px-2 py-0.5 rounded-full font-medium bg-primary-light text-primary-dark">{{ typeLabels[note.type] }}</span>
          <span v-if="note.category" class="text-xs text-gray-400">{{ note.category }}</span>
        </div>
        <span class="text-xs text-gray-400 ml-auto">{{ dayjs(note.createdAt).format('YYYY-MM-DD HH:mm') }}</span>
        <button @click="openEditModal?.(note)" class="px-3 py-1 text-xs rounded-lg hover:bg-gray-100 text-gray-400 inline-flex items-center gap-1">
          <PhPencilSimple size="0.875rem" weight="fill" />
          <span>编辑</span>
        </button>
      </div>

      <!-- Summary -->
      <p v-if="note.summary" class="text-sm text-gray-500 italic mb-4">{{ note.summary }}</p>

      <!-- Tags -->
      <div v-if="note.tags?.length" class="flex flex-wrap gap-1.5 mb-4">
        <span v-for="tag in note.tags" :key="tag" class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">#{{ tag }}</span>
      </div>

      <!-- Content; @click 上拦截 task list checkbox 点击实现状态切换 -->
      <div class="bg-white rounded-2xl shadow-sm p-6 md:p-8 note-content note-detail-content" @click="onContentClick">
        <div class="vditor-reset" v-html="rendered" />
      </div>
    </div>
  </div>
</template>
