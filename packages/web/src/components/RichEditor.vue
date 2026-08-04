<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick, markRaw } from 'vue';
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
import { useToast } from '@/composables/useToast';
import RenameModal from './RenameModal.vue';
import VisibilityChip from './VisibilityChip.vue';
import CategoryPicker from './CategoryPicker.vue';
import TodoModeChip from './TodoModeChip.vue';
import EditorBlockTools from './EditorBlockTools.vue';
import EditorTextStylePicker from './EditorTextStylePicker.vue';
import { findBlock, commit as commitEditor, focusCell, moveBlockUp, moveBlockDown } from '@/utils/editorBlockOps';
import { createInlineStyleDecor, wrapWithStyle, type DecorHandle } from '@/utils/inlineStyleDecor';
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
  PhX,
} from '@phosphor-icons/vue';

// 常用 emoji 套装 (48 个) + 中文名映射 (给悬浮 tooltip 用).
// Vditor 默认只 8 个 (👍 👎 😕 👀 ❤️ 🚀 😄 🎉), 蘑菇 2026-07-06 扩到 48. key 是 Vditor 面板 data-key
// (英文名, 单独存 unicode 会被 CJK 输入法当组合键搅乱), value 是 emoji unicode.
// 顺序按情绪 (笑/思考/负面) → 动作手势 → 符号 分类, 用户按面板浏览有节奏.
const EMOJI_MAP: Record<string, string> = {
  smile: '😀', laughing: '😄', joy: '😂', rofl: '🤣', sweat_smile: '😅',
  slight_smile: '🙂', blush: '😊', innocent: '😇', heart_eyes: '😍', kiss: '😘',
  wink: '😉', hug: '🤗', thinking: '🤔', neutral: '😐', no_mouth: '😶',
  eye_roll: '🙄', smirk: '😏', unamused: '😒', pensive: '😔', worried: '😟',
  confused: '😕', frown: '🙁', cry: '😢', sob: '😭', huff: '😤',
  angry: '😠', rage: '😡', flushed: '😳', pleading: '🥺', scream: '😱',
  sleep: '😴', eyes: '👀',
  thumbs_up: '👍', thumbs_down: '👎', clap: '👏', pray: '🙏', muscle: '💪',
  handshake: '🤝', ok_hand: '👌',
  heart: '❤️', broken_heart: '💔', fire: '🔥', sparkles: '✨', tada: '🎉',
  star: '⭐', check: '✅', cross: '❌', question: '❓', hundred: '💯',
};
const EMOJI_ZH: Record<string, string> = {
  smile: '微笑', laughing: '大笑', joy: '笑哭', rofl: '笑翻', sweat_smile: '苦笑',
  slight_smile: '浅笑', blush: '羞涩', innocent: '天使', heart_eyes: '花痴', kiss: '飞吻',
  wink: '眨眼', hug: '抱抱', thinking: '思考', neutral: '无表情', no_mouth: '无语',
  eye_roll: '翻白眼', smirk: '坏笑', unamused: '不爽', pensive: '沉思', worried: '担心',
  confused: '困惑', frown: '不高兴', cry: '哭泣', sob: '大哭', huff: '生气',
  angry: '愤怒', rage: '暴怒', flushed: '脸红', pleading: '求求了', scream: '惊恐',
  sleep: '睡觉', eyes: '看',
  thumbs_up: '赞', thumbs_down: '踩', clap: '鼓掌', pray: '祈祷', muscle: '加油',
  handshake: '握手', ok_hand: 'OK',
  heart: '爱心', broken_heart: '心碎', fire: '火', sparkles: '闪亮', tada: '庆祝',
  star: '星星', check: '对', cross: '错', question: '问号', hundred: '满分',
};

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
  // 群组共享: chip 控制可见性 (private / shared 到 N 群)
  initialVisibility?: 'private' | 'shared';
  initialSharedGroupIds?: string[];
  showVisibilityChip?: boolean;
  // 分类 chip: null = 走 AI 自动分类 (或显示"未分类"), 非空 = 用户手动选过
  initialCategory?: string | null;
  showCategoryPicker?: boolean;
  // 权限分级: 非作者编辑共享笔记时锁定 type 不可改 + 隐藏 tag 入口 (只让改正文)
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
  (e: 'submit', data: { html: string; type: string; tags: string[]; visibility: 'private' | 'shared'; sharedGroupIds: string[]; category: string | null; todoGroupMode?: 'group' | 'everyone'; rosterDueAt?: string | null; rosterVisibility?: 'count' | 'full' | 'none' }): void;
  (e: 'ready'): void;
}>();

// 群组共享: 内部双向 v-model 的可见性状态. NoteInput 等用方传 initial*, 不再外部 sync (chip popover 实时更新)
const visibilityModel = ref<{ visibility: 'private' | 'shared'; sharedGroupIds: string[] }>({
  visibility: props.initialVisibility,
  sharedGroupIds: [...props.initialSharedGroupIds],
});
// 分类 chip: null = 走 AI 自动分类 (后端 autoClassify 仅在 category 为 null 时回填); 非空 = 用户手动选过, 保护不被 AI 覆盖
const categoryModel = ref<string | null>(props.initialCategory);
// 群组待办类型 (仅 type=todo + shared 时底栏显示 TodoModeChip). rosterDueAt 存本地 datetime, submit 转 ISO.
const todoModeModel = ref<{ todoGroupMode: 'group' | 'everyone'; rosterDueAt: string | null; rosterVisibility: 'count' | 'full' | 'none' }>({
  todoGroupMode: 'group', rosterDueAt: null, rosterVisibility: 'count',
});

// 命名约定: value 跟字段值一致 (quink=灵感, note=笔记, todo=待办)
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
// popup input ref: v-if + Teleport 场景 HTML autofocus 属性不 fire (activeElement 保持在 Vditor PRE),
// 用 watch + nextTick + .focus() 主动聚焦 (蘑菇 2026-07-06 反馈)
const tagInputRef = ref<HTMLInputElement | null>(null);
const refInputRef = ref<HTMLInputElement | null>(null);
watch(showTagInput, (v) => { if (v) nextTick(() => tagInputRef.value?.focus()); });
watch(showRefSearch, (v) => { if (v) nextTick(() => refInputRef.value?.focus()); });

function getPopupPos(el: HTMLElement | undefined, width: number) {
  if (!el) return { display: 'none' };
  // 移动端 (< 768px) 直接居中显示 (蘑菇 2026-07-06 反馈: 类似弹窗移动端一律居中).
  // fixed left:50% top:50% + translate 是纯 CSS 位移, 不受 zoom / rect 影响, 天然稳.
  if (window.innerWidth < 768) {
    return {
      position: 'fixed' as const,
      top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: 9999,
      maxHeight: '80vh',
    };
  }
  // 桌面: CSS zoom 下裸 getBoundingClientRect 是 zoom 后视觉坐标, 设进 fixed inline top/left px 会被 zoom 再乘一次 → 偏 (zoom-1)*100%.
  // 用 unzoomRect + unzoomViewport 归一到 layout px, 让 fixed 元素渲染时 zoom 一次回到目标视觉位置. 详见 utils/zoom.ts + ZOOM.md.
  const r = unzoomRect(el);
  const { vw, vh } = unzoomViewport();
  const maxH = Math.max(r.top - 8, 100);
  // popup 左对齐按钮向右展开 (蘑菇 2026-07-06 反馈: 之前 r.right - width 导致 popup 太靠左).
  // 右边超屏 → 向左移让贴屏幕右边 8px 边距; 左边最少 8px 边距.
  const rawLeft = r.left;
  const left = Math.max(8, Math.min(rawLeft, vw - width - 8));
  return {
    position: 'fixed' as const,
    bottom: `${vh - r.top + 4}px`,
    left: `${left}px`,
    zIndex: 9999, // var(--z-overlay), JS inline 取不到 CSS var, 跟 scale 保持同档, 见根 Z-INDEX-SCALE.md
    maxHeight: `${maxH}px`,
  };
}

// AI panel
const showAiPanel = ref(false);
const aiFeature = ref<'polish' | 'expand' | 'write'>('polish');
const aiPromptText = ref('');
const aiProcessing = ref(false);
const aiResult = ref('');
const aiError = ref('');
const aiResultEl = ref<HTMLTextAreaElement | null>(null);

// 流式追加时自动 scroll 到底部, 打字机效果不用用户手滚跟随.
// 简单粗暴 scroll to bottom: 流式期间用户主动往上滚看历史内容的情况罕见, 强制跟随反而符合预期.
watch(aiResult, async () => {
  await nextTick();
  const el = aiResultEl.value;
  if (el) el.scrollTop = el.scrollHeight;
});

// 三个图标都比文字基线整体下移 1px，并按各自重心偏差再细调对齐：
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
// Vditor 内容区 (.vditor-ir .vditor-reset), 表格/块悬浮工具挂在它上面。
// Vditor 是异步建 DOM 的, 所以在 after 回调里才拿得到
const contentEl = ref<HTMLElement | null>(null);
let vditor: Vditor | null = null;
// 内联样式(颜色/字号)装饰层, after 回调里创建, 卸载时 destroy
let decor: DecorHandle | null = null;
const dirty = ref(false);
const toast = useToast();

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

