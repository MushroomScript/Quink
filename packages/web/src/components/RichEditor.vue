<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick, markRaw } from 'vue';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import { api } from '@/api';
import { resolveFileUrl, resolveMarkdownFileUrls, stripMarkdownFileUrls } from '@/utils/fileUrl';
import { unzoomRect, unzoomViewport } from '@/utils/zoom';
import {
  addUploadTask,
  updateProgressById,
  markSuccessById,
  markFailedById,
  markCancelledById,
} from '@/composables/useAttachmentTasks';
import RenameModal from './RenameModal.vue';
import VisibilityChip from './VisibilityChip.vue';
import CategoryPicker from './CategoryPicker.vue';
import {
  PhLightbulb,
  PhNotePencil,
  PhCheckSquare,
  PhSparkle,
  PhBookOpen,
  PhPenNib,
  PhTag,
  PhPushPin,
  PhMicrophone,
  PhWaveform,
  PhRecord,
  PhArrowsOut,
  PhArrowsIn,
} from '@phosphor-icons/vue';

const props = withDefaults(defineProps<{
  initialContent?: string;
  initialType?: string;
  initialTags?: string[];
  initialFullscreen?: boolean;
  focusEnd?: boolean;
  placeholder?: string;
  showTypeSelector?: boolean;
  submitLabel?: string;
  minHeight?: number;
  maxHeight?: number;
  showAi?: boolean;
  showFullscreenBtn?: boolean;
  hintText?: string;
  // PR #2 群组共享: chip 控制可见性 (private / shared 到 N 群)
  initialVisibility?: 'private' | 'shared';
  initialSharedGroupIds?: string[];
  showVisibilityChip?: boolean;
  // 分类 chip: null = 走 AI 自动分类 (或显示"未分类"), 非空 = 用户手动选过
  initialCategory?: string | null;
  showCategoryPicker?: boolean;
  // PR #9 权限分级: 非作者编辑共享笔记时锁定 type 不可改 + 隐藏 tag 入口 (只让改正文)
  lockType?: boolean;
  hideTags?: boolean;
}>(), {
  initialContent: '',
  initialType: 'quink',
  initialTags: () => [],
  initialFullscreen: false,
  focusEnd: false,
  placeholder: '写下你的想法...',
  showTypeSelector: true,
  submitLabel: '保存',
  showAi: true,
  minHeight: 120,
  maxHeight: 320,
  showFullscreenBtn: true,
  hintText: '',
  initialVisibility: 'private',
  initialSharedGroupIds: () => [],
  showVisibilityChip: true,
  initialCategory: null,
  showCategoryPicker: true,
  lockType: false,
  hideTags: false,
});

const isFullscreen = ref(props.initialFullscreen);

// 同页面允许多个 RichEditor 共存(NoteInput + NoteEditModal),view-transition-name 必须唯一,
// 否则浏览器认为多个元素争抢同名快照,直接放弃动画
const vtName = `rich-editor-${Math.random().toString(36).slice(2, 8)}`;

// View Transitions API: 切全屏时把 DOM 突变包成一帧过渡,浏览器自动给 wrapper 做 morph
// (旧/新两个快照之间 opacity + transform 插值)。Electron 用的 Chromium 已稳定支持。
function withViewTransition(cb: () => void) {
  const start = (document as any).startViewTransition;
  if (typeof start === 'function') start.call(document, cb);
  else cb();
}

function toggleFullscreen() {
  withViewTransition(() => {
    isFullscreen.value = !isFullscreen.value;
    // 持久化偏好,让 NoteEditModal 下次从列表/详情页打开时默认用这个状态
    try { localStorage.setItem('quink_edit_fullscreen', isFullscreen.value ? '1' : '0'); } catch {}
  });
}

const emit = defineEmits<{
  (e: 'submit', data: { html: string; type: string; tags: string[]; visibility: 'private' | 'shared'; sharedGroupIds: string[]; category: string | null }): void;
  (e: 'ready'): void;
}>();

// PR #2 群组共享: 内部双向 v-model 的可见性状态. NoteInput 等用方传 initial*, 不再外部 sync (chip popover 实时更新)
const visibilityModel = ref<{ visibility: 'private' | 'shared'; sharedGroupIds: string[] }>({
  visibility: props.initialVisibility,
  sharedGroupIds: [...props.initialSharedGroupIds],
});
// 分类 chip: null = 走 AI 自动分类 (后端 autoClassify 仅在 category 为 null 时回填); 非空 = 用户手动选过, 保护不被 AI 覆盖
const categoryModel = ref<string | null>(props.initialCategory);

// PR #8 命名重整: value 跟新字段值一致 (quink=灵感, note=笔记, todo=待办)
const noteTypes = [
  { value: 'quink', label: '灵感', icon: markRaw(PhLightbulb), iconStyle: '' },
  { value: 'note', label: '笔记', icon: markRaw(PhNotePencil), iconStyle: '' },
  { value: 'todo', label: '待办', icon: markRaw(PhCheckSquare), iconStyle: '' },
];

const noteType = ref(props.initialType);
const tags = ref<string[]>([...props.initialTags]);
const showTagInput = ref(false);
const tagInput = ref('');
const showRefSearch = ref(false);
const refQuery = ref('');
const refResults = ref<any[]>([]);
const refBtnEl = ref<HTMLElement>();
const liveTextEl = ref<HTMLElement>();
const tagBtnEl = ref<HTMLElement>();

function getPopupPos(el: HTMLElement | undefined, width: number) {
  if (!el) return { display: 'none' };
  const r = el.getBoundingClientRect();
  const maxH = Math.max(r.top - 8, 100);
  return {
    position: 'fixed' as const,
    bottom: `${window.innerHeight - r.top + 4}px`,
    left: `${Math.max(r.right - width, 8)}px`,
    zIndex: 9999, // var(--z-overlay), JS inline 取不到 CSS var, 跟 scale 保持同档, 见根 Z-INDEX-SCALE.md
    maxHeight: `${maxH}px`,
    display: 'flex',
    flexDirection: 'column' as const,
  };
}

// AI panel
const showAiPanel = ref(false);
const aiFeature = ref<'polish' | 'expand' | 'write'>('polish');
const aiPromptText = ref('');
const aiProcessing = ref(false);
const aiResult = ref('');
const aiError = ref('');

// 三个图标都比文字基线整体下移 1px（蘑菇视觉偏好），并按各自重心偏差再细调对齐：
// PhBookOpen 顶部空白 -1，PhPenNib 重心偏上 +1，PhSparkle 居中为 0
const aiFeatureOptions = [
  { value: 'polish' as const, label: '润色', icon: markRaw(PhSparkle), iconStyle: 'margin-top: 1px' },
  { value: 'expand' as const, label: '扩充', icon: markRaw(PhBookOpen), iconStyle: 'margin-top: 0px' },
  { value: 'write' as const, label: '写文', icon: markRaw(PhPenNib), iconStyle: 'margin-top: 2px' },
];

