<script setup lang="ts">
import { ref, computed, inject, watchEffect } from 'vue';
import { useEscToClose } from '@/composables/useEscToClose';
import { useRouter } from 'vue-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { useNotesStore } from '@/stores/notes';
import { useToast } from '@/composables/useToast';
import type { Note } from '@/api';
import {
  PhCheck,
  PhCheckSquare,
  PhDotsThreeVertical,
  PhPushPin,
  PhMapPin,
  PhPencilSimple,
  PhArrowCounterClockwise,
  PhTrash,
} from '@phosphor-icons/vue';
import { REF_LINK_REGEX, renderRefLink, injectRefLinkIcons } from '@/utils/refLink';
import { resolveMarkdownFileUrls } from '@/utils/fileUrl';
import { highlightTextByPinyin } from '@/utils/pinyin';
import { startCardDrag, dragState } from '@/utils/cardDnd';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const props = defineProps<{ note: Note }>();
const store = useNotesStore();
const router = useRouter();
const toast = useToast();
const openEditModal = inject<(note: Note) => void>('openEditModal');

// 拖动检测: mousedown 时记录起点和时间, click 触发时跟 e.clientX/Y 比较
// 距离 > 5px 或 按住 > 500ms → 拖动(选字 / 长按), 跳过进详情
const DRAG_DISTANCE_THRESHOLD = 5;
const DRAG_TIME_THRESHOLD = 500;
let mouseDownX = 0;
let mouseDownY = 0;
let mouseDownAt = 0;
function onMouseDown(e: MouseEvent) {
  mouseDownX = e.clientX;
  mouseDownY = e.clientY;
  mouseDownAt = Date.now();
}

function handleClick(e: MouseEvent) {
  if ((e.target as HTMLElement).closest?.('.voice-bubble')) return;
  // 拖动/长按检测放最前: 这种 click 直接 return, 不走任何分支(包括 Ctrl+点击)
  const dx = Math.abs(e.clientX - mouseDownX);
  const dy = Math.abs(e.clientY - mouseDownY);
  const dt = Date.now() - mouseDownAt;
  if (dx > DRAG_DISTANCE_THRESHOLD || dy > DRAG_DISTANCE_THRESHOLD || dt > DRAG_TIME_THRESHOLD) return;
  if (e.ctrlKey || e.metaKey) {
    // Ctrl+点击引用标签 → 跳转详情
    const ref = (e.target as HTMLElement).closest('.note-ref-link');
    if (ref) {
      e.preventDefault();
      e.stopPropagation();
      try {
        const href = ref.getAttribute('data-ref') || '';
        const refId = new URL(href, location.origin).searchParams.get('ref');
        if (refId) { router.push(`/note/${refId}`); return; }
      } catch {}
    }
    // Ctrl+点击空白区 → 选择模式
    if (!store.selectMode) store.toggleSelectMode();
    store.toggleSelect(props.note.id);
    return;
  }
  if (store.selectMode) {
    store.toggleSelect(props.note.id);
    return;
  }
  // 任务列表 checkbox 点击 → 切换 task 状态,不进详情(放 selectMode 之后:选择模式下 checkbox 不响应,整卡片当选择目标)
  const tgt = e.target as HTMLElement;
  if (tgt.tagName === 'INPUT' && (tgt as HTMLInputElement).type === 'checkbox') {
    onTaskCheckboxClick(e, tgt as HTMLInputElement);
    return;
  }
  // 点击卡片内的 a 标签 → 走链接自身处理(引用预览 / 附件打开 / 外部网址),不进详情
  if ((e.target as HTMLElement).closest?.('a')) return;
  router.push(`/note/${props.note.id}`);
}