// 上传单个文件 + 进传输 dock, 返回后端裸 url (失败/取消返 null). 拖拽 / 截图 / 粘贴 base64 图共用.
async function uploadFileToUrl(file: File): Promise<string | null> {
  const ctrl = new AbortController();
  const taskId = await addUploadTask(file.name, file.size, ctrl);
  try {
    const res = await api.uploadFile(file, 'file', {
      signal: ctrl.signal,
      onProgress: (recv, total) => updateProgressById(taskId, recv, total),
    });
    markSuccessById(taskId);
    return res.data?.url ?? null;
  } catch (err: any) {
    if (err?.name === 'AbortError') markCancelledById(taskId);
    else markFailedById(taskId, err?.message || '上传失败');
    return null;
  }
}

async function uploadAndInsert(files: File[]) {
  vditor?.focus();
  const results = await Promise.all(files.map(async (file) => ({
    name: file.name,
    type: file.type,
    url: await uploadFileToUrl(file),
  })));
  vditor?.focus();
  setTimeout(() => {
    for (const r of results) {
      if (!r.url) continue;
      const url = resolveFileUrl(r.url);
      const md = r.type?.startsWith('image/')
        ? `![${r.name}](${url})\n`
        : `[📎 ${r.name}](${url})\n`;
      vditor?.insertValue(md);
    }
  }, 80);
}

// data:image/png;base64,xxx → File (atob 解码). 解析失败返 null.
function dataUrlToFile(dataUrl: string, name: string): File | null {
  const m = /^data:(image\/[\w.+-]+);base64,(.*)$/i.exec(dataUrl);
  if (!m) return null;
  const mime = m[1];
  try {
    const bin = atob(m[2]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const ext = mime.split('/')[1].split('+')[0].replace('jpeg', 'jpg');
    return new File([arr], `${name}.${ext}`, { type: mime });
  } catch {
    return null;
  }
}

// 粘贴的富文本里含 base64 内联图 (典型: 微信油猴脚本把图转成 base64) 时, 先把每张 base64 图上传换成 url
// 再转 markdown 插入, 不让 base64 进编辑器/DB. 否则多张大 base64 内联会卡死 IR 实时渲染 + 保存序列化 (主线程饿死).
// 失败的图直接剥掉 (绝不保留 base64). 走 vditor.lute.HTML2Md 把换好 url 的 html 转 markdown.
async function handleRichPasteWithImages(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const base64Imgs = Array.from(doc.querySelectorAll('img'))
    .filter((img) => (img.getAttribute('src') || '').startsWith('data:'));
  if (!base64Imgs.length) return;

  const tipId = toast.show(`正在上传 ${base64Imgs.length} 张图片...`, 'default', 60000);
  let failed = 0;
  const base = `pasted-${Date.now()}`;
  await Promise.all(base64Imgs.map(async (img, i) => {
    const file = dataUrlToFile(img.getAttribute('src') || '', `${base}-${i}`);
    if (!file) { img.remove(); failed++; return; }
    const url = await uploadFileToUrl(file);
    if (url) img.setAttribute('src', resolveFileUrl(url));
    else { img.remove(); failed++; }
  }));
  toast.dismiss(tipId);

  // img 已换成 absolute url (跟编辑器内 path 约定一致), html2md 转出的 ![](url) 保存时再 strip 回裸名.
  // 用 Vditor 公开方法 html2md (内部走 lute.HTML2Md); 不要碰 vditor.vditor.lute 内部对象 (外层实例上没有 lute)
  const md = vditor?.html2md(doc.body.innerHTML) ?? '';
  vditor?.focus();
  setTimeout(() => {
    if (md) vditor?.insertValue(md);
    if (failed > 0) toast.show(`${base64Imgs.length - failed} 张图片已插入, ${failed} 张上传失败已跳过`, 'error', 3000);
  }, 80);
}

// capture 阶段拦截粘贴: 剪贴板富文本含 base64 内联图时自己处理 (上传换 url), 抢在 Vditor 内置 paste 前 (它绑 bubble).
// 其余 (纯文本 / 外链图 / 截图文件) 放行给 Vditor 默认逻辑, 它们不会卡.
function onEditorPaste(e: ClipboardEvent) {
  const html = e.clipboardData?.getData('text/html') || '';
  if (!html.includes('data:image')) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  handleRichPasteWithImages(html);
}

// ── 列表项内粘贴多行纯文本 → 每行拆成独立列表项 ──
// 问题: Vditor 粘贴纯文本走 Md2VditorIRDOM, 多行无空行文本在 markdown 里是"同段软换行",
// 会全挤进当前一个 <li> (一个勾选框 / 一个列表项), 跟用户"一行一个待办"预期不符 (手动按 Enter 才逐项拆).
// 解法: 光标在列表项内且粘贴多行纯文本时, 第一行 execCommand 接续当前项, 其余行按当前列表类型
// (task / 有序 / 无序) 各拼 marker 走 insertMD 建新项. 富文本 (带 a/strong/img 等格式标签) 放行给 Vditor.
function pasteFindListItem(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
  return el ? el.closest('li') : null;
}
// 剪贴板 html 是否"纯文本级": 只有 html/body/div/p/br/span 等结构包裹算纯文本 (记事本/终端/微信 常为空或仅结构标签),
// 含 a/strong/img 等格式标签算富文本 → 放行 (富文本每行拆项需 html2md 保格式, 暂不做)
function pasteIsPlainish(html: string): boolean {
  if (!html) return true;
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(html|head|body|meta|span|div|p|br|o:p)[^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
  return !/<[a-z]/i.test(cleaned);
}
function onListPaste(e: ClipboardEvent) {
  const textPlain = e.clipboardData?.getData('text/plain') || '';
  if (!textPlain) return;
  if (!pasteIsPlainish(e.clipboardData?.getData('text/html') || '')) return; // 富文本放行
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const li = pasteFindListItem(sel.getRangeAt(0).startContainer);
  if (!li) return; // 不在列表项, 放行
  const lines = textPlain.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length <= 1) return; // 单行 / 全空, 放行给 Vditor 默认
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  // 新项 marker: 有序 = `1. ` (Vditor insertMD 后自动重编号); 无序 / task = 当前 li 的 bullet (无 data-marker 属性则默认 `-`).
  // 关键: 无序 / task 必须把当前 li + 父列表的 data-marker 也写成同一 bullet, 否则新项与当前项 marker 不同
  // (典型: 点"任务列表"按钮建的空项 Vditor 默认 `*`, 我的新项 `-`), CommonMark 会当成两个独立列表 → 保存重载后列表分裂 + 多余空行.
  const parent = li.parentElement;
  let prefix: string;
  if (parent?.tagName === 'OL') {
    prefix = '1. ';
  } else {
    const dm = li.getAttribute('data-marker');
    const bullet = dm && /^[-*+]$/.test(dm) ? dm : '-';
    li.setAttribute('data-marker', bullet);
    parent?.setAttribute('data-marker', bullet);
    prefix = li.classList.contains('vditor-task') ? `${bullet} [ ] ` : `${bullet} `;
  }
  document.execCommand('insertText', false, lines[0]); // 第一行接续当前项 (有选中则替换选中)
  vditor?.insertMD(lines.slice(1).map((l) => prefix + l).join('\n')); // 其余行各建独立新项
}

// ── 粘贴多行纯文本时, 把单换行规范成段落分隔 ──
//
// 编辑器里按回车得到的是两个 <p>; 而从外部粘贴 `A\nB`, Vditor 给的是 `<p>A\nB</p>`
// —— 一个段落里夹着软换行。两者行间距不一样, markdown 源码也不一样(`A\n\nB` vs `A\nB`)。
// 更麻烦的是内联样式标签**不能包含换行**, 跨这种软换行上色会让标签跨段、配对失效。
//
// 所以粘贴时统一成段落分隔, 让"粘进来的"和"自己敲回车的"结构完全一致(蘑菇 2026-08-03 提)。
// markdown 里连续多个空行本来就等价于一个段落分隔, 规范化不丢语义。
function onMultilinePaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData('text/plain') || '';
  if (!/\n/.test(text)) return;                                        // 单行不用管
  if (!pasteIsPlainish(e.clipboardData?.getData('text/html') || '')) return;  // 富文本自带结构, 放行
  // 列表项里粘贴多行有专门的处理(拆成多个列表项), 那条路先走
  const sel = window.getSelection();
  if (sel && sel.rangeCount && pasteFindListItem(sel.getRangeAt(0).startContainer)) return;

  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n+/g, '\n\n').trim();
  if (!normalized) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  vditor?.insertValue(normalized);
}

// 自定义 vditor toolbar tooltip: 默认 vditor tooltip 是按钮的 ::before/::after 伪元素
// 被 App.vue main 的 overflow-y-auto 裁切(尤其飞向上方时)。改用 Teleport 到 body 的
// 自定义 tooltip,固定定位 + z-index 最顶,脱离任何 overflow 控制,永远朝上显示完整
const customTooltip = ref({ visible: false, text: '', top: 0, left: 0 });
function onToolbarMouseOver(e: MouseEvent) {
  const t = e.target as HTMLElement;
  // 两种触发源: 工具栏图标 (.vditor-tooltipped, 走 aria-label) / emoji 面板 button (走 data-key + EMOJI_ZH 中文名映射).
  let btn = t?.closest?.('.vditor-tooltipped') as HTMLElement | null;
  let label = btn?.getAttribute('aria-label') || '';
  if (!btn) {
    const emojiBtn = t?.closest?.('.vditor-emojis button') as HTMLElement | null;
    if (emojiBtn) {
      const key = emojiBtn.getAttribute('data-key') || '';
      const zh = EMOJI_ZH[key];
      if (zh) { btn = emojiBtn; label = zh; }
    }
  }
  if (!btn || !label) return;
  // unzoomRect + unzoomViewport: CSS zoom 下 rect 跟 viewport 归一到 unzoomed 防 tooltip 错位
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
  if (related?.closest?.('.vditor-emojis button')) return; // 在 emoji 面板 button 间移动不隐藏
  customTooltip.value.visible = false;
}