const currentAiFeatureIcon = computed(() =>
  aiFeatureOptions.find(f => f.value === aiFeature.value)?.icon
);

const editorRef = ref<HTMLDivElement>();
let vditor: Vditor | null = null;
const dirty = ref(false);

const isDragOver = ref(false);
let dragCounter = 0;

function isExternalFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types || []).includes('Files');
}

// Vditor IR 编辑器内 copy 拦截: selection.toString() 在跨 <p><p> 时浏览器自动插 \n\n, 不区分用户输入 1 Enter (两 P) 还是 2 Enter (中间空 P).
// Vditor IR 渲染: 1 Enter → <p>1</p><p>2</p>; 2 Enter → <p>1</p><p></p><p>2</p>; 3 Enter → <p>1</p><p></p><p></p><p>2</p> (空 P 数 = Enter 数 - 1).
// 算法: 每个 block (P/DIV/...) 结束加 \n (含空 block) → N 个 P 自然形成 N-1 个 \n 分隔 (空 P 贡献额外 \n), 最后 trim 末尾.
// → 1 Enter 复制为 1\n2 (单换行), 2 Enter 复制为 1\n\n2 (双换行), N Enter 复制为 (N-1) 个 \n. 符合用户视觉.
function onEditorCopy(e: ClipboardEvent) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const fragment = range.cloneContents();
  if (!fragment.hasChildNodes()) return;
  let text = '';
  const blockTags = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE']);
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      text += node.textContent || '';
    } else if (node.nodeType === 1) {
      const el = node as Element;
      const tag = el.tagName;
      if (tag === 'BR') {
        text += '\n';
      } else if (blockTags.has(tag)) {
        // 不管空非空, walk child 完后加 \n. N 个 block 自然产生 N-1 个分隔 (trim 末尾掉一个)
        for (const c of Array.from(el.childNodes)) walk(c);
        text += '\n';
      } else {
        for (const c of Array.from(el.childNodes)) walk(c);
      }
    }
  };
  for (const c of Array.from(fragment.childNodes)) walk(c);
  text = text.replace(/\n$/, ''); // trim 末尾单个 \n (最后一个 block 多加的). 中间多 \n 不动 (保留用户多 Enter 留的空行)
  if (!text) return; // 提取不到内容 → fall through 浏览器默认
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  e.clipboardData?.setData('text/plain', text);
  // Vditor 可能用 navigator.clipboard.writeText() 异步覆盖 ClipboardEvent. 我们也异步 write 抢覆盖 (用户真实 Ctrl+C 有 user gesture 能调用)
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    setTimeout(() => { navigator.clipboard.writeText(text).catch(() => {}); }, 0);
  }
}

function onEditorDragEnter(e: DragEvent) {
  if (!isExternalFileDrag(e)) return;
  e.preventDefault();
  e.stopPropagation();
  dragCounter++;
  isDragOver.value = true;
}

function onEditorDragOver(e: DragEvent) {
  if (!isExternalFileDrag(e)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}

function onEditorDragLeave(e: DragEvent) {
  if (!isExternalFileDrag(e)) return;
  e.stopPropagation();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    isDragOver.value = false;
  }
}

async function onEditorDrop(e: DragEvent) {
  if (!isExternalFileDrag(e)) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  dragCounter = 0;
  isDragOver.value = false;
  const files = Array.from(e.dataTransfer?.files || []);
  if (!files.length) return;
  await uploadAndInsert(files);
}

async function uploadAndInsert(files: File[]) {
  vditor?.focus();
  type UploadResult = { ok: boolean; name: string; type: string; url?: string };
  const results = await Promise.all(files.map(async (file): Promise<UploadResult> => {
    const ctrl = new AbortController();
    const taskId = await addUploadTask(file.name, file.size, ctrl);
    try {
      const res = await api.uploadFile(file, 'file', {
        signal: ctrl.signal,
        onProgress: (recv, total) => updateProgressById(taskId, recv, total),
      });
      markSuccessById(taskId);
      return { ok: true, name: file.name, type: file.type, url: res.data?.url };
    } catch (err: any) {
      if (err?.name === 'AbortError') markCancelledById(taskId);
      else markFailedById(taskId, err?.message || '上传失败');
      return { ok: false, name: file.name, type: file.type };
    }
  }));
  vditor?.focus();
  setTimeout(() => {
    for (const r of results) {
      if (!r.ok || !r.url) continue;
      const url = resolveFileUrl(r.url);
      const md = r.type?.startsWith('image/')
        ? `![${r.name}](${url})\n`
        : `[📎 ${r.name}](${url})\n`;
      vditor?.insertValue(md);
    }
  }, 80);
}

// 自定义 vditor toolbar tooltip: 默认 vditor tooltip 是按钮的 ::before/::after 伪元素
// 被 App.vue main 的 overflow-y-auto 裁切(尤其飞向上方时)。改用 Teleport 到 body 的
// 自定义 tooltip,固定定位 + z-index 最顶,脱离任何 overflow 控制,永远朝上显示完整
const customTooltip = ref({ visible: false, text: '', top: 0, left: 0 });
function onToolbarMouseOver(e: MouseEvent) {
  const btn = (e.target as HTMLElement)?.closest?.('.vditor-tooltipped') as HTMLElement | null;
  if (!btn) return;
  const label = btn.getAttribute('aria-label');
  if (!label) return;
  // unzoomRect + unzoomViewport: CSS zoom 下 rect 跟 viewport 归一到 unzoomed 防 tooltip 错位 (蘑菇汇报)
  const r = unzoomRect(btn);
  const { vw } = unzoomViewport();
  // 上方空间不够 32px 时翻转到按钮下方,避免 Capture 等顶部贴边场景 tooltip 跑出窗口看不见
  const flipDown = r.top < 32;
  // tooltip 用 translateX(-50%) 居中对齐按钮中心,最左/最右按钮可能让 tooltip 超出窗口边界。
  // 估算 tooltip 半宽 40 (中文 2-4 字 + padding),clamp 中心位置到窗口内安全区
  const HALF = 40;
  const MARGIN = 8;
  const center = r.left + r.width / 2;
  const safeLeft = Math.max(HALF + MARGIN, Math.min(vw - HALF - MARGIN, center));
  customTooltip.value = {
    visible: true,
    text: label,
    top: flipDown ? r.bottom + 8 : r.top - 32,
    left: safeLeft,
  };
}
function onToolbarMouseOut(e: MouseEvent) {
  const related = e.relatedTarget as HTMLElement | null;
  if (related?.closest?.('.vditor-tooltipped')) return;
  customTooltip.value.visible = false;
}