// 任务列表 checkbox 点击 → toggle markdown 源里对应的 - [x] / - [ ] + 后台保存
// 跟 NoteDetail 同模式: regex 匹配第 N 个 task 标记,兼容 `-` / `*` 列表标记和 `[x] / [X] / [ ]` 三种状态;
// 立即视觉同步(input.checked + props.note.content 触发 watchEffect 重渲染),失败回滚
async function onTaskCheckboxClick(e: MouseEvent, input: HTMLInputElement) {
  e.preventDefault();
  e.stopPropagation();
  const wrapper = e.currentTarget as HTMLElement;
  const allCheckboxes = Array.from(wrapper.querySelectorAll('input[type="checkbox"]'));
  const taskIndex = allCheckboxes.indexOf(input);
  if (taskIndex < 0) return;

  const oldContent = props.note.content;
  let idx = 0;
  // 闭包捕获 toggle 方向: mark==' ' → 切到 done; mark=='x'/'X' → 切到 undone.
  // 用 toast 反馈,让用户在列表里隔着卡片也能看到操作生效
  let toggledToDone = false;
  const newContent = oldContent.replace(/^(\s*[-*]\s+\[)([xX ])(\])/gm, (match, prefix, mark, suffix) => {
    if (idx === taskIndex) {
      toggledToDone = mark === ' ';
      idx++;
      return `${prefix}${mark === ' ' ? 'x' : ' '}${suffix}`;
    }
    idx++; return match;
  });
  if (newContent === oldContent) return;

  input.checked = !input.checked;
  props.note.content = newContent;
  try {
    await store.updateNote(props.note.id, { content: newContent });
    toast.show(toggledToDone ? '已完成' : '已取消完成', toggledToDone ? 'success' : 'default');
  } catch (err) {
    props.note.content = oldContent;
    input.checked = !input.checked;
    console.error('[NoteCard] toggle task failed:', err);
  }
}
const showMenu = ref(false);

// 三点菜单"选择": 进入 selectMode 同时把当前卡片入选
function enterSelectMode() {
  if (!store.selectMode) store.toggleSelectMode();
  if (!store.selectedIds.has(props.note.id)) store.toggleSelect(props.note.id);
  showMenu.value = false;
}