// ── 工具栏「本段上移 / 下移」──
// 蘑菇 2026-08-03 定: 段落整块上下移放工具栏, 不做悬浮箭头。
// 工具栏是字符串配置, 塞不进 Vue 组件, 图标只能写 inline SVG (根 ICONS.md 的例外条款)。
//
// 这里**特意用 Vditor 自带的图标**而不是 phosphor (蘑菇 2026-08-03: "你这个图标没人家的好看"):
// `#vditor-icon-up` / `#vditor-icon-down` 是 Vditor 启动时注入页面的 SVG symbol,
// 用 <use> 引用就跟工具栏上加粗/斜体那些按钮彻底同源同风格, 不会一眼看出是外挂的。
// 这是 ICONS.md "统一 phosphor" 的有意例外 —— 因为这两个按钮长在 Vditor 自己的工具栏里,
// 跟邻居保持一致比跟全局图标库一致更重要。
//
// 不写 width/height: Vditor 自带 `.vditor-toolbar__item svg { width:15px; height:15px }`
// 会强制覆盖, 写了也不生效。svg 加 pointer-events:none 防它拦掉按钮 click (ICONS.md 记过)。
const SVG_ARROW_UP = '<svg style="pointer-events:none"><use xlink:href="#vditor-icon-up"></use></svg>';
const SVG_ARROW_DOWN = '<svg style="pointer-events:none"><use xlink:href="#vditor-icon-down"></use></svg>';

// 颜色/字号按钮的图标: 左边是内容(A / 字), 下面一条当前色的色条, 右边一个小箭头。
// 箭头单独一个 span 是为了 click 时能判断"点的是箭头还是主体"(Word 那种两段式交互)。
// 这些 span 不能 pointer-events:none —— 要靠它们做命中判断。
// 色条必须放在 .qk-glyph **里面** —— 它是 absolute 定位, 要相对 A 那个字来算宽度。
// 放外面当兄弟节点的话, 会相对整个按钮定位, 变得比 A 宽三倍(实测 A 只有 9px, 色条却 28px)。
const ICON_TEXT_COLOR =
  '<span class="qk-styled-btn">' +
  '<span class="qk-glyph">A<span class="qk-swatch" style="background:#e11d48"></span></span>' +
  '<span class="qk-caret">▾</span></span>';
// 字号按钮上直接显示当前数字 (仿 Word 的字号框), 没设过时显示「字」
const ICON_FONT_SIZE =
  '<span class="qk-styled-btn"><span class="qk-glyph qk-glyph-size">字</span>' +
  '<span class="qk-caret">▾</span></span>';

/**
 * 表格/块操作改完 DOM 后调这个, 让编辑器感知变更。
 *
 * 【为什么不派 DOM 的 input 事件】Vditor 在编辑区上绑了 input 监听, 收到就把当前 block
 * 整个重新解析。整行移动这类结构性改动不符合它的假设 —— WYSIWYG 下实测直接把表格
 * 解析成了纯文本段落("| 水果 | 数量 |" 字面量), 整张表就没了。
 *
 * Vditor 自己改表格 DOM 后走的是 execAfterRender, 它**不重新解析 DOM**, 只干两件事:
 * 记撤销栈 + 触发 options.input 回调。这里做等价的事。
 * undo 是内部对象, 加 try 兜底防它以后改结构。
 */
function afterBlockOp() {
  dirty.value = true;
  try {
    const inner = (vditor as unknown as { vditor?: { undo?: { addToUndoStack?: (v: unknown) => void } } })?.vditor;
    inner?.undo?.addToUndoStack?.(inner);
  } catch {}
}

// ── 文字颜色 / 字号 ──
// 仿 Word: 工具栏按钮上有条当前色的色条, 直接点 = 套用当前色; 点右侧小箭头 = 展开面板换色。
// 按钮 icon 是 HTML 字符串, 所以色条用 inline style 画, 换色时直接改那个 DOM 节点。
const stylePicker = reactive({
  open: false,
  kind: 'color' as 'color' | 'size',
  anchor: null as HTMLElement | null,
});
const currentColor = ref('#e11d48');
const currentSize = ref('');

function toolbarBtn(name: string): HTMLElement | null {
  return editorRef.value?.querySelector(`.vditor-toolbar [data-type="${name}"]`) as HTMLElement ?? null;
}

/** 把工具栏颜色按钮上的色条刷成当前色 */
function syncColorSwatch() {
  const bar = toolbarBtn('text-color')?.querySelector('.qk-swatch') as HTMLElement | null;
  if (bar) bar.style.background = currentColor.value;
}

/** 字号按钮上显示当前数字, 没设过就显示「字」 */
function syncSizeGlyph() {
  const g = toolbarBtn('font-size')?.querySelector('.qk-glyph') as HTMLElement | null;
  if (!g) return;
  const n = parseInt(currentSize.value, 10);
  g.textContent = Number.isFinite(n) ? String(n) : '字';
}

// ── 选区跟踪 ──
// 点工具栏按钮 / 面板里的输入框都会让编辑区失焦, 选区当场清空。
// 所以不能等"点了才去取选区", 必须一直记着最后一次有效的选中范围。
// (之前就是等点击时才取, 结果直接点颜色/字号按钮永远提示"先选中文字")
let lastRange: Range | null = null;
function trackEditorSelection() {
  const el = contentEl.value;
  if (!el) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  if (r.collapsed || !el.contains(r.startContainer)) return;   // 只记"真的选中了内容"的
  lastRange = r.cloneRange();
}
function restoreEditorSelection(): boolean {
  const el = contentEl.value;
  if (!lastRange || !el || !lastRange.startContainer.isConnected) return false;
  try {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(lastRange);
    return true;
  } catch { return false; }
}

/** 去掉 Vditor 到处塞的零宽空格再比对, 否则肉眼一样的文字永远相等不了 */
function plainOf(s: string | null): string {
  return (s || '').replace(/[​﻿]/g, '');
}

function applyRange(r: Range): boolean {
  try {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    lastRange = r.cloneRange();
    return true;
  } catch { return false; }
}

/**
 * 在 scope 里找这段文字对应的 Range。`exact` 表示命中的是装饰段(样式已渲染, 边界最准)。
 *
 * 按**文本内容**找, 不能按光标位置找 —— execCommand 插完光标停在插入内容的末尾,
 * 也就是闭标签外面, `closest('[data-mk-deco]')` 根本够不着 (实测: 应用后选中状态直接没了)。
 * 同样的文字可能出现多次, `pick` 决定取第一个还是最后一个 (跨段落重选要一头一尾各取一个)。
 *
 * 找不到装饰段时退回裸文本: 装饰还没补上的那几帧靠它先把选中态顶上, 别留空档。
 */
function rangeForText(
  scope: HTMLElement,
  text: string,
  pick: 'first' | 'last' = 'last',
): { range: Range; exact: boolean } | null {
  const want = plainOf(text);
  if (!want) return null;

  const decos = Array.from(scope.querySelectorAll<HTMLElement>('span[data-mk-deco]'))
    .filter((d) => plainOf(d.textContent) === want);
  const deco = pick === 'first' ? decos[0] : decos[decos.length - 1];
  if (deco) {
    const r = document.createRange();
    r.selectNodeContents(deco);
    return { range: r, exact: true };
  }

  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) texts.push(n as Text);
  if (pick === 'last') texts.reverse();

  for (const t of texts) {
    if (t.parentElement?.closest('.mk-color')) continue;    // 标签源码本身不算内容
    const idx = plainOf(t.data).indexOf(want);
    if (idx < 0) continue;
    // plainOf 剥过零宽空格, 下标要换算回原始 data 上
    const zw = (c: string) => c === '​' || c === '﻿';
    let start = 0;
    for (let seen = 0; start < t.data.length && seen < idx; start++) if (!zw(t.data[start])) seen++;
    while (start < t.data.length && zw(t.data[start])) start++;
    let end = start;
    for (let got = 0; end < t.data.length && got < want.length; end++) if (!zw(t.data[end])) got++;
    const r = document.createRange();
    r.setStart(t, start);
    r.setEnd(t, end);
    return { range: r, exact: false };
  }
  return null;
}

/**
 * 套完样式后把那段文字重新选上 (Word 就是这个行为: 改完还选着, 方便接着调)。
 *
 * 逐帧重试而不是定时等: 装饰就绪的时机很不稳定 —— 实测有时 24ms, 有时 450ms
 * (取决于 Vditor 什么时候把插入的文本解析成标签)。固定 setTimeout 猜时间的话,
 * 猜早了选不中, 猜晚了选中状态白白断档(60ms 的等待实测让人眼看到明显一闪)。
 * 每帧试一次, 一成功立刻停, 断档压到最小。tries 给 40 帧(~650ms), 照上面 450ms 的最坏值留余量。
 *
 * 裸文本那条只做一次(fellBack 记着), 之后每帧只认装饰段 ——
 * 每帧都 removeAllRanges 重设选区的话, 选中态自己会闪。
 */
function reselectStyled(text: string, tries = 40, fellBack = false) {
  decor?.refresh();
  const root = contentEl.value;
  if (!root) return;
  const hit = rangeForText(root, text);
  if (hit?.exact) { applyRange(hit.range); return; }
  const done = fellBack || (!!hit && applyRange(hit.range));
  if (tries <= 0) return;
  requestAnimationFrame(() => reselectStyled(text, tries - 1, done));
}

