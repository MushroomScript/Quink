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
import { useToast } from '@/composables/useToast';
import RenameModal from './RenameModal.vue';
import VisibilityChip from './VisibilityChip.vue';
import CategoryPicker from './CategoryPicker.vue';
import TodoModeChip from './TodoModeChip.vue';
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
let vditor: Vditor | null = null;
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
          const contentEl = editorRef.value?.querySelector('.vditor-ir .vditor-reset') as HTMLElement | null;
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
  editorRef.value?.removeEventListener('paste', onListPaste, true);
  editorRef.value?.removeEventListener('paste', onEditorPaste, true);
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
[data-theme="dark"] .vditor-wrapper .vditor-toolbar { border-bottom-color: rgba(255,255,255,0.06) !important; }
[data-theme="dark"] .vditor-wrapper .vditor-toolbar__item > button,
[data-theme="dark"] .vditor-wrapper .vditor-toolbar__item > span { color: #94a3b8; }
[data-theme="dark"] .vditor-wrapper .vditor-toolbar__item > button:hover { color: #e2e8f0; background: rgba(255,255,255,0.08); }
[data-theme="dark"] .vditor-wrapper .vditor-reset { color: #e2e8f0; }
[data-theme="dark"] .vditor-wrapper .vditor-reset::before { color: rgba(255,255,255,0.25) !important; }
</style>