onMounted(() => {
  if (!editorRef.value) return;

  vditor = new Vditor(editorRef.value, {
    // 编辑器内部用 absolute path,让 Vditor IR 模式渲染 <img>/<a href> 能加载;保存时(handleSubmit)再剥回裸名入 DB
    value: resolveMarkdownFileUrls(props.initialContent),
    placeholder: props.placeholder,
    minHeight: props.minHeight,
    width: '100%',
    mode: 'ir',
    cdn: '/vditor',
    toolbar: [
      'emoji', 'headings', 'bold', 'italic', 'strike', 'link', '|',
      'list', 'ordered-list', 'check', 'quote', '|',
      'code', 'inline-code', 'table', 'line', '|',
      'upload', 'undo', 'redo',
    ],
    toolbarConfig: { pin: false },
    counter: { enable: false },
    preview: { actions: [] },
    cache: { enable: false },
    upload: {
      url: '/api/upload/file',
      fieldName: 'file',
      max: 100 * 1024 * 1024, // 100MB,与后端 MAX_SIZE 对齐(Vditor 默认 10MB)
      headers: { Authorization: `Bearer ${localStorage.getItem('quink_token') || ''}` },
      format(files: File[], responseText: string) {
        try {
          const res = JSON.parse(responseText);
          if (res.data?.url) {
            const file = files[0];
            if (file.type.startsWith('image/')) {
              // Vditor 用 succMap 生成 ![](url) markdown,给 absolute url 让编辑器内图片预览能加载
              return JSON.stringify({ msg: '', code: 0, data: { errFiles: [], succMap: { [file.name]: resolveFileUrl(res.data.url) } } });
            }
            // Non-image: insert as link
            // 必须先 focus 拉回光标!上传是异步的,期间用户可能点了别处,
            // 全局 selection 跑出 editor,直接 insertValue 会通过 range.insertNode
            // 把 markdown 文本插到 selection 所在的 DOM 节点 (TopBar / Sidebar 等),
            // 切换路由不消失,F5 才能刷掉 (偶发 bug,看用户点击时机)。
            vditor?.focus();
            setTimeout(() => {
              vditor?.insertValue(`[📎 ${file.name}](${resolveFileUrl(res.data.url)})`);
            }, 80);
            return JSON.stringify({ msg: '', code: 0, data: { errFiles: [], succMap: {} } });
          }
        } catch {}
        return responseText;
      },
    },
    after: () => {
      // focusEnd: 再次编辑场景 (NoteEditModal), 光标定位到末尾让用户接着写.
      // CDP 实测 (蘑菇 2026-06-06 汇报): 用 TreeWalker 找最后一个 text node 锚定 selection (避开 PRE element boundary
      // 导致 Chromium 渲染光标到开头视觉位置的 bug). after() 在 Vditor IR 渲染完成后立即调 → 不用 setTimeout
      // 让用户首帧就看到光标在末尾 (避免"光标飘一下才到末尾"). RAF + 100ms 双保险防 Vditor 后续 mutation reset.
      // 注: focusEnd 时不调 vditor.focus(), 因为 vditor.focus() 内部把光标重置到默认位置, 会跟我们设的末尾冲突.
      if (props.focusEnd) {
        const setCursorToEnd = () => {
          const contentEl = editorRef.value?.querySelector('.vditor-ir .vditor-reset') as HTMLElement | null;
          if (!contentEl) return;
          contentEl.focus();
          // CDP 实测 (蘑菇 2026-06-06 汇报"光标在末尾位置一个字后面"): Vditor IR 渲染后 PRE 末尾有一个空 text node
          // (length=0), 直接抓最后 text node 会落到空节点开头 → Chromium 渲染光标在最后一段下一行位置, 视觉错位.
          // 必须跳过空 text node, 找最后一个有内容的 text node, 把光标设到它末尾 (offset = text.length).
          const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
          let lastTextNode: Text | null = null;
          let n: Node | null;
          while ((n = walker.nextNode())) {
            if ((n as Text).length > 0) lastTextNode = n as Text;
          }
          const range = document.createRange();
          if (lastTextNode) {
            range.setStart(lastTextNode, lastTextNode.length);
            range.collapse(true);
          } else {
            // 极端 fallback: 内容无 text node (纯 element / 图片) → 走 boundary 方案
            range.selectNodeContents(contentEl);
            range.collapse(false);
          }
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
          contentEl.scrollTop = contentEl.scrollHeight;
        };
        setCursorToEnd();                            // 同步首次: 用户首帧看到的就是末尾
        requestAnimationFrame(setCursorToEnd);       // 下一帧: 防 Vditor 内部首次 paint 后调整 selection
        setTimeout(setCursorToEnd, 100);             // 100ms 兜底: 防 Vditor 后续 async mutation reset
      } else {
        vditor?.focus();
      }
      emit('ready');
      // Vditor 加载完后才有 toolbar DOM,这时给 wrapper 绑事件委托
      // (mouseover bubble 上来,closest 找 .vditor-tooltipped 按钮)
      editorRef.value?.addEventListener('mouseover', onToolbarMouseOver);
      editorRef.value?.addEventListener('mouseout', onToolbarMouseOut);
      // capture 阶段拦截 Vditor 内置 drop, 走我们自己的上传 + dock + insertValue
      editorRef.value?.addEventListener('dragenter', onEditorDragEnter, true);
      editorRef.value?.addEventListener('dragover', onEditorDragOver, true);
      editorRef.value?.addEventListener('dragleave', onEditorDragLeave, true);
      editorRef.value?.addEventListener('drop', onEditorDrop, true);
      // capture 阶段拦截 Vditor 内 copy: 用户期望"按一次 Enter = 一个 \n", 但 markdown 段落分隔渲染成 <p></p> 浏览器复制时变 \n\n.
      // selection.toString() 在 contenteditable PRE 内常返空, 走 range.cloneContents() 自己 walk DOM 算干净文本 (P/DIV → \n, BR → \n)
      editorRef.value?.addEventListener('copy', onEditorCopy, true);
    },
    input: () => {
      dirty.value = true;
    },
  });
});

onBeforeUnmount(() => {
  editorRef.value?.removeEventListener('mouseover', onToolbarMouseOver);
  editorRef.value?.removeEventListener('mouseout', onToolbarMouseOut);
  editorRef.value?.removeEventListener('dragenter', onEditorDragEnter, true);
  editorRef.value?.removeEventListener('dragover', onEditorDragOver, true);
  editorRef.value?.removeEventListener('dragleave', onEditorDragLeave, true);
  editorRef.value?.removeEventListener('drop', onEditorDrop, true);
  vditor?.destroy();
  vditor = null;
});