/**
 * 跨段落套完样式后重选。
 *
 * 不能拿整串文字去找 —— 跨段落的内容分散在不同 `<p>` 的不同文本节点里,
 * 没有任何一个节点装得下, 一路找不到就会重试到预算耗尽然后什么都不做,
 * 用户看到的就是"选中状态直接没了"(蘑菇实测, 跨行选中最容易撞上)。
 * 改成每段各自找, 再拿第一段的头 + 最后一段的尾拼成一个大范围。
 */
function reselectAcross(texts: string[], tries = 40, fellBack = false) {
  decor?.refresh();
  const root = contentEl.value;
  const list = texts.filter((t) => plainOf(t));
  if (!root || !list.length) return;

  const head = rangeForText(root, list[0], 'first');
  const tail = list.length === 1 ? head : rangeForText(root, list[list.length - 1], 'last');
  let done = fellBack;
  if (head && tail) {
    const r = document.createRange();
    r.setStart(head.range.startContainer, head.range.startOffset);
    r.setEnd(tail.range.endContainer, tail.range.endOffset);
    if (head.exact && tail.exact) { applyRange(r); return; }
    if (!done) done = applyRange(r);
  }
  if (tries <= 0) return;
  requestAnimationFrame(() => reselectAcross(texts, tries - 1, done));
}

/** 合并两串 css 声明, 同名属性以新的为准 */
function mergeCss(oldCss: string, newCss: string): string {
  const map = new Map<string, string>();
  for (const part of [...oldCss.split(';'), ...newCss.split(';')]) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && v) map.set(k, v);
  }
  return [...map].map(([k, v]) => `${k}:${v}`).join(';');
}

/** 选中范围是否正好是某一段已有样式(整段, 不是一部分) */
function wrappingDeco(): HTMLElement | null {
  const root = contentEl.value;
  const sel = window.getSelection();
  if (!root || !sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const picked = plainOf(r.toString());
  if (!picked) return null;
  // 两边都剥零宽空格再比 —— Vditor 到处塞零宽空格, 直接比字符串会漏判,
  // 漏判就会落到别的分支去(该合并样式的变成套一层新标签)
  return Array.from(root.querySelectorAll<HTMLElement>('span[data-mk-deco]'))
    .find((d) => plainOf(d.textContent) === picked && d.contains(r.startContainer)) ?? null;
}

/** 选中范围整个落在某一段已有样式**内部**(只选了其中一部分) */
function decoContaining(r: Range): HTMLElement | null {
  const el = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : (r.startContainer as HTMLElement);
  const deco = el?.closest?.('span[data-mk-deco]') as HTMLElement | null;
  return deco && deco.contains(r.endContainer) ? deco : null;
}

/** 选区碰到的所有样式段 */
function decosIntersecting(r: Range): HTMLElement[] {
  const root = contentEl.value;
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('span[data-mk-deco]'))
    .filter((d) => { try { return r.intersectsNode(d); } catch { return false; } });
}

/** 把范围撑到覆盖它碰到的每一对完整标签, 免得只替换掉半个标签留下孤儿 */
function expandOverTags(r: Range): Range {
  const ext = r.cloneRange();
  for (const d of decosIntersecting(r)) {
    const open = d.previousElementSibling?.classList.contains('mk-color') ? d.previousElementSibling : d;
    const close = d.nextElementSibling?.classList.contains('mk-color') ? d.nextElementSibling : d;
    const a = document.createRange();
    a.selectNode(open);
    if (ext.compareBoundaryPoints(Range.START_TO_START, a) > 0) ext.setStartBefore(open);
    const b = document.createRange();
    b.selectNode(close);
    if (ext.compareBoundaryPoints(Range.END_TO_END, b) < 0) ext.setEndAfter(close);
  }
  return ext;
}

/** 选区碰到的所有顶层块 */
function blocksIn(r: Range): HTMLElement[] {
  const root = contentEl.value;
  if (!root) return [];
  return Array.from(root.children).filter((b) => {
    try { return r.intersectsNode(b); } catch { return false; }
  }) as HTMLElement[];
}

/**
 * 选区跨了好几个段落 -> **逐段各套一个标签**。
 *
 * 内联 HTML 标签不能跨段落: 直接套一个大标签的话, 开标签留在第一段、闭标签跑到最后一段,
 * markdown 就成了 `<span ...>段一\n\n\n段二</span>` 这种东西, 配对失效、颜色不显示,
 * 用户以为上色了其实没有 (蘑菇实测撞到)。
 *
 * 所以按段切开, 每段单独处理。从后往前做 —— 改前面的段会让后面段的 Range 失效。
 */
function applyPerBlock(range: Range, blocks: HTMLElement[], style: string) {
  // 先把每段要替换的范围和内容都算出来, 再动手 (边算边改会让后面的范围失效)。
  // 每段内部同样按原有样式分片合并, 保证改字号不冲掉颜色。
  const jobs = blocks.map((b) => {
    const sub = document.createRange();
    sub.selectNodeContents(b);
    if (b.contains(range.startContainer)) sub.setStart(range.startContainer, range.startOffset);
    if (b.contains(range.endContainer)) sub.setEnd(range.endContainer, range.endOffset);
    const ext = expandOverTags(sub);
    const parts = sliceByStyle(ext, sub);
    return {
      ext,
      text: parts.filter((p) => p.selected).map((p) => p.text).join(''),
      out: buildStyled(parts, style),
    };
  }).filter((j) => j.text.trim());

  if (!jobs.length) return;

  // marker 是 contenteditable=false, 不解锁 execCommand 删不动
  for (const d of decosIntersecting(range)) {
    d.previousElementSibling?.removeAttribute('contenteditable');
    d.nextElementSibling?.removeAttribute('contenteditable');
  }

  for (let i = jobs.length - 1; i >= 0; i--) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(jobs[i].ext);
    document.execCommand('insertText', false, jobs[i].out);
  }
  reselectAcross(jobs.map((j) => j.text));   // 内部每帧都会 decor.refresh, 不用再另外排一次
}

interface StylePart { text: string; style: string; selected: boolean }

/** 一个 Range 在某个文本节点上覆盖的区间, 不相交返回 null */
function clipRange(r: Range, node: Text): [number, number] | null {
  let hit = false;
  try { hit = r.intersectsNode(node); } catch { return null; }
  if (!hit) return null;
  const s = node === r.startContainer ? r.startOffset : 0;
  const e = node === r.endContainer ? r.endOffset : node.length;
  return s < e ? [s, e] : null;
}

/**
 * 把范围切成若干片, 每片记住:「原本是什么样式」+「是不是用户真的选中了」。
 *
 * 为什么要区分选中与否: 为了不切坏标签, 处理范围会被撑到覆盖整对标签(expandOverTags),
 * 这就会把**用户没选的部分**也卷进来。如果一视同仁地套新样式, 就会出现
 * "123 里 12 是红的, 只选了 23 改字号, 结果 1 也跟着变大"(蘑菇 2026-08-03 实测)。
 * 撑进来的部分必须原样写回去。
 */
function sliceByStyle(ext: Range, picked: Range): StylePart[] {
  const parts: StylePart[] = [];
  const root = contentEl.value;
  if (!root) return parts;

  const push = (text: string, style: string, selected: boolean) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.style === style && last.selected === selected) last.text += text;
    else parts.push({ text, style, selected });
  };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const clip = clipRange(ext, t);
    if (!clip) continue;
    if (t.parentElement?.closest('.mk-color')) continue;          // 标签源码本身不算内容
    const deco = t.parentElement?.closest('span[data-mk-deco]');
    const base = deco?.getAttribute('data-mk-deco') || '';
    const sel = clipRange(picked, t);
    const raw = t.textContent || '';

    // 按"选中区间"把这个节点在 ext 内的部分切成最多三段
    let i = clip[0];
    while (i < clip[1]) {
      const inSel = !!sel && i >= sel[0] && i < sel[1];
      let end: number;
      if (inSel) end = Math.min(clip[1], sel![1]);
      else if (sel && i < sel[0]) end = Math.min(clip[1], sel[0]);
      else end = clip[1];
      push(raw.slice(i, end).replace(/[​﻿]/g, ''), base, inSel);
      i = end;
    }
  }
  return parts;
}

/** 按分片结果拼出替换用的 markdown: 选中的片合并新样式, 撑进来的片保持原样 */
function buildStyled(parts: StylePart[], style: string): string {
  return parts.map((p) => {
    const s = p.selected ? mergeCss(p.style, style) : p.style;
    return p.text.trim() && s ? wrapWithStyle(p.text, s) : p.text;
  }).join('');
}

/**
 * 选区横跨好几段样式 -> 连标签一起整片重建。
 *
 * 不能简单地套一个大标签: execCommand 会把新标签插在两段标签中间, 配对立刻崩
 * (蘑菇实测到的 `<span 蓝>蓝<span 红><span 红><span 蓝>色大字</span>。` 就是这么来的)。
 *
 * 也不能整片统一成一个新样式 —— 那样"一半红一半没颜色的文字改字号"会把红色冲掉(蘑菇 2026-08-03 指出)。
 * 所以按原有样式分片, **每片各自合并新样式**: 红的那截变成 `color:红;font-size:新`,
 * 没颜色那截只有 `font-size:新`。改字号不动颜色, 改颜色不动字号。
 */