// 自定义拖动 (cardDnd.ts pointer events 实现, 不用 HTML5 DnD); 当前卡片是否在被拖
const isDragging = computed(() => dragState.active && dragState.ids.includes(props.note.id));

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  // 胶囊音频链接自己处理 seek 拖动 (audio.ts pointer 监听), 不要让卡片抢
  const audioA = (e.target as HTMLElement)?.closest?.('a') as HTMLAnchorElement | null;
  if (audioA) {
    const href = audioA.getAttribute('href') || '';
    if (/\.(webm|mp3|wav|ogg|m4a)(\?.*)?$/i.test(href)) return;
  }
  // 多选 + 当前在选中集 + 选中 ≥ 2 → 整批; 否则单条
  const useBatch = store.selectMode && store.selectedIds.has(props.note.id) && store.selectedIds.size > 1;
  const ids = useBatch ? Array.from(store.selectedIds) : [props.note.id];
  // ghost 文字: 多条显数量, 单条显内容前 30 字 (没内容用 type label 兜底)
  const text = useBatch
    ? `${ids.length} 条内容`
    : (props.note.content?.replace(/[#*`>~\-!\[\]]/g, '').trim().slice(0, 30) || typeLabels[props.note.type] || '内容');
  startCardDrag(e, {
    ids,
    type: ids.length === 1 ? props.note.type : null,
    category: ids.length === 1 ? (props.note.category || '') : '',
    text,
  });
}
const confirmDelete = ref(false);
useEscToClose(confirmDelete);
const menuBtn = ref<HTMLElement>();
const menuPos = ref<{ top: string; right: string }>({ top: '0px', right: '0px' });

// Teleport+fixed 可跨 main 的 overflow，但不能跨 viewport 物理边界（窗口外不能渲染）；
// 下方空间不够菜单（估 ~160px）就向按钮上方弹
function toggleMenu() {
  if (showMenu.value) { showMenu.value = false; return; }
  if (menuBtn.value) {
    const r = menuBtn.value.getBoundingClientRect();
    const estMenuH = 160;
    const flipUp = r.bottom + 4 + estMenuH > window.innerHeight;
    menuPos.value = {
      top: flipUp ? `${r.top - estMenuH - 4}px` : `${r.bottom + 4}px`,
      right: `${window.innerWidth - r.right}px`,
    };
  }
  showMenu.value = true;
}

function askDelete() {
  showMenu.value = false;
  confirmDelete.value = true;
}

async function doDelete() {
  confirmDelete.value = false;
  // 留个 snapshot 给撤销用: store.deleteNote 走 splice 会让 props.note 引用失效, 必须先拷贝
  const snapshot = { ...props.note };
  await store.deleteNote(props.note.id);
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

const renderedContent = ref('');

// Markdown → HTML rendering with search highlight
import Vditor from 'vditor';

watchEffect(async (onCleanup) => {
  // 防 race condition: content 变化触发 callback 时,上一次的 await Vditor.md2html(旧内容)
  // 可能还 pending。如果旧的 await 后完成 → 用旧 html 覆盖 renderedContent → UI"不刷新"
  // (蘑菇遇到过偶发的"编辑后列表不更新"就是这个)。onCleanup 标记过期,过期结果不回写
  let cancelled = false;
  onCleanup(() => { cancelled = true; });
  const content = props.note.content;
  try {
    // 任务列表:* [X] → - [x] (Vditor md2html 只认 - 开头的任务列表)
    // 历史污染清理:旧版 RichEditor 的播放按钮 ▶/⏸ 被 Vditor 序列化进了 markdown,这里剥掉
    let md = content.replace(/[▶⏸]/g, '').replace(/^\* \[([ xX])\]/gm, (_, c) => `- [${c.toLowerCase()}]`);
    // 引用链接:先在 Markdown 层面简化(旧数据可能有多行 label,Vditor 解析不了)
    const processed = md.replace(REF_LINK_REGEX, (_, label, href) => renderRefLink(label, href, 20));
    // 文件链接裸名拼前缀: 笔记里 `[xxx](文件名.ext)` → `[xxx](/api/uploads/文件名.ext)`,让 <a>/<img>/<audio> 能加载
    const withFiles = resolveMarkdownFileUrls(processed);
    let html = await Vditor.md2html(withFiles, { cdn: '/vditor' } as any);
    html = injectRefLinkIcons(html);
    // 列表卡片 task list checkbox 可点击: lute 默认输出 disabled,浏览器对 disabled input 不触发 click 事件。
    // 跟 NoteDetail 同处理 —— DOM 剥 disabled(regex 易漏: 属性顺序 / 空值 / 自闭合斜杠 等变体)
    {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      tmp.querySelectorAll('input[type="checkbox"]').forEach((i) => i.removeAttribute('disabled'));
      html = tmp.innerHTML;
    }
    // 搜索关键词高亮（只在标签之间的文本上替换，避免破坏 a[href]、class 等 HTML 属性 → 进而破坏音频胶囊等 CSS 选择器）
    // highlightTextByPinyin 同时支持字面 + 拼音(全拼/首字母/混合),让 query="zb" 也能在 content="周报..." 里命中"周报"高亮
    const q = store.searchQuery;
    if (q && q.trim()) {
      html = html.replace(/(<[^>]+>)|([^<]+)/g, (_, tag, text) =>
        tag ? tag : highlightTextByPinyin(text, q)
      );
    }
    if (cancelled) return;
    renderedContent.value = html;
  } catch {
    if (cancelled) return;
    renderedContent.value = content;
  }
});

const timeAgo = computed(() => dayjs(props.note.createdAt).fromNow());
const fullTime = computed(() => dayjs(props.note.createdAt).format('YYYY-MM-DD HH:mm'));

const typeLabels: Record<string, string> = { note: '灵感', todo: '待办', snippet: '笔记', link: '链接' };
const typeColor: Record<string, string> = {
  note: 'bg-primary-light text-primary',
  todo: 'bg-amber-100 text-amber-600',
  snippet: 'bg-emerald-100 text-emerald-600',
  link: 'bg-sky-100 text-sky-600',
};
</script>

<template>
  <!-- 非 selectMode: 仅 type chip 是拖动 handle (其他地方鼠标按住选文字); selectMode: 整卡片可拖 (多选批量移动).
       自定义拖动 (cardDnd.ts), 非 HTML5 DnD: selectMode 时整卡片 @pointerdown; 非 selectMode 时 type chip @pointerdown -->
  <div class="bg-white rounded-2xl shadow-sm hover:shadow-md transition-all duration-200 group relative card-draggable"
    :class="{ 'ring-2 ring-primary/50': note.pinned, 'ring-2 ring-primary': store.selectedIds.has(note.id), 'opacity-50': isDragging }"
    @pointerdown="store.selectMode ? onPointerDown($event) : undefined">
    <div class="px-3 py-2.5 md:px-4 md:py-3 cursor-pointer" @click="handleClick" @mousedown="onMouseDown">
      <div class="flex items-center gap-2 mb-2">
        <!-- 多选 checkbox: 跟 task list 视觉接近 — 空心圆 border (未选) / 实心主色 + 白勾 (已选);
             用 w-[18px] h-[18px] 显式像素值 (Tailwind 默认无 4.5 spacing, w-4.5 会渲染成 0 尺寸残留点) -->
        <div v-if="store.selectMode"
          class="w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center shrink-0 transition-all"
          :class="store.selectedIds.has(note.id) ? 'bg-primary border-primary' : 'border-gray-400 bg-white hover:border-primary'">
          <svg v-if="store.selectedIds.has(note.id)" class="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none">
            <path d="M5 12l5 5L19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        <!-- type chip 在非 selectMode 时充当拖动 handle (整卡片不 draggable, 让正文可选文字); selectMode 时不需要它单独拖, 整卡片接管 -->
        <span class="text-[11px] px-2 py-0.5 rounded-full font-medium select-none touch-none"
          :class="[typeColor[note.type], !store.selectMode ? 'cursor-grab active:cursor-grabbing' : '']"
          @pointerdown.stop="!store.selectMode ? onPointerDown($event) : undefined">
          {{ typeLabels[note.type] }}
        </span>
        <span v-if="note.category" class="text-xs text-gray-400">{{ note.category }}</span>
        <span class="ml-auto text-[11px] text-gray-400" :title="fullTime">{{ timeAgo }}</span>
        <!-- 三点菜单 -->
        <button ref="menuBtn" @click.stop="toggleMenu"
          class="p-0.5 rounded-md text-gray-300 hover:text-gray-500 hover:bg-gray-100 transition-colors">
          <PhDotsThreeVertical size="1.375rem" weight="bold" />
        </button>
      </div>

      <p v-if="note.summary" class="text-xs text-gray-500 mb-1.5 italic">{{ note.summary }}</p>
      <div class="text-gray-700 note-content">
        <div class="vditor-reset line-clamp-4" v-html="renderedContent" />
      </div>

      <div v-if="note.tags && note.tags.length > 0" class="flex flex-wrap gap-1.5 mt-2">
        <span v-for="tag in note.tags" :key="tag" class="text-[11px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
          #{{ tag }}
        </span>
      </div>
    </div>

    <!-- 下拉菜单：Teleport 到 body 避免被祖先 overflow 截断（卡片靠底部时菜单消失）；
         遮罩必须一起 Teleport，否则就是 CLAUDE.md 警告的"半个 Teleport"——会被 stacking context 撕裂 -->
    <Teleport to="body">
      <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95"
        leave-active-class="transition duration-75 ease-in" leave-to-class="opacity-0 scale-95">
        <div v-if="showMenu" class="fixed bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-[9999] min-w-[110px] [&_svg]:mt-px"
          :style="menuPos">
          <button @click.stop="store.togglePin(note.id); showMenu = false"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
            <PhPushPin v-if="note.pinned" size="0.875rem" weight="fill" />
            <PhMapPin v-else size="0.875rem" weight="fill" />
            <span>{{ note.pinned ? '取消置顶' : '置顶' }}</span>
          </button>
          <button @click.stop="openEditModal?.(note); showMenu = false"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
            <PhPencilSimple size="0.875rem" weight="fill" style="margin-top: 2px" />
            <span>编辑</span>
          </button>
          <button v-if="note.type === 'todo'" @click.stop="store.toggleTodo(note.id); showMenu = false"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
            <PhArrowCounterClockwise v-if="note.todoStatus === 'done'" size="0.875rem" weight="fill" style="margin-top: 2px" />
            <PhCheck v-else size="0.875rem" weight="fill" style="margin-top: 2px" />
            <span>{{ note.todoStatus === 'done' ? '撤销完成' : '标记完成' }}</span>
          </button>
          <button @click.stop="enterSelectMode()"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
            <PhCheckSquare size="0.875rem" weight="fill" style="margin-top: 2px" />
            <span>多选</span>
          </button>
          <div class="border-t border-gray-100 my-0.5"></div>
          <button @click.stop="askDelete()"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 transition-colors">
            <PhTrash size="0.875rem" weight="fill" style="margin-top: 2px" />
            <span>删除</span>
          </button>
        </div>
      </Transition>
      <div v-if="showMenu" class="fixed inset-0 z-[9998]" @click="showMenu = false" />
    </Teleport>

    <!-- 删除确认弹窗 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="confirmDelete" class="fixed inset-0 z-[200] flex items-center justify-center">
          <div class="absolute inset-0 bg-black/30" @click="confirmDelete = false" />
          <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
            <p class="text-sm text-gray-700 mb-1">删除内容</p>
            <p class="text-xs text-gray-400 mb-4">可在回收站找回</p>
            <div class="flex gap-2 justify-center">
              <button @click="confirmDelete = false"
                class="px-4 pt-[5.75px] pb-[7.75px] text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
              <button @click="doDelete()"
                class="px-4 pt-[5.75px] pb-[7.75px] text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