// ── Tab key to switch type ──
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && isFullscreen.value) {
    e.preventDefault();
    e.stopPropagation();
    withViewTransition(() => { isFullscreen.value = false; });
    return;
  }
  if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    const idx = noteTypes.findIndex(t => t.value === noteType.value);
    noteType.value = noteTypes[(idx + 1) % noteTypes.length].value;
    return;
  }
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    handleSubmit();
  }
}

function handleSubmit() {
  if (!vditor) return;
  // 编辑器内 markdown 是 absolute path,保存前剥前缀回裸名(DB 约定)
  const md = stripMarkdownFileUrls(vditor.getValue().trim());
  if (!md) return;

  emit('submit', { html: md, type: noteType.value, tags: [...tags.value], visibility: visibilityModel.value.visibility, sharedGroupIds: [...visibilityModel.value.sharedGroupIds], category: categoryModel.value });
  dirty.value = false;
  // 保存后退出全屏: NoteInput 场景让用户看回到列表; NoteEditModal 场景下 modal 自身也在
  // 关闭(同一 tick 内 store.updateNote 后 showInner=false),这里只是顺手清掉状态。
  // 不同步 localStorage —— 那是用户手动 toggle 的偏好,保留下次打开默认行为
  if (isFullscreen.value) isFullscreen.value = false;
}

function clearContent() {
  vditor?.setValue('');
  tags.value = [];
  noteType.value = props.initialType;
  // 蘑菇 2026-06-08: 发布后 visibility / sharedGroupIds 也重置回初始 (默认 private + 空群), 跟新编辑器一致
  // 防止用户连续发同一类型笔记时, 上次选的群残留到下一条 (用户得手动取消才能改私人)
  visibilityModel.value = {
    visibility: props.initialVisibility,
    sharedGroupIds: [...props.initialSharedGroupIds],
  };
  // 分类同理: 发布后回到 initialCategory (默认 null = 自动), 防上次手选的分类残留到下一条 → 永远卡住 AI 不能自动
  categoryModel.value = props.initialCategory;
  dirty.value = false;
}

// ── Tags ──
function addTag() {
  const t = tagInput.value.trim();
  if (t && !tags.value.includes(t)) tags.value.push(t);
  tagInput.value = '';
  showTagInput.value = false;
}
function removeTag(tag: string) { tags.value = tags.value.filter(t => t !== tag); }

// ── Reference ──
async function searchRefs() {
  if (!refQuery.value.trim()) { refResults.value = []; return; }
  try { const r = await api.getNotes({ search: refQuery.value, limit: '20' }); refResults.value = r.data; } catch { refResults.value = []; }
}
function insertRef(note: any) {
  const firstLine = (note.content || '').split('\n').find((l: string) => l.trim()) || '';
  const label = firstLine.replace(/[#*`\[\]!>~]/g, '').trim().slice(0, 20) || '引用笔记';
  // 同 upload format 回调:用户点选时 selection 在 popup 输入框,不在 editor。
  // 直接 insertValue 可能 range.insertNode 到 popup DOM。先 focus 拉回再插。
  vditor?.focus();
  setTimeout(() => {
    vditor?.insertValue(`[${label}](/?ref=${note.id})`);
  }, 80);
  showRefSearch.value = false; refQuery.value = ''; refResults.value = [];
}

// ── AI ──
async function openAiPanel(feature: 'polish' | 'expand' | 'write') {
  aiFeature.value = feature;
  aiResult.value = '';
  aiError.value = '';
  try {
    const res = await api.getAiPrompts();
    aiPromptText.value = res.data[feature]?.prompt || '';
  } catch { aiPromptText.value = ''; }
  showAiPanel.value = true;
}

async function runAi() {
  if (!vditor || aiProcessing.value) return;
  aiProcessing.value = true;
  aiError.value = '';
  aiResult.value = '';

  const selection = vditor.getSelection();
  const content = selection || vditor.getValue();

  try {
    const res = await api.aiProcess(aiFeature.value, content, aiPromptText.value);
    aiResult.value = res.data.result;
  } catch (err: any) {
    aiError.value = err.message || 'AI 处理失败';
  } finally { aiProcessing.value = false; }
}

function applyAiResult() {
  if (!vditor || !aiResult.value) return;
  const selection = vditor.getSelection();
  if (selection) {
    // Replace selection — Vditor doesn't have replaceSelection, insert after clearing
    document.execCommand('insertText', false, aiResult.value);
  } else {
    vditor.setValue(resolveMarkdownFileUrls(aiResult.value));
  }
  showAiPanel.value = false;
  aiResult.value = '';
}

function closeAiPanel() { showAiPanel.value = false; }
function closePopups() { showTagInput.value = false; showRefSearch.value = false; }

// ── 录音(讯飞流式语音听写) ──
const isRecording = ref(false);
const recordingTime = ref(0);
let recordTimer: ReturnType<typeof setInterval> | null = null;
let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let iatWs: WebSocket | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let iatResultText = '';
const iatLiveText = ref('');

async function toggleRecording() {
  if (isRecording.value) {
    stopRecording();
  } else {
    startRecording();
  }
}

async function startRecording() {
  try {
    const res = await api.getIatUrl();
    const { url, appId } = res.data;

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
    audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(mediaStream);
    scriptNode = audioContext.createScriptProcessor(4096, 1, 1);

    iatWs = new WebSocket(url);
    iatResultText = '';
    iatLiveText.value = '';
    isFinishing = false;
    let frameIndex = 0;
    const resultMap = new Map<number, string>();

    iatWs.onopen = () => {
      isRecording.value = true;
      recordingTime.value = 0;
      recordTimer = setInterval(() => { recordingTime.value++; }, 1000);
    };

    iatWs.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.code !== 0) { console.error('[讯飞] error:', msg.message); return; }
        if (msg.data?.result) {
          const r = msg.data.result;
          const sn = r.sn;
          const pgs = r.pgs;
          const text = r.ws?.map((w: any) => w.cw.map((c: any) => c.w).join('')).join('') || '';
          // dwa=wpgs 模式：pgs='rpl' 时先删除 rg 范围内的旧片段再覆盖
          if (pgs === 'rpl' && r.rg) {
            for (let i = r.rg[0]; i <= r.rg[1]; i++) resultMap.delete(i);
          }
          resultMap.set(sn, text);
          const sorted = [...resultMap.entries()].sort((a, b) => a[0] - b[0]);
          iatResultText = sorted.map(([, t]) => t).join('');
          iatLiveText.value = iatResultText;
          nextTick(() => { if (liveTextEl.value) liveTextEl.value.scrollLeft = liveTextEl.value.scrollWidth; });
        }
        if (msg.data?.status === 2) {
          finishRecording();
        }
      } catch {}
    };

    iatWs.onerror = () => { finishRecording(); };
    iatWs.onclose = () => {};

    scriptNode.onaudioprocess = (e) => {
      if (!iatWs || iatWs.readyState !== WebSocket.OPEN) return;
      const pcm = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        int16[i] = Math.max(-1, Math.min(1, pcm[i])) * 0x7FFF;
      }
      const bytes = new Uint8Array(int16.buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);

      const frame: any = {
        data: { status: frameIndex === 0 ? 0 : 1, format: 'audio/L16;rate=16000', encoding: 'raw', audio: base64 },
      };
      if (frameIndex === 0) {
        frame.common = { app_id: appId };
        frame.business = { language: 'zh_cn', domain: 'iat', accent: 'mandarin', ptt: 1, vad_eos: 10000, dwa: 'wpgs' };
      }
      iatWs.send(JSON.stringify(frame));
      frameIndex++;
    };

    source.connect(scriptNode);
    scriptNode.connect(audioContext.destination);
  } catch (e: any) {
    console.error('[录音] 启动失败:', e.message);
    stopRecording();
  }
}