function rebuildAcross(range: Range, decos: HTMLElement[], style: string) {
  const ext = expandOverTags(range);
  const parts = sliceByStyle(ext, range);
  if (!parts.length) return;

  const out = buildStyled(parts, style);
  const plain = parts.filter((p) => p.selected).map((p) => p.text).join('');

  // marker 是 contenteditable=false, 不解锁 execCommand 删不动
  for (const d of decos) {
    d.previousElementSibling?.removeAttribute('contenteditable');
    d.nextElementSibling?.removeAttribute('contenteditable');
  }
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(ext);
  document.execCommand('insertText', false, out);
  reselectStyled(plain);
}

/**
 * 选中了某段样式里的一部分 -> 把原标签**拆开重建**, 而不是往里面套新标签。
 *
 * 往里套是绝对不行的: 内联 HTML 嵌套后 markdown 的标签配对会崩 ——
 * 蘑菇实测过一次"给蓝色大字的后几个字改红、再整段改蓝", 结果套出
 * `<span 蓝>蓝<span 红><span 红><span 红><span 蓝>色大字</span>。` 这种闭合标签都对不上的残骸。
 *
 * 正确结果是拆成最多三段: 选中之前的保持原样式 / 选中的用合并后的样式 / 选中之后的保持原样式。
 */
function splitAndApply(deco: HTMLElement, range: Range, style: string) {
  const full = deco.textContent || '';
  const picked = range.toString();
  const probe = document.createRange();
  probe.selectNodeContents(deco);
  probe.setEnd(range.startContainer, range.startOffset);
  const start = probe.toString().length;

  const oldStyle = deco.getAttribute('data-mk-deco') || '';
  const before = full.slice(0, start);
  const after = full.slice(start + picked.length);

  let out = '';
  if (before) out += wrapWithStyle(before, oldStyle);
  out += wrapWithStyle(picked, mergeCss(oldStyle, style));
  if (after) out += wrapWithStyle(after, oldStyle);

  // 连开闭标签一起选中替换掉。marker 是 contenteditable=false, 不解锁的话 execCommand 删不动它
  const open = deco.previousElementSibling as HTMLElement | null;
  const close = deco.nextElementSibling as HTMLElement | null;
  const hasOpen = !!open?.classList.contains('mk-color');
  const hasClose = !!close?.classList.contains('mk-color');
  if (hasOpen) open!.removeAttribute('contenteditable');
  if (hasClose) close!.removeAttribute('contenteditable');

  try {
    const r = document.createRange();
    r.setStartBefore(hasOpen ? open! : deco);
    r.setEndAfter(hasClose ? close! : deco);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    document.execCommand('insertText', false, out);
  } catch {
    if (hasOpen) open!.setAttribute('contenteditable', 'false');
    if (hasClose) close!.setAttribute('contenteditable', 'false');
    return;
  }
  reselectStyled(picked);
}

/**
 * 给选中文字套样式。
 *
 * 分两种情况:
 *  - 选中的正好是一段**已经有样式**的文字 -> 把新样式合并进那个标签
 *    (先设红色再设 28px 应该得到 `color:red;font-size:28px` 一个标签)。
 *    不能再套一层 —— 实测会让内层标签文本被当成普通内容, 显示成一串字面的 `<span style=...>`
 *  - 普通文字 -> execCommand 插入带标签的纯文本, Vditor 自己解析成内联 HTML 并进撤销栈
 */
function applyTextStyle(style: string) {
  if (!vditor) return;
  if (!restoreEditorSelection()) { toast.show('先选中一段文字', 'default'); return; }
  contentEl.value?.focus();

  // 情况零: 选区跨了多个段落 -> 逐段各套一个标签 (内联标签不能跨段)
  const sel0 = window.getSelection();
  const r0 = sel0 && sel0.rangeCount ? sel0.getRangeAt(0) : null;
  if (r0) {
    const blocks = blocksIn(r0);
    if (blocks.length > 1) { applyPerBlock(r0, blocks, style); return; }
  }

  // 情况一: 选中的正好是一整段已有样式 -> 直接改那个标签的 style
  const deco = wrappingDeco();
  if (deco) {
    const open = deco.previousElementSibling as HTMLElement | null;
    const txt = (open?.textContent || '').replace(/[​﻿]/g, '').trim();
    const m = /^<span\s+style="([^"]*)"\s*>$/i.exec(txt);
    if (open?.classList.contains('mk-color') && m) {
      const kept = deco.textContent || '';
      open.textContent = `<span style="${mergeCss(m[1], style)}">`;
      afterBlockOp();
      reselectStyled(kept);
      return;
    }
  }

  const sel = window.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;

  // 情况二: 选中的是某段样式里的一部分 -> 拆开重建, 绝不能往里套新标签
  const inner = range ? decoContaining(range) : null;
  if (inner && range) { splitAndApply(inner, range, style); return; }

  // 情况三: 选区跨了好几段样式 -> 连标签一起整片重建成一个新标签
  const touched = range ? decosIntersecting(range) : [];
  if (range && touched.length) { rebuildAcross(range, touched, style); return; }

  // 情况四: 普通文字 -> 插入带标签的纯文本, Vditor 自己解析成内联 HTML
  const text = vditor.getSelection();
  if (!text) { toast.show('先选中一段文字', 'default'); return; }
  document.execCommand('insertText', false, wrapWithStyle(text, style));
  reselectStyled(text);
}

function onStyleBtnClick(kind: 'color' | 'size', e: Event) {
  const btn = (e.target as HTMLElement)?.closest('button') as HTMLElement | null;
  const hitCaret = !!(e.target as HTMLElement)?.closest?.('.qk-caret');
  // 点箭头 -> 展开面板; 点主体 -> 直接套当前值 (字号没设过时也展开, 免得点了没反应)
  if (hitCaret || (kind === 'size' && !currentSize.value)) {
    stylePicker.kind = kind;
    stylePicker.anchor = btn;
    stylePicker.open = true;
    return;
  }
  applyTextStyle(kind === 'color' ? `color:${currentColor.value}` : `font-size:${currentSize.value}`);
}

function onStylePick(value: string) {
  if (stylePicker.kind === 'color') {
    currentColor.value = value;
    syncColorSwatch();
    applyTextStyle(`color:${value}`);
  } else {
    currentSize.value = value;
    syncSizeGlyph();
    applyTextStyle(`font-size:${value}`);
  }
  stylePicker.open = false;
}

/**
 * 清除选中范围内的内联样式。
 *
 * 不能走 "getSelection() 拿文本 -> 剥标签 -> 插回去" —— getSelection() 返回的是**纯文本**,
 * 本来就不含标签, 剥了等于没剥; 而且插入位置还在标签内部, 样式照旧(实测踩过)。
 * 只能直接删 DOM: 把装饰 span 拆掉 + 删掉它前后那对标签节点。
 */
function onStyleClear() {
  stylePicker.open = false;
  const root = contentEl.value;
  if (!root || !restoreEditorSelection()) { toast.show('先选中一段文字', 'default'); return; }
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) { toast.show('先选中一段文字', 'default'); return; }
  const range = sel.getRangeAt(0);

  const decos = Array.from(root.querySelectorAll<HTMLElement>('span[data-mk-deco]'))
    .filter((d) => range.intersectsNode(d));
  if (!decos.length) { toast.show('选中的文字没有设置样式', 'default'); return; }

  for (const d of decos) {
    // 前后紧挨着的就是那对标签(已被装饰层标成 .mk-color)
    const prev = d.previousElementSibling;
    const next = d.nextElementSibling;
    if (prev?.classList.contains('mk-color')) prev.remove();
    if (next?.classList.contains('mk-color')) next.remove();
    const par = d.parentNode!;
    while (d.firstChild) par.insertBefore(d.firstChild, d);
    par.removeChild(d);
    par.normalize();
  }
  afterBlockOp();
  setTimeout(() => decor?.refresh(), 60);
}

// 移动光标所在的整块 (段落 / 表格 / 列表 / 引用) 跟相邻块换位置
function moveCurrentBlock(dir: 'up' | 'down') {
  const root = contentEl.value;
  if (!root) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const node = sel.getRangeAt(0).startContainer;
  if (!root.contains(node)) return;
  const block = findBlock(node, root);
  if (!block) return;
  const moved = dir === 'up' ? moveBlockUp(block) : moveBlockDown(block);
  if (!moved) return;
  // 光标跟着块走, 这样能连着点第二次继续移动同一块
  const idx = Array.prototype.indexOf.call(root.children, block);
  commitEditor(root);
  afterBlockOp();
  nextTick(() => {
    const target = (idx >= 0 ? root.children[idx] : null) as HTMLElement | null;
    if (target) focusCell(target, true);
  });
}

onMounted(() => {
  if (!editorRef.value) return;

  vditor = new Vditor(editorRef.value, {
    // 编辑器内部用 absolute path,让 Vditor IR 模式渲染 <img>/<a href> 能加载;保存时(handleSubmit)再剥回裸名入 DB
    value: resolveMarkdownFileUrls(props.initialContent),
    placeholder: props.placeholder,
    minHeight: props.minHeight,
    width: '100%',
    // 编辑模式: WYSIWYG (蘑菇 2026-08-03 拍板, 从 IR 换过来 —— "适合萌新用")。
    // 跟 IR 的唯一区别: 光标进到加粗/标题/引用里时**不会露出 markdown 语法符号**,
    // 始终是渲染后的样子。IR 是光标靠近就显示 ** / # 让你能手改。
    // 代码里凡是选 .vditor-ir 的地方都同时写了 .vditor-wysiwyg, 想换回来把这行改成 'ir' 即可。
    mode: 'wysiwyg',
    // Vditor 3.11.2 bug: highlightToolbarWYSIWYG.ts:1152 无条件调 options.customWysiwygToolbar,
    // 但 Options.ts 没给默认值 -> undefined is not a function -> WYSIWYG 的整个 popover 系统全瘫
    // (表格面板/链接/图片/标题/引用全弹不出来)。必须自己传个空函数兜底。
    customWysiwygToolbar: () => {},
    cdn: '/vditor',
    toolbar: [
      'emoji', 'headings', 'bold', 'italic', 'strike', 'link', '|',
      'list', 'ordered-list', 'check', 'quote', '|',
      'code', 'inline-code', 'table', 'line', '|',
      { name: 'text-color', tip: '文字颜色 (点箭头换色)', icon: ICON_TEXT_COLOR, click: (e: Event) => onStyleBtnClick('color', e) },
      { name: 'font-size', tip: '字号 (点箭头选)', icon: ICON_FONT_SIZE, click: (e: Event) => onStyleBtnClick('size', e) },
      '|',
      { name: 'move-block-up', tip: '本段上移', icon: SVG_ARROW_UP, click: () => moveCurrentBlock('up') },
      { name: 'move-block-down', tip: '本段下移', icon: SVG_ARROW_DOWN, click: () => moveCurrentBlock('down') },
      '|',
      'upload', 'undo', 'redo',
    ],
    toolbarConfig: { pin: false },
    counter: { enable: false },
    preview: { actions: [] },
    cache: { enable: false },
    // emoji 面板扩到 48 个 (Vditor 默认 8). emojiTail 为空 → 底部 tip 条渲染空, 我们 CSS 直接隐藏它;
    // hover 的英文名 tip 走底部 tail Vditor 内置逻辑, 我们改用 customTooltip 顶部浮层显示中文名
    hint: { emoji: EMOJI_MAP },
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
      // CDP 实测: 用 TreeWalker 找最后一个 text node 锚定 selection (避开 PRE element boundary
      // 导致 Chromium 渲染光标到开头视觉位置的 bug). after() 在 Vditor IR 渲染完成后立即调 → 不用 setTimeout
      // 让用户首帧就看到光标在末尾 (避免"光标飘一下才到末尾"). RAF + 100ms 双保险防 Vditor 后续 mutation reset.
      // 注: focusEnd 时不调 vditor.focus(), 因为 vditor.focus() 内部把光标重置到默认位置, 会跟我们设的末尾冲突.
      if (props.focusEnd) {
        const setCursorToEnd = () => {
          const contentEl = editorRef.value?.querySelector('.vditor-ir .vditor-reset, .vditor-wysiwyg .vditor-reset') as HTMLElement | null;
          if (!contentEl) return;
          contentEl.focus();
          // CDP 实测 ("光标在末尾位置一个字后面" bug): Vditor IR 渲染后 PRE 末尾有一个空 text node
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
      // Vditor 建完 DOM 才能拿到内容区, 交给 EditorBlockTools 做表格/段落悬浮操作
      contentEl.value = editorRef.value?.querySelector('.vditor-ir .vditor-reset, .vditor-wysiwyg .vditor-reset') as HTMLElement ?? null;
      // 内联样式装饰层: 把 <span style="color:x"> 这种标签在编辑器里渲染成真的颜色/字号
      if (contentEl.value) decor = createInlineStyleDecor(contentEl.value);
      // 一直记着编辑区里最后一次选中范围, 供颜色/字号按钮用 (点按钮时选区已经没了)
      document.addEventListener('selectionchange', trackEditorSelection);
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
      // capture 拦截: 列表项内粘贴多行纯文本 → 每行拆成独立列表项 (抢在 onEditorPaste / Vditor 前)
      editorRef.value?.addEventListener('paste', onListPaste, true);
      // capture 拦截 base64 富文本粘贴, 上传换 url 不让 base64 进编辑器 (微信油猴转图等多图场景会卡死)
      editorRef.value?.addEventListener('paste', onEditorPaste, true);
      // capture 拦截: 粘贴多行纯文本时把单换行规范成段落分隔, 跟按回车的结构对齐。
      // 注册在最后 —— 前面两个(列表拆项 / base64 图)命中时会 stopImmediatePropagation, 轮不到这里
      editorRef.value?.addEventListener('paste', onMultilinePaste, true);
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
  editorRef.value?.removeEventListener('copy', onEditorCopy, true);
  editorRef.value?.removeEventListener('paste', onListPaste, true);
  editorRef.value?.removeEventListener('paste', onEditorPaste, true);
  editorRef.value?.removeEventListener('paste', onMultilinePaste, true);
  // 录音资源清理: 用户点了录音后不停 → 关 modal / 切页时若不清, 麦克风 stream + WebSocket + AudioContext + Timer 全部常驻.
  // 两个 cleanup 内部都做了 null check, 幂等安全, 无需外层 isRecording 判断.
  cleanupRecording();
  cleanupVoiceRecord();
  document.removeEventListener('selectionchange', trackEditorSelection);
  decor?.destroy();
  decor = null;
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

  // 群组待办类型: 仅 type=todo + shared 才带. everyone 才带截止 (本地 datetime → ISO) + 可见性.
  const isTodoShared = noteType.value === 'todo' && visibilityModel.value.visibility === 'shared';
  const isEveryone = isTodoShared && todoModeModel.value.todoGroupMode === 'everyone';
  emit('submit', {
    html: md, type: noteType.value, tags: [...tags.value],
    visibility: visibilityModel.value.visibility, sharedGroupIds: [...visibilityModel.value.sharedGroupIds],
    category: categoryModel.value,
    todoGroupMode: isTodoShared ? todoModeModel.value.todoGroupMode : undefined,
    rosterDueAt: isEveryone && todoModeModel.value.rosterDueAt ? new Date(todoModeModel.value.rosterDueAt).toISOString() : undefined,
    rosterVisibility: isEveryone ? todoModeModel.value.rosterVisibility : undefined,
  });
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
  // 发布后 visibility / sharedGroupIds 也重置回初始 (默认 private + 空群), 跟新编辑器一致
  // 防止用户连续发同一类型笔记时, 上次选的群残留到下一条 (用户得手动取消才能改私人)
  visibilityModel.value = {
    visibility: props.initialVisibility,
    sharedGroupIds: [...props.initialSharedGroupIds],
  };
  // 分类同理: 发布后回到 initialCategory (默认 null = 自动), 防上次手选的分类残留到下一条 → 永远卡住 AI 不能自动
  categoryModel.value = props.initialCategory;
  todoModeModel.value = { todoGroupMode: 'group', rosterDueAt: null, rosterVisibility: 'count' };
  dirty.value = false;
}

// ── Tags ──
function addTag() {
  const t = tagInput.value.trim();
  if (!t) return;
  // 已存在: 提示 + 不关弹窗让用户改输入 (蘑菇 2026-07-06)
  if (tags.value.includes(t)) { toast.show(`标签 #${t} 已存在`, 'default'); tagInput.value = ''; return; }
  tags.value.push(t);
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
  scrollAiPanelIntoView();
}

// AI process 走 SSE 流式: delta 到就追加 aiResult (Vue reactive 自动打字机效果),
// 无 total timeout, 用 stall timeout (60s 无新 chunk 就 abort) 兜底 —— 只要 ollama 还在出字, 就一直等.
// 首 chunk 前也计入 stall (ollama 冷启动可能 3-5s, 60s 足够宽裕)
const STALL_TIMEOUT_MS = 60_000;
const stopBtnHover = ref(false); // 处理中按钮 hover 时切换成红色 "停止", 点击 abort
const aiPanelEl = ref<HTMLElement | null>(null);
let currentAiAbort: AbortController | null = null;

// 展开/触发 AI 面板后自动滚到底部, 让 aiPanel + 输出 textarea 立即可见, 不用手动滚
async function scrollAiPanelIntoView() {
  await nextTick();
  aiPanelEl.value?.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

async function runAi() {
  if (!vditor || aiProcessing.value) return;
  aiProcessing.value = true;
  // 关键: 清 hover 状态防止鼠标已在按钮上时立即显示"停止". mouseenter 不会重复触发 (鼠标不动),
  // 用户必须移开再进来才能触发 mouseenter → 显示"停止". 结果: 按钮先显示"处理中", 有意图 stop 才 hover 变红.
  stopBtnHover.value = false;
  aiError.value = '';
  aiResult.value = '';
  scrollAiPanelIntoView();

  const selection = vditor.getSelection();
  const content = selection || vditor.getValue();

  const abortCtrl = new AbortController();
  currentAiAbort = abortCtrl;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let stallFired = false;
  let firstDelta = true;
  const resetStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => { stallFired = true; abortCtrl.abort(); }, STALL_TIMEOUT_MS);
  };
  resetStall();

  try {
    await api.aiProcess(aiFeature.value, content, aiPromptText.value, undefined, (delta) => {
      aiResult.value += delta;
      resetStall();
      // 首 delta 到时结果预览框 (v-if=aiResult) 首次渲染, 再滚一次让预览框出现在视口内
      if (firstDelta) { firstDelta = false; scrollAiPanelIntoView(); }
    }, abortCtrl.signal);
  } catch (err: any) {
    // AbortError: 分 stall 触发 vs 用户主动停止. 用户停止不显示 error (保留 aiResult 让 UI 切"应用/重新生成")
    if (err.name === 'AbortError' || (err.message || '').toLowerCase().includes('abort')) {
      if (stallFired) aiError.value = `${STALL_TIMEOUT_MS / 1000} 秒无新输出, 已中断. 可点"重新生成"再试`;
    } else {
      aiError.value = err.message || 'AI 处理失败';
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    aiProcessing.value = false;
    currentAiAbort = null;
    stopBtnHover.value = false;
  }
}

function stopAi() {
  currentAiAbort?.abort();
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

// stopMedia: 供父组件在关闭动画开始时立刻停麦克风 (onBeforeUnmount 要等 Transition leave + vditor destroy 完才 fire, 麦克风红点延迟几秒消失)
function stopMedia() {
  if (isRecording.value) cleanupRecording();
  if (isVoiceRecording.value) cleanupVoiceRecord();
}
defineExpose({ clearContent, isDirty: computed(() => dirty.value), stopMedia });
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

    <!-- 表格浮动面板 + 右键菜单。等 contentEl 就绪才挂 -->
    <EditorBlockTools v-if="contentEl" :editor-el="contentEl" :after-op="afterBlockOp" />

    <!-- 文字颜色 / 字号面板, 由工具栏按钮的小箭头唤起 -->
    <EditorTextStylePicker :open="stylePicker.open" :anchor="stylePicker.anchor" :kind="stylePicker.kind"
      :current="stylePicker.kind === 'color' ? currentColor : currentSize"
      @pick="onStylePick" @clear="onStyleClear" @close="stylePicker.open = false" />

    <!-- AI buttons + bottom bar (录音时 absolute overlay 浮层覆盖此行,不占额外高度) -->
    <div class="relative">
    <div class="flex items-center justify-between gap-2 px-3 py-2 bg-gray-50 border-t border-gray-100 select-none">
      <div class="flex items-center gap-2 flex-wrap min-w-0">
        <!-- Type selector. lockType=true 时 button disable, 视觉灰显, 点击不响应 (非作者编辑共享笔记) -->
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

        <!-- Tags. hideTags=true 时入口隐藏 (非作者编辑共享笔记不能改 tag) -->
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

      <!-- Submit + fullscreen + category chip + visibility chip (群组共享) -->
      <div class="flex items-center gap-1.5 shrink-0">
        <span v-if="hintText" class="text-[11px] text-gray-400 mr-1">{{ hintText }}</span>
        <CategoryPicker v-if="showCategoryPicker" v-model="categoryModel" compact />
        <VisibilityChip v-if="showVisibilityChip" v-model="visibilityModel" compact />
        <TodoModeChip v-if="showVisibilityChip && noteType === 'todo' && visibilityModel.visibility === 'shared'"
          v-model="todoModeModel" :shared-group-ids="visibilityModel.sharedGroupIds" compact />
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

    <!-- AI Panel: 自然撑开, modal Body 承担 scroll. ref 供 openAiPanel/runAi 触发时自动 scrollIntoView -->
    <div v-if="showAi && showAiPanel" ref="aiPanelEl" class="border-t border-gray-100 bg-gray-50/80">
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
        <!-- v-if 带 aiProcessing: 重新生成时 aiResult 清空但仍保留 textarea 挂载, 避免"消失→再出现"闪烁 -->
        <div v-if="aiResult || aiProcessing" class="mb-2">
          <div class="text-[10px] text-gray-400 mb-1">AI 结果预览 (可编辑)：</div>
          <!-- pre 改 textarea: (1) 流式追加时用户可以手动改, apply 前修改; (2) 支持 v-model 让 aiResult 变化 → DOM 同步.
               ref + watch(aiResult) 让 scrollTop = scrollHeight 实现流式打字机自动跟随末尾, 不用用户手滚 -->
          <textarea ref="aiResultEl" v-model="aiResult" spellcheck="false"
            class="w-full min-h-[100px] max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-700 whitespace-pre-wrap font-mono resize-none outline-none focus:border-primary" />
        </div>
        <div class="flex gap-2">
          <!-- 处理中: 单按钮 (accent 色"处理中"), hover 时变红色"停止" 点击 abort;
               非处理中: 单按钮 accent "开始". 应用按钮流式期间不显示 (未生成完不能 apply) -->
          <button v-if="aiProcessing || !aiResult"
            @click="aiProcessing ? stopAi() : runAi()"
            @mouseenter="stopBtnHover = true" @mouseleave="stopBtnHover = false"
            class="px-4 py-1.5 min-w-[4.5rem] text-center text-white text-xs font-medium rounded-lg transition-colors"
            :class="aiProcessing && !stopBtnHover ? 'ai-btn-breathing' : ''"
            :style="{ background: aiProcessing && stopBtnHover ? '#f87171' : 'rgb(var(--c-accent))' }">
            {{ !aiProcessing ? '开始' : (stopBtnHover ? '停止' : '处理中') }}
          </button>
          <template v-else>
            <button @click="applyAiResult" class="px-4 py-1.5 min-w-[4.5rem] text-center text-white text-xs font-medium rounded-lg transition-colors" style="background: rgb(var(--c-accent))">应用</button>
            <button @click="runAi" class="px-4 py-1.5 min-w-[4.5rem] text-center text-xs text-gray-700 font-medium rounded-lg bg-gray-200 hover:bg-gray-300 transition-colors">重新生成</button>
          </template>
        </div>
      </div>
    </div>

    <!-- Tags display: hideTags=true 时整行隐藏 (非作者不能改 tag, 显示也无意义).
         桌面 hover 时右侧 slide in 叉号 (蘑菇 2026-07-06: 编辑器 tag 少不推挤, slide 视觉更好),
         移动端叉号常驻. -->
    <div v-if="tags.length && !hideTags" class="flex flex-wrap gap-1 px-4 py-2 border-t border-gray-50">
      <span v-for="tag in tags" :key="tag"
        class="group/tag inline-flex items-center text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full transition-all overflow-hidden">
        <span>#{{ tag }}</span>
        <!-- 桌面 slide-in -->
        <span
          class="hidden md:inline-flex max-w-0 md:group-hover/tag:max-w-[24px] transition-all overflow-hidden whitespace-nowrap">
          <span class="ml-1 inline-flex items-center">
            <button @click="removeTag(tag)" class="text-gray-500 hover:text-red-500" title="删除标签">
              <PhX size="0.75rem" weight="bold" />
            </button>
          </span>
        </span>
        <!-- 移动端常驻叉号 -->
        <button @click="removeTag(tag)" class="md:hidden ml-1 text-gray-400 hover:text-red-500" title="删除标签">
          <PhX size="0.625rem" weight="bold" />
        </button>
      </span>
    </div>
  </div>

  <!-- Popups: Teleport 到 body,不受 modal overflow-hidden 裁剪 -->
  <Teleport to="body">
    <div v-if="showTagInput || showRefSearch" class="fixed inset-0" style="z-index: var(--z-overlay-backdrop)" @click="closePopups" />
    <!-- Tag popup -->
    <div v-if="showTagInput" class="bg-white border border-gray-200 rounded-lg shadow-lg p-2 flex items-center gap-2 whitespace-nowrap"
      :style="getPopupPos(tagBtnEl, 220)">
      <input ref="tagInputRef" v-model="tagInput" @keydown.enter="addTag" @click.stop placeholder="输入标签回车添加" class="popup-input w-40" />
      <button @click.stop="addTag" class="popup-btn shrink-0">添加</button>
    </div>
    <!-- Reference popup: flex flex-col 让搜索结果列表 flex-1 + 输入框 shrink-0 竖排.
         之前依赖 getPopupPos 返回的 flexDirection column, 但那影响 tag popup 让按钮竖排 (蘑菇 2026-07-06 修), 拆到 class 里 -->
    <div v-if="showRefSearch" class="bg-white border border-gray-200 rounded-lg shadow-lg p-2 w-64 flex flex-col"
      :style="getPopupPos(refBtnEl, 256)">
      <div v-if="refResults.length" class="flex-1 min-h-0 overflow-y-auto space-y-1 mb-1">
        <button v-for="r in refResults" :key="r.id" @click.stop="insertRef(r)" class="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50 text-xs text-gray-600 truncate">
          {{ r.content.replace(/[#*`\[\]<>]/g, '').split('\n')[0]?.slice(0, 40) }}
        </button>
      </div>
      <div v-else-if="refQuery.trim()" class="text-xs text-gray-400 py-2 text-center mb-1">无结果</div>
      <input ref="refInputRef" v-model="refQuery" @input="searchRefs" @click.stop placeholder="搜索笔记..." class="popup-input w-full shrink-0" />
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
/* AI "处理中" 按钮呼吸: 只在非 hover 时应用, hover 时是红色停止不呼吸 */
@keyframes ai-btn-breath { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.ai-btn-breathing { animation: ai-btn-breath 1.6s ease-in-out infinite; }
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
  /* 关键: 给 .vditor-toolbar__item 显式 z-index 让它成为 stacking context.
     否则里面 .vditor-hint / .vditor-panel (position:absolute + z:999) 溢出 wrapper 时,
     虽然 z 数值很大, 但没被 stacking context 隔离, 会被 main 后续 static 子节点按 DOM 顺序遮住
     (最典型: headings 下拉六级标题被卡片流覆盖). z:1 局部叠加, 不进全局 scale (见 Z-INDEX-SCALE.md quirks 段). */
  z-index: 1;
}
/* upload 项是 <div>(Vditor 源码硬编码 s = name==="upload" ? "div" : "button"),其他工具项才是 button。
   所有针对 button 的样式都要把 [data-type="upload"] 接上,否则尺寸 / 颜色 / hover 灰底全失效。 */
/* 所有工具栏项 (button + upload div) 统一 inline-flex 居中,
   保证 hover 灰底位置一致 + svg 在灰底中央。
   button 默认 inline-block + svg baseline 排版会让位置略偏,统一 flex 后所有图标视觉对齐。
   transform translateY(3px) 让整行按钮 (连带 hover 灰底) 视觉下移,
   抵消 flex 居中相对 baseline 位置整体偏高的差值。transform 不影响 toolbar 实际高度。
   注: 用直接子 `>` 只选工具栏第一层 button/span (图标本身); Vditor 把 headings/emoji 下拉面板
   (.vditor-hint / .vditor-panel) 也塞在 .vditor-toolbar__item 里, 面板内 button 是孙子层.
   不加 `>` 会把下拉里的文字 button 也压成 28×28 方块导致标题下拉一行 2 项文字被裁 (蘑菇 2026-07-06 修). */
.vditor-wrapper .vditor-toolbar__item > button,
.vditor-wrapper .vditor-toolbar__item > span,
.vditor-wrapper .vditor-toolbar__item > [data-type="upload"] {
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
.vditor-wrapper .vditor-toolbar__item > button svg,
.vditor-wrapper .vditor-toolbar__item > [data-type="upload"] svg {
  height: 14px !important;
  width: 14px !important;
}
.vditor-wrapper .vditor-toolbar__item > button:hover,
.vditor-wrapper .vditor-toolbar__item > [data-type="upload"]:hover {
  color: #1e293b;
  background: #f1f5f9;
  border-radius: 6px;
}
.vditor-wrapper .vditor-toolbar__item--current > button {
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
.vditor-ir .vditor-reset > h1:before, .vditor-wysiwyg .vditor-reset > h1:before,
.vditor-ir .vditor-reset > h2:before, .vditor-wysiwyg .vditor-reset > h2:before,
.vditor-ir .vditor-reset > h3:before, .vditor-wysiwyg .vditor-reset > h3:before,
.vditor-ir .vditor-reset > h4:before, .vditor-wysiwyg .vditor-reset > h4:before,
.vditor-ir .vditor-reset > h5:before, .vditor-wysiwyg .vditor-reset > h5:before,
.vditor-ir .vditor-reset > h6:before, .vditor-wysiwyg .vditor-reset > h6:before {
  display: none !important;
}
/* 去掉 Vditor 内置的居中和多余间距，让内容区撑满 */
.vditor-wrapper .vditor-reset,
.vditor .vditor-reset,
.vditor-ir .vditor-reset,
.vditor-ir pre.vditor-reset,
.vditor-wysiwyg .vditor-reset {
  max-width: none !important;
  margin: 0 !important;
  padding: 8px 16px !important;
  width: 100% !important;
  box-sizing: border-box !important;
}
/* placeholder 也从头开始 */
.vditor-ir pre.vditor-reset:empty::before,
.vditor-wysiwyg .vditor-reset:empty::before,
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
/* emoji 面板底部 tail 条 (Vditor 用来显 hover 的英文 data-key + emojiTail 说明) 隐藏,
   我们改用 customTooltip 顶部浮层显示中文名 (见 script 里 EMOJI_ZH + onToolbarMouseOver) */
.vditor-wrapper .vditor-emojis__tail {
  display: none !important;
}
/* Vditor 默认 emoji 面板 auto 宽度 (~80px) + inline-block 按钮 → 只能一行 2 个, 49 个 emoji 面板超高.
   改成 grid 布局, 高度封顶 + 溢出滚动 (显 3 行 / ~24 个, 剩余滚动).
   列宽用 auto-fill + 固定 32px (不用 repeat(8, 1fr) 均分): zoom 放大时 1fr 均分会因 subpixel
   计算把第 8 列挤到可见区外, 视觉上变成一行 7 个 (蘑菇 2026-07-06 反馈).
   scrollbar-gutter:stable 预留滚动条空间, 出滚动条前后布局不跳; 面板 width:280 稳定容 8 列 (32*8+gap≈272). */
.vditor-wrapper .vditor-emojis {
  display: grid !important;
  grid-template-columns: repeat(auto-fill, 32px);
  justify-content: start;
  gap: 2px;
  /* 300px 是为了给 scrollbar-gutter:stable 预留的 15px 滚动条空间留富余 (300 - 15 = 285 可用,
     8 列 32px + 7 gap 2px = 270, 富余 15px). 之前 280 时 zoom 150% 场景挤到 7 个 (蘑菇 2026-07-06 反馈). */
  width: 300px;
  max-height: 240px !important;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.vditor-wrapper .vditor-emojis button {
  width: 32px !important;
  padding: 4px !important;
}
/* Dark mode */
/* 工具栏上的「文字颜色」「字号」按钮: 内容 + 当前色条 + 展开箭头。
   Vditor 会强制 .vditor-toolbar__item svg{width:15px}, 但我们这两个不是 svg 是 span, 不受影响。
   注意别给这些 span 加 pointer-events:none —— click 时要靠 e.target 判断点的是箭头还是主体。 */
.vditor-wrapper .qk-styled-btn {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  line-height: 1;
}
/* 「A」和「字/数字」用同一套字号行高, 两个按钮看起来才是一对
   (蘑菇 2026-08-03: A 的高度和字一样, 大小也一样)。
   padding-bottom 是给色条留的位置, 两个都留同样多, 否则基线会错开一两像素。 */
.vditor-wrapper .qk-glyph {
  position: relative;
  display: inline-block;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  padding-bottom: 4px;
}
/* 字号按钮显示当前数字(两位数), 给个最小宽度免得数字一变按钮就跳 */
.vditor-wrapper .qk-glyph-size {
  min-width: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
/* 色条紧贴 A 下沿。左右各外扩 2px 比"正好等于 A 的宽度"看着舒服些
   (蘑菇 2026-08-03: 稍微宽一点点) */
.vditor-wrapper .qk-swatch {
  position: absolute;
  left: -2px;
  right: -2px;
  bottom: 0;
  height: 3px;
  border-radius: 1px;
  pointer-events: none;   /* 色条只是装饰, 命中判断交给 .qk-glyph */
}
.vditor-wrapper .qk-caret {
  font-size: 8px;
  opacity: .6;
  padding: 0 1px;
}
.vditor-wrapper .qk-caret:hover { opacity: 1; }

/* ── 内联样式(颜色/字号)的标签完全隐藏 ──
   markdown 里存的是 <span style="color:红">文字</span>, 那两个标签在编辑器里必须占个 DOM 节点,
   这里把它们彻底藏掉, 看起来就跟 Word 一样只有彩色文字本身 (蘑菇 2026-08-03 定)。
   配套的装饰逻辑在 utils/inlineStyleDecor.ts。

   注意别用 display:none —— 那样光标跨过这段时浏览器的定位会出问题(节点没有几何盒子)。
   用「宽度 0 + overflow:hidden + inline-block」既不占视觉空间, 又保留一个可定位的盒子。

   **高度不能一起压成 0**(以前写的 height:0 / font-size:0 / line-height:0 已删):
   光标停在这个盒子旁边时, 浏览器按这个盒子的行高画光标。压成 0 的话, 大字号那行的光标
   会又短又贴着行顶 (蘑菇实测: "有大号字, 点到字前面时光标出现在字左上角")。
   现在高度跟着字号走, 字号由 inlineStyleDecor 的 syncMarkerSize 同步成跟彩色文字一样大。

   user-select:none + contenteditable=false(JS 那边加) 让光标进不去这串隐藏文字, 否则按左右
   方向键会一路走进去 —— 用户完全看不出来(看着光标就在彩色字前面, 实际在标签中间几十个字符里)。

   去掉边界标记的代价: 在彩色字最边上打字时, 看不出新字会不会继承颜色。
   所有富文本编辑器都有这个问题, 蘑菇已知晓。要去掉颜色就选中文字点「清除样式」。 */
.vditor-wrapper .mk-color {
  display: inline-block;
  width: 0;
  overflow: hidden;
  /* 这三行缺一不可, 而且必须 !important 压过 Vditor 给 code 设的 pre-wrap / break-all:
     宽度被压成 0 后, 标签源码会**逐字竖着堆**, 一个 <span style="font-size:32px">
     能堆出 1392px 高把整个编辑区顶下去 (实测)。强制一行才不撑高。 */
  white-space: nowrap !important;
  word-break: keep-all !important;
  overflow-wrap: normal !important;
  vertical-align: baseline;
  letter-spacing: 0 !important;
  padding: 0 !important;
  margin: 0 !important;
  background: transparent !important;
  border: none !important;
  user-select: none;
  -webkit-user-select: none;
}

/* WYSIWYG 模式下 Vditor 自带一个 popover(点块时浮现, 带插行插列/对齐/表格尺寸输入框),
   跟我们自己的 EditorBlockTools 面板会重叠打架, 所以藏掉, 只留我们那套
   (我们那套多了行上下移, 而且图标跟项目统一)。
   注意真实 class 是 .vditor-panel--none, 不是看名字猜的 .vditor-wysiwyg__popover。 */
.vditor-wrapper .vditor-panel--none { display: none !important; }

[data-theme="dark"] .vditor-wrapper .vditor-toolbar { border-bottom-color: rgba(255,255,255,0.06) !important; }
[data-theme="dark"] .vditor-wrapper .vditor-toolbar__item > button,
[data-theme="dark"] .vditor-wrapper .vditor-toolbar__item > span { color: #94a3b8; }
[data-theme="dark"] .vditor-wrapper .vditor-toolbar__item > button:hover { color: #e2e8f0; background: rgba(255,255,255,0.08); }
[data-theme="dark"] .vditor-wrapper .vditor-reset { color: #e2e8f0; }
[data-theme="dark"] .vditor-wrapper .vditor-reset::before { color: rgba(255,255,255,0.25) !important; }
</style>