let isFinishing = false;

function finishRecording() {
  if (isFinishing) return;
  isFinishing = true;
  const text = iatResultText.trim();
  iatResultText = '';
  iatLiveText.value = '';
  cleanupRecording();
  if (text && vditor) {
    vditor.focus();
    setTimeout(() => { vditor?.insertValue(text); }, 80);
  }
}

function stopRecording() {
  if (iatWs && iatWs.readyState === WebSocket.OPEN) {
    iatWs.send(JSON.stringify({ data: { status: 2, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' } }));
  }
  // 等讯飞返回最终结果(500ms),然后 finishRecording
  setTimeout(() => {
    if (isRecording.value) finishRecording();
  }, 1000);
}

function cleanupRecording() {
  if (scriptNode) { scriptNode.disconnect(); scriptNode = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (iatWs) { try { iatWs.close(); } catch {} iatWs = null; }
  isRecording.value = false;
  if (recordTimer) { clearInterval(recordTimer); recordTimer = null; }
}

// ── 录音保存(语音备忘) ──
const isVoiceRecording = ref(false);
const voiceRecordTime = ref(0);
let voiceRecordTimer: ReturnType<typeof setInterval> | null = null;
let mediaRecorder: MediaRecorder | null = null;
let voiceChunks: Blob[] = [];
let voiceStream: MediaStream | null = null;
const voiceUploading = ref(false);

// 录音命名弹窗:onstop 把 blob 暂存这里,等用户命名 confirm 后才上传
const voiceNameModalOpen = ref(false);
const pendingVoiceBlob = ref<Blob | null>(null);
const pendingVoiceDur = ref(0);
const pendingVoiceExt = ref('m4a');
const pendingVoiceMime = ref('audio/mp4');

async function toggleVoiceRecord() {
  if (isVoiceRecording.value) {
    stopVoiceRecord();
  } else {
    startVoiceRecord();
  }
}

// 选最佳录音格式: m4a (AAC) > ogg > webm. m4a 在 Win/Mac/iOS/Android 默认播放器都能播,微信能发
function pickAudioMimeType(): { mime: string; baseMime: string; ext: string } {
  const candidates = [
    { mime: 'audio/mp4;codecs=mp4a.40.2', baseMime: 'audio/mp4',  ext: 'm4a'  },
    { mime: 'audio/mp4',                  baseMime: 'audio/mp4',  ext: 'm4a'  },
    { mime: 'audio/ogg;codecs=opus',      baseMime: 'audio/ogg',  ext: 'ogg'  },
    { mime: 'audio/webm;codecs=opus',     baseMime: 'audio/webm', ext: 'webm' },
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mime)) return c;
  }
  return { mime: '', baseMime: 'audio/webm', ext: 'webm' }; // 兜底:让浏览器自选
}

async function startVoiceRecord() {
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const picked = pickAudioMimeType();
    mediaRecorder = new MediaRecorder(voiceStream, picked.mime ? { mimeType: picked.mime } : undefined);
    voiceChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) voiceChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const dur = voiceRecordTime.value;
      cleanupVoiceRecord();
      if (!voiceChunks.length) return;

      // 暂存 blob,弹窗让用户命名后才上传
      // voiceUploading 在此覆盖"命名中+上传中..."整个等待阶段,防止用户期间再按录音
      pendingVoiceBlob.value = new Blob(voiceChunks, { type: picked.baseMime });
      pendingVoiceDur.value = dur;
      pendingVoiceExt.value = picked.ext;
      pendingVoiceMime.value = picked.baseMime;
      voiceChunks = [];
      voiceUploading.value = true;
      voiceNameModalOpen.value = true;
    };

    mediaRecorder.start(1000);
    isVoiceRecording.value = true;
    voiceRecordTime.value = 0;
    voiceRecordTimer = setInterval(() => { voiceRecordTime.value++; }, 1000);
  } catch (e: any) {
    console.error('[录音保存] 启动失败:', e.message);
  }
}

function stopVoiceRecord() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function cleanupVoiceRecord() {
  if (voiceStream) { voiceStream.getTracks().forEach(t => t.stop()); voiceStream = null; }
  mediaRecorder = null;
  isVoiceRecording.value = false;
  if (voiceRecordTimer) { clearInterval(voiceRecordTimer); voiceRecordTimer = null; }
}

// 用户在命名弹窗输入完确认 (或取消 = 用默认名),真正上传暂存的录音
async function uploadPendingVoice(name: string) {
  const blob = pendingVoiceBlob.value;
  const dur = pendingVoiceDur.value;
  const ext = pendingVoiceExt.value;
  const mime = pendingVoiceMime.value;
  pendingVoiceBlob.value = null;
  if (!blob) return;
  voiceUploading.value = true;
  try {
    const file = new File([blob], `voice.${ext}`, { type: mime });
    const res = await api.uploadFile(file, 'file', { displayName: name });
    if (res.data?.url && vditor) {
      vditor.focus();
      setTimeout(() => {
        vditor?.insertValue(`[语音备忘 ${dur}s](${resolveFileUrl(res.data.url)})`);
      }, 80);
      try {
        const me = await api.getMe();
        const prefs = me.data?.preferences || {};
        if (prefs.autoTranscribeVoice) {
          api.transcribeAsync(res.data.url).catch(() => {});
        }
      } catch {}
    }
  } catch (err: any) {
    console.error('[录音保存] 上传失败:', err.message);
  } finally {
    voiceUploading.value = false;
  }
}

defineExpose({ clearContent, isDirty: computed(() => dirty.value) });
</script>

<template>
  <div @keydown="onKeydown"
    :data-fullscreen="isFullscreen || undefined"
    :style="{ viewTransitionName: vtName }"
    :class="isFullscreen
      ? 'fixed inset-0 z-[var(--z-modal)] bg-white flex flex-col'
      : 'flex flex-col'">
    <!-- Vditor editor -->
    <!-- minHeight 占位精确等于 Vditor 加载完会设置的值 (Vditor 源码会执行
         element.style.minHeight = options.minHeight + 'px',直接写到 wrapper 上)。
         保持一致后:加载前/加载后/Vue patchStyle 重设时三个值都一样,避免高度抖动。
         (历史版本写 +36 想多占工具栏空间,但 Vditor 加载后会覆盖回 props.minHeight,
         导致加载前比加载后高 36px,而且每次 Vue update 会把 Vditor 设的覆盖掉变高。) -->
    <div ref="editorRef" class="vditor-wrapper"
      :data-drag-over="isDragOver ? '' : undefined"
      :style="isFullscreen ? { flex: '1 1 auto', minHeight: 0 } : { '--editor-max': maxHeight + 'px', minHeight: minHeight + 'px' }"></div>

    <!-- AI buttons + bottom bar (录音时 absolute overlay 浮层覆盖此行,不占额外高度) -->
    <div class="relative">
    <div class="flex items-center justify-between gap-2 px-3 py-2 bg-gray-50 border-t border-gray-100 select-none">
      <div class="flex items-center gap-2 flex-wrap min-w-0">
        <!-- Type selector. PR #9: lockType=true 时 button disable, 视觉灰显, 点击不响应 (非作者编辑共享笔记) -->
        <div v-if="showTypeSelector" class="flex gap-0.5">
          <button v-for="t in noteTypes" :key="t.value" @click="lockType ? null : (noteType = t.value)"
            :disabled="lockType && noteType !== t.value"
            class="px-2 py-1 rounded-md text-xs transition-colors inline-flex items-center gap-1"
            :class="[
              noteType === t.value ? 'bg-primary-light text-primary-dark font-medium' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600',
              lockType ? 'cursor-not-allowed' : '',
              lockType && noteType !== t.value ? 'opacity-40' : '',
            ]"
            :title="lockType ? '非作者不能改类型' : ''">
            <component :is="t.icon" size="0.875rem" weight="fill" :style="t.iconStyle" />
            {{ t.label }}
          </button>
        </div>
        <span v-if="showTypeSelector" class="sep"></span>

        <!-- AI buttons with labels -->
        <template v-if="showAi">
          <div class="flex gap-0.5">
            <button v-for="f in aiFeatureOptions" :key="f.value"
              @click="aiFeature === f.value && showAiPanel ? closeAiPanel() : openAiPanel(f.value)"
              class="px-2 py-1 rounded-md text-xs transition-colors inline-flex items-center gap-1"
              :class="showAiPanel && aiFeature === f.value ? 'bg-primary-light text-primary-dark font-medium' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'">
              <component :is="f.icon" size="0.875rem" weight="fill" :style="f.iconStyle" />
              {{ f.label }}
            </button>
          </div>
          <span class="sep"></span>
        </template>

        <!-- Tags. PR #9: hideTags=true 时入口隐藏 (非作者编辑共享笔记不能改 tag) -->
        <div v-if="!hideTags" class="relative">
          <button ref="tagBtnEl" @click.stop="showTagInput = !showTagInput" class="tbtn text-gray-400" title="添加标签"><PhTag size="0.875rem" weight="fill" /></button>
        </div>
        <!-- Reference -->
        <div class="relative">
          <button ref="refBtnEl" @click.stop="showRefSearch = !showRefSearch" class="tbtn text-gray-400" title="引用笔记"><PhPushPin size="0.875rem" weight="fill" /></button>
        </div>
        <!-- 录音 -->
        <button @click="toggleRecording"
          class="tbtn transition-colors"
          :class="isRecording ? 'text-red-500 bg-red-100 rounded-md' : 'text-gray-400'"
          :title="isRecording ? '' : '语音输入'">
          <PhRecord v-if="isRecording" size="0.875rem" weight="fill" class="text-red-500" />
          <PhMicrophone v-else size="0.875rem" weight="fill" />
        </button>
        <span v-if="isRecording" class="text-[11px] text-red-500 font-medium tabular-nums select-none">
          {{ recordingTime }}s
        </span>
        <!-- 录音保存 -->
        <button @click="toggleVoiceRecord" :disabled="voiceUploading || isRecording"
          class="tbtn transition-colors"
          :class="isVoiceRecording ? 'rounded-md' : voiceUploading ? 'text-gray-300' : 'text-gray-400'"
          :style="isVoiceRecording ? 'color: white; background: rgb(var(--c-accent))' : ''"
          :title="isVoiceRecording ? '' : voiceUploading ? '上传中...' : '录音保存'">
          <PhRecord v-if="isVoiceRecording" size="0.875rem" weight="fill" class="text-white" />
          <PhWaveform v-else-if="voiceUploading" size="0.875rem" weight="fill" class="animate-pulse" />
          <PhWaveform v-else size="0.875rem" weight="fill" />
        </button>
        <span v-if="isVoiceRecording" class="text-[11px] font-medium tabular-nums select-none" style="color: rgb(var(--c-accent))">
          {{ voiceRecordTime }}s
        </span>
      </div>

      <!-- Submit + fullscreen + category chip + visibility chip (PR #2 群组共享) -->
      <div class="flex items-center gap-1.5 shrink-0">
        <span v-if="hintText" class="text-[11px] text-gray-400 mr-1">{{ hintText }}</span>
        <CategoryPicker v-if="showCategoryPicker" v-model="categoryModel" compact />
        <VisibilityChip v-if="showVisibilityChip" v-model="visibilityModel" compact />
        <button v-if="showFullscreenBtn" @click="toggleFullscreen"
          class="p-1.5 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          :title="isFullscreen ? '退出全屏 (Esc)' : '全屏编辑'">
          <PhArrowsOut v-if="!isFullscreen" size="0.875rem" weight="fill" />
          <PhArrowsIn v-else size="0.875rem" weight="fill" />
        </button>
        <slot name="submit-button">
          <button @click="handleSubmit"
            class="px-4 py-1.5 bg-primary text-white text-xs font-medium rounded-lg hover:bg-primary-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {{ submitLabel }}
          </button>
        </slot>
      </div>
    </div>

    <!-- 录音中浮层覆盖按钮 row,absolute inset-0 不占额外高度 -->
    <!-- voice-overlay / voice-time / voice-stop-btn class 给 Capture.vue 压缩用 -->
    <div v-if="isRecording || iatLiveText"
         class="voice-overlay absolute inset-0 flex items-center gap-2 px-3 py-2 border-t border-gray-100"
         style="background: rgb(var(--c-accent-light))">
      <span class="w-1.5 h-1.5 rounded-full animate-pulse shrink-0" style="background: rgb(var(--c-accent))"></span>
      <span ref="liveTextEl" class="voice-live-text text-sm flex-1 min-w-0 overflow-x-auto whitespace-nowrap scrollbar-hide" style="color: rgb(var(--c-accent-dark))">{{ iatLiveText || '正在聆听...' }}</span>
      <span class="voice-time text-xs font-medium tabular-nums select-none shrink-0" style="color: rgb(var(--c-accent-dark))">{{ recordingTime }}s</span>
      <button @click="toggleRecording" class="voice-stop-btn px-4 py-1.5 bg-red-100 text-red-600 text-xs font-medium rounded-lg hover:bg-red-200 shrink-0 transition-colors" title="停止录音">
        停止
      </button>
    </div>
    </div>

    <!-- AI Panel -->
    <div v-if="showAi && showAiPanel" class="border-t border-gray-100 bg-gray-50/80">
      <div class="flex items-center px-3 pt-2">
        <span class="text-xs font-medium text-gray-500 inline-flex items-center gap-1">
          <component :is="currentAiFeatureIcon" size="0.875rem" weight="fill" />
          {{ aiFeatureOptions.find(f => f.value === aiFeature)?.label }}
        </span>
        <button @click="closeAiPanel" class="ml-auto p-1 text-gray-400 hover:text-gray-600 text-xs">✕</button>
      </div>
      <div class="px-3 py-2">
        <textarea v-model="aiPromptText" rows="6"
          class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs leading-relaxed outline-none focus:border-primary font-mono resize-none text-gray-600 bg-white" />
        <p class="text-[11px] text-gray-400 mt-1">提示词可临时编辑，关闭后恢复默认。{content} 替换为笔记内容。选中文本时仅处理选中部分，否则处理全文。</p>
      </div>
      <div class="px-3 pb-3">
        <div v-if="aiError" class="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2 mb-2">{{ aiError }}</div>
        <div v-if="aiResult" class="mb-2">
          <div class="text-[10px] text-gray-400 mb-1">AI 结果预览：</div>
          <pre class="max-h-40 overflow-y-auto bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-700 whitespace-pre-wrap font-mono">{{ aiResult }}</pre>
        </div>
        <div class="flex gap-2">
          <button v-if="!aiResult" @click="runAi" :disabled="aiProcessing"
            class="px-4 py-1.5 text-white text-xs font-medium rounded-lg disabled:opacity-50 transition-colors"
            style="background: rgb(var(--c-accent))">
            {{ aiProcessing ? '处理中' : '开始' }}
          </button>
          <template v-else>
            <button @click="applyAiResult" class="px-4 py-1.5 text-white text-xs font-medium rounded-lg transition-colors" style="background: rgb(var(--c-accent))">应用</button>
            <button @click="runAi" :disabled="aiProcessing" class="px-4 py-1.5 text-xs text-gray-500 rounded-lg hover:bg-gray-100">{{ aiProcessing ? '处理中' : '重新生成' }}</button>
          </template>
        </div>
      </div>
    </div>

    <!-- Tags display. PR #9: hideTags=true 时整行隐藏 (非作者不能改 tag, 显示也无意义) -->
    <div v-if="tags.length && !hideTags" class="flex flex-wrap gap-1 px-4 py-2 border-t border-gray-50">
      <span v-for="tag in tags" :key="tag" class="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
        #{{ tag }} <button @click="removeTag(tag)" class="text-gray-400 hover:text-red-500">&times;</button>
      </span>
    </div>
  </div>

  <!-- Popups: Teleport 到 body,不受 modal overflow-hidden 裁剪 -->
  <Teleport to="body">
    <div v-if="showTagInput || showRefSearch" class="fixed inset-0" style="z-index: var(--z-overlay-backdrop)" @click="closePopups" />
    <!-- Tag popup -->
    <div v-if="showTagInput" class="bg-white border border-gray-200 rounded-lg shadow-lg p-2 flex items-center gap-2 whitespace-nowrap"
      :style="getPopupPos(tagBtnEl, 220)">
      <input v-model="tagInput" @keydown.enter="addTag" @click.stop placeholder="输入标签回车添加" class="popup-input w-40" />
      <button @click.stop="addTag" class="popup-btn shrink-0">添加</button>
    </div>
    <!-- Reference popup -->
    <div v-if="showRefSearch" class="bg-white border border-gray-200 rounded-lg shadow-lg p-2 w-64"
      :style="getPopupPos(refBtnEl, 256)">
      <div v-if="refResults.length" class="flex-1 min-h-0 overflow-y-auto space-y-1 mb-1">
        <button v-for="r in refResults" :key="r.id" @click.stop="insertRef(r)" class="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50 text-xs text-gray-600 truncate">
          {{ r.content.replace(/[#*`\[\]<>]/g, '').split('\n')[0]?.slice(0, 40) }}
        </button>
      </div>
      <div v-else-if="refQuery.trim()" class="text-xs text-gray-400 py-2 text-center mb-1">无结果</div>
      <input v-model="refQuery" @input="searchRefs" @click.stop placeholder="搜索笔记..." class="popup-input w-full shrink-0" />
    </div>
  </Teleport>

  <!-- 录音命名弹窗 -->
  <RenameModal
    v-model:open="voiceNameModalOpen"
    default-name="语音备忘"
    :ext="pendingVoiceExt"
    title="给录音命名"
    @confirm="uploadPendingVoice"
    @cancel="uploadPendingVoice('语音备忘')"
  />

  <!-- 自定义 vditor toolbar tooltip: Teleport 到 body,脱离 main overflow 裁切 -->
  <Teleport to="body">
    <div v-if="customTooltip.visible"
         class="fixed z-[var(--z-tooltip)] px-2 py-1 bg-gray-800 text-white text-[11px] rounded shadow-lg pointer-events-none whitespace-nowrap"
         :style="{ top: customTooltip.top + 'px', left: customTooltip.left + 'px', transform: 'translateX(-50%)' }">
      {{ customTooltip.text }}
    </div>
  </Teleport>
</template>

<style>
.scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
.scrollbar-hide::-webkit-scrollbar { display: none; }
/* Vditor theme overrides —— Vditor 把 .vditor class 合并到 .vditor-wrapper 上 */
.vditor-wrapper {
  border: none !important;
  width: 100% !important;
  display: flex !important;
  flex-direction: column !important;
}
/* 用 [data-drag-over] 而不是 .is-drag-over: vditor init 时会给 wrapper 加 .vditor class,
   Vue :class 在 reactive 切换时会重写 element.className 全集, 覆盖丢失 .vditor class →
   toolbar 失去 vditor CSS 变小 7px, pre 上移 +7px 撑高补位, 且 class 永久丢失不回退.
   data-* attribute 只 toggle 单个属性, 不动 className. */
.vditor-wrapper[data-drag-over] > .vditor-content {
  position: relative;
}
.vditor-wrapper[data-drag-over] > .vditor-content::after {
  content: '拖入文件以上传';
  position: absolute;
  inset: 0;
  border: 3px dashed rgb(var(--c-accent));
  border-radius: 0.75rem;
  background: rgba(255, 255, 255, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgb(var(--c-accent) / 0.7);
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  pointer-events: none;
  z-index: 10;
}
[data-theme="dark"] .vditor-wrapper[data-drag-over] > .vditor-content::after {
  background: rgba(0, 0, 0, 0.55);
}
.vditor-wrapper[data-drag-over] .vditor-reset::before {
  visibility: hidden !important;
}
/* 非全屏:限制内容区 max-height + overflow */
.vditor-wrapper > .vditor-content {
  max-height: var(--editor-max, none) !important;
  overflow-y: auto !important;
}
.vditor-wrapper .vditor-toolbar {
  border-bottom: 1px solid #f1f5f9 !important;
  padding: 2px 6px !important;
  background: transparent !important;
}
/* 隐藏 Vditor 默认 tooltip 伪元素,由 Teleport 到 body 的自定义 tooltip 替代 */
.vditor-tooltipped::before,
.vditor-tooltipped::after {
  display: none !important;
}
.vditor-wrapper .vditor-toolbar__item {
  padding: 0 !important;
  margin: 0 1px !important;
}
/* upload 项是 <div>(Vditor 源码硬编码 s = name==="upload" ? "div" : "button"),其他工具项才是 button。
   所有针对 button 的样式都要把 [data-type="upload"] 接上,否则尺寸 / 颜色 / hover 灰底全失效。 */
/* 所有工具栏项 (button + upload div) 统一 inline-flex 居中,
   保证 hover 灰底位置一致 + svg 在灰底中央。
   button 默认 inline-block + svg baseline 排版会让位置略偏,统一 flex 后所有图标视觉对齐。
   transform translateY(3px) 让整行按钮 (连带 hover 灰底) 视觉下移,
   抵消 flex 居中相对 baseline 位置整体偏高的差值。transform 不影响 toolbar 实际高度。 */
.vditor-wrapper .vditor-toolbar__item button,
.vditor-wrapper .vditor-toolbar__item > span,
.vditor-wrapper .vditor-toolbar__item [data-type="upload"] {
  color: #64748b;
  height: 28px !important;
  width: 28px !important;
  padding: 0 !important;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: var(--cur-pointer), pointer;
  transform: translateY(3px);
}
.vditor-wrapper .vditor-toolbar__item button svg,
.vditor-wrapper .vditor-toolbar__item [data-type="upload"] svg {
  height: 14px !important;
  width: 14px !important;
}
.vditor-wrapper .vditor-toolbar__item button:hover,
.vditor-wrapper .vditor-toolbar__item [data-type="upload"]:hover {
  color: #1e293b;
  background: #f1f5f9;
  border-radius: 6px;
}
.vditor-wrapper .vditor-toolbar__item--current button {
  color: rgb(var(--c-accent)) !important;
  background: rgb(var(--c-accent-light)) !important;
  border-radius: 6px;
}
.vditor-wrapper .vditor-ir .vditor-reset,
.vditor-wrapper .vditor-wysiwyg .vditor-reset,
.vditor-wrapper .vditor-sv .vditor-reset {
  font-size: 14px;
  padding: 8px 16px;
  min-height: 80px;
}
/* 去掉编辑区第一个元素的上边距 */
.vditor-wrapper .vditor-reset > :first-child {
  margin-top: 0 !important;
  padding-top: 0 !important;
}
/* Vditor IR 模式给 heading 加 :before 伪元素显示 H1/H2/H3 标记,用 margin-left: -29px
   定位到左侧编辑区外。我们的 padding-left 16px 不够容纳 → 标记左半被裁(显示半个数字)。
   IR 模式 heading 已经渲染成大字粗体,语义已经够明显,直接隐藏标记保持视觉干净 */
.vditor-ir .vditor-reset > h1:before,
.vditor-ir .vditor-reset > h2:before,
.vditor-ir .vditor-reset > h3:before,
.vditor-ir .vditor-reset > h4:before,
.vditor-ir .vditor-reset > h5:before,
.vditor-ir .vditor-reset > h6:before {
  display: none !important;
}
/* 去掉 Vditor 内置的居中和多余间距，让内容区撑满 */
.vditor-wrapper .vditor-reset,
.vditor .vditor-reset,
.vditor-ir .vditor-reset,
.vditor-ir pre.vditor-reset {
  max-width: none !important;
  margin: 0 !important;
  padding: 8px 16px !important;
  width: 100% !important;
  box-sizing: border-box !important;
}
/* placeholder 也从头开始 */
.vditor-ir pre.vditor-reset:empty::before,
.vditor-ir .vditor-reset .vditor-ir__marker--bi::before {
  margin-left: 0 !important;
}
.vditor-wrapper .vditor-reset {
  color: #1e293b;
}
.vditor-wrapper .vditor-reset::before {
  color: #9ca3af !important;
}
/* 全屏时 content 撑满 */
[data-fullscreen="true"] > .vditor-wrapper > .vditor-content {
  flex: 1 1 0 !important;
  max-height: none !important;
  min-height: 0 !important;
  height: 0 !important;
}
/* tooltip 统一翻转到下方（全屏贴顶/Capture 被标题栏挡） */
[data-fullscreen="true"] .vditor-tooltipped::after,
.tooltip-below .vditor-tooltipped::after {
  top: 100% !important;
  bottom: auto !important;
  margin-top: 5px !important;
  margin-bottom: 0 !important;
}
[data-fullscreen="true"] .vditor-tooltipped::before,
.tooltip-below .vditor-tooltipped::before {
  top: 100% !important;
  bottom: auto !important;
  border: 5px solid transparent !important;
  border-bottom-color: rgba(0,0,0,0.8) !important;
  margin-top: -1px !important;
}
/* Fix emoji panel */
.vditor-wrapper .vditor-hint, .vditor-wrapper .vditor-panel--arrow {
  z-index: 999 !important;
}
/* Dark mode */
[data-theme="dark"] .vditor-wrapper .vditor-toolbar { border-bottom-color: rgba(255,255,255,0.06) !important; }
[data-theme="dark"] .vditor-wrapper .vditor-toolbar__item button,
[data-theme="dark"] .vditor-wrapper .vditor-toolbar__item > span { color: #94a3b8; }
[data-theme="dark"] .vditor-wrapper .vditor-toolbar__item button:hover { color: #e2e8f0; background: rgba(255,255,255,0.08); }
[data-theme="dark"] .vditor-wrapper .vditor-reset { color: #e2e8f0; }
[data-theme="dark"] .vditor-wrapper .vditor-reset::before { color: rgba(255,255,255,0.25) !important; }
</style>
