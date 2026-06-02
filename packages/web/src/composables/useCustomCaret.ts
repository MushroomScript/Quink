/**
 * 全局自定义 caret（输入框闪烁光标）控制器。
 *
 * 为什么：浏览器 caret 粗细 / 高度由 OS 控制，CSS 无法调整（caret-color 只改颜色）。
 * 唯一改"形状"的办法是隐藏原生 caret + 自己用一个 div 跟随 input/textarea 的
 * selectionStart 位置画假光标。
 *
 * 实现要点：
 * - document focusin 自动接管符合条件的 input/textarea，focusout 释放
 * - 用 "mirror element"（隐藏 div 镜像 input 文字布局）算 caret 像素位置：
 *   把 value 截到 selectionStart 塞进 mirror + 加一个 marker span → measure span 位置。
 *   能正确处理中英混排 / 换行 / letter-spacing。
 * - IME composition 期间隐藏自定义 caret + 临时显原生（避免双 caret 错位）
 * - scroll / resize / 输入 / 键盘 / 鼠标点击 全部触发重新定位（rAF 节流）
 *
 * 跳过：Vditor 编辑器 / contenteditable（Range/Selection 复杂度单独处理）。
 * 跳过：非文本 input（button / checkbox / radio / file / range / date 等）。
 *
 * 启动：main.ts import 即触发模块级 side effect。
 */

type TextField = HTMLInputElement | HTMLTextAreaElement;
type Editable = TextField | HTMLElement;  // HTMLElement = contenteditable

function isContentEditable(el: Element | null): el is HTMLElement {
  return !!(el instanceof HTMLElement && el.isContentEditable
    && !(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement));
}

const MIRROR_ID = '__quinkCaretMirror';
const CARET_ID = '__quinkCaret';
const HMR_KEY = '__quinkCaretController';

const TEXT_INPUT_TYPES = new Set(['text', 'email', 'password', 'search', 'url', 'tel', 'number', '']);

// Caret 尺寸（蘑菇要的：宽 3px + 高 1em）
const CARET_WIDTH = 3;
const CARET_HEIGHT_RATIO = 1.0; // 1em

let mirror: HTMLDivElement | null = null;
let caret: HTMLDivElement | null = null;
let currentInput: Editable | null = null;
let composing = false;
let rafId = 0;

function isEligible(el: Element | null): el is Editable {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) return false;
    return true;
  }
  if (el instanceof HTMLInputElement) {
    if (el.disabled || el.readOnly) return false;
    if (!TEXT_INPUT_TYPES.has(el.type)) return false;
    return true;
  }
  // contenteditable（含 Vditor 编辑区）
  if (isContentEditable(el)) {
    return true;
  }
  return false;
}

function ensureElements() {
  if (!mirror) {
    mirror = document.createElement('div');
    mirror.id = MIRROR_ID;
    // 完全隔离布局影响：fixed 定位 + visibility hidden + 不接事件
    mirror.style.cssText = [
      'position:fixed',
      'visibility:hidden',
      'pointer-events:none',
      'top:0',
      'left:0',
      'margin:0',  // 防止全局 * { margin: 0 } 之外被其他规则给 default margin
      'padding:0',
      'border:0',
      'z-index:-1',
      'overflow:hidden',
      'tab-size:8'
    ].join(';');
    document.body.appendChild(mirror);
  }
  if (!caret) {
    caret = document.createElement('div');
    caret.id = CARET_ID;
    caret.style.cssText = [
      'position:fixed',
      'top:0',     // fixed 元素必须显式设 top/left, 否则浏览器用 normal-flow 静态位置, transform 在其基础上偏移
      'left:0',
      `width:${CARET_WIDTH}px`,
      'background:rgb(var(--c-accent))',
      'pointer-events:none',
      'z-index:var(--z-caret)', // 比所有 OS 控件 + 编辑器内置 caret 都高,详见根 Z-INDEX-SCALE.md
      'border-radius:1.5px',
      'display:none',
      'animation:quink-caret-blink 1.1s steps(2, start) infinite',
      'will-change:transform'
    ].join(';');
    document.body.appendChild(caret);
  }
}

/**
 * 把 input 的 computed style 中影响文字布局的部分复制到 mirror。
 * 同时把 mirror 定位到 input 内容区开始处（border + padding 内角）。
 */
function syncMirrorStyle(el: TextField) {
  const cs = getComputedStyle(el);
  const m = mirror!.style;
  // 字体 / 间距 / 文字属性必须一致
  m.fontFamily = cs.fontFamily;
  m.fontSize = cs.fontSize;
  m.fontWeight = cs.fontWeight;
  m.fontStyle = cs.fontStyle;
  m.fontVariant = cs.fontVariant;
  m.fontFeatureSettings = cs.fontFeatureSettings;
  m.fontVariantNumeric = cs.fontVariantNumeric;
  m.fontKerning = cs.fontKerning;
  m.letterSpacing = cs.letterSpacing;
  m.wordSpacing = cs.wordSpacing;
  m.lineHeight = cs.lineHeight;
  m.textTransform = cs.textTransform;
  // 故意不复制 cs.textIndent: 让 placeholder 用 text-indent 后移 2px 时, 我们的 caret 算法不跟着移
  // 结果是 caret 留在 padding-left, placeholder 文字往后 2px, 中间留出空隙
  m.textIndent = '0';
  m.direction = cs.direction;

  if (el instanceof HTMLTextAreaElement) {
    m.whiteSpace = 'pre-wrap';
    m.wordWrap = 'break-word';
    m.overflowWrap = 'break-word';
  } else {
    // 单行 input：不 wrap，超出按 scrollLeft 隐藏
    m.whiteSpace = 'pre';
    m.overflowWrap = 'normal';
  }

  // 用 input 内容区尺寸（不含 padding/border）作为 mirror 的内容盒
  const rect = el.getBoundingClientRect();
  const padL = parseFloat(cs.paddingLeft);
  const padT = parseFloat(cs.paddingTop);
  const padR = parseFloat(cs.paddingRight);
  const padB = parseFloat(cs.paddingBottom);
  const borL = parseFloat(cs.borderLeftWidth);
  const borT = parseFloat(cs.borderTopWidth);

  // mirror 定位到 input 内容区左上角；mirror 自己没 padding/border，所以 markerRect 直接是 caret 位置
  m.top = (rect.top + borT + padT) + 'px';
  m.left = (rect.left + borL + padL) + 'px';
  // 宽度 = input 内容宽（用于 textarea wrap）；textarea 高度让内容自动撑
  const contentWidth = rect.width - borL - padL - parseFloat(cs.borderRightWidth) - padR;
  m.width = contentWidth + 'px';
  // 高度自动撑（用于 textarea 多行）
  m.height = 'auto';
  // 给一个最大高度避免 mirror 撑爆 viewport（大值 textarea 偶发会算到）
  m.maxHeight = '99999px';

  // input scroll 偏移要 subtract（mirror 自己不 scroll）
  // 这部分在 measure 阶段调整，不写到 mirror style
  void padR; void padB;
}

/**
 * contenteditable 用 Selection + Range API 拿 caret 位置。
 *
 * 局限性 + 已知 edge case：
 * - Range.getBoundingClientRect 在文本节点开头 / 空节点 / 跨节点边界可能返回 0 宽 0 高 0 偏移
 *   → 用 getClientRects() 兜底，仍拿不到就用 focusNode 父元素 rect 推算
 * - Vditor 在 IME composition 期间会自己处理拼音候选，我们临时显原生 caret（外层 IME hook）
 * - caret 高度跟 selection 所在元素的 font-size（嵌套 h1 / p / pre 不一样）
 */
function updateCaretContentEditable(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
    // 没 selection 或者范围选择 → 隐藏（范围选择 caret 没意义）
    caret!.style.display = 'none';
    return;
  }
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) {
    caret!.style.display = 'none';
    return;
  }

  let rect = range.getBoundingClientRect();
  // 空 rect 兜底 1: getClientRects 拿第一段
  if (rect.width === 0 && rect.height === 0 && rect.left === 0 && rect.top === 0) {
    const rects = range.getClientRects();
    if (rects.length > 0) rect = rects[0];
  }
  // 空 rect 兜底 2: 用 focusNode 父元素 padding box 左上角 + lineHeight (空 Vditor 段落场景)
  if (rect.height === 0) {
    const node = range.startContainer;
    const parent = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element) as HTMLElement | null;
    if (parent) {
      const pr = parent.getBoundingClientRect();
      const pcs = getComputedStyle(parent);
      const padL = parseFloat(pcs.paddingLeft);
      const padT = parseFloat(pcs.paddingTop);
      const fs = parseFloat(pcs.fontSize);
      // 用 lineHeight 当 rect.height, 让后续 verticalPadding 算法把 caret 居中到 line box
      // (兜底之前用 fontSize 让 verticalPadding=0, caret 贴 line top, 视觉"靠上几像素")
      let lh = parseFloat(pcs.lineHeight);
      if (isNaN(lh)) lh = fs * 1.2;
      rect = { left: pr.left + padL, top: pr.top + padT, width: 0, height: lh, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
  }
  if (rect.height === 0) {
    caret!.style.display = 'none';
    return;
  }

  // caret 高度跟当前元素 font-size（不是 rect.height 行高）
  const node = range.startContainer;
  const fontHolder = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element) as HTMLElement | null;
  const fontSize = fontHolder ? parseFloat(getComputedStyle(fontHolder).fontSize) : 16;
  const caretHeight = fontSize * CARET_HEIGHT_RATIO;
  // Vditor 几何居中 + 1px 下移 (蘑菇说"vditor 不用动了"那时候的位置, 不再跟 input 联动)
  const verticalPadding = Math.max(0, (rect.height - caretHeight) / 2) + 1;

  caret!.style.display = 'block';
  caret!.style.width = CARET_WIDTH + 'px';
  caret!.style.transform = `translate(${rect.left}px, ${rect.top + verticalPadding}px)`;
  caret!.style.height = caretHeight + 'px';
}

function updateCaret() {
  if (!currentInput || composing) return;
  const el = currentInput;
  if (!mirror || !caret) return;

  // 焦点已经移开（极端 race）
  if (document.activeElement !== el && !el.contains(document.activeElement)) {
    caret.style.display = 'none';
    return;
  }

  // contenteditable 走 Selection/Range API 路径
  if (isContentEditable(el)) {
    updateCaretContentEditable(el);
    return;
  }

  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
    caret.style.display = 'none';
    return;
  }

  syncMirrorStyle(el);

  const selStart = el.selectionStart ?? el.value.length;
  const before = el.value.substring(0, selStart);

  // 清空 mirror + 塞内容 + 末尾 marker span
  // 用 textContent 设置 before, 然后 appendChild marker（避免 innerHTML 注入风险 + 性能）
  mirror.textContent = before;
  const marker = document.createElement('span');
  marker.textContent = '​'; // ZWSP，零宽空格只为拿到位置
  mirror.appendChild(marker);

  const markerRect = marker.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const fontSize = parseFloat(cs.fontSize);
  const caretHeight = fontSize * CARET_HEIGHT_RATIO;

  // input scroll 偏移
  const scrollLeft = el.scrollLeft;
  const scrollTop = el.scrollTop;

  // markerRect.left 已经是 viewport 坐标，mirror 定位在 input 内容区，所以减 scrollLeft 即得 input 内 caret 真实位置
  let caretLeft = markerRect.left - scrollLeft;
  // 垂直：marker 顶部是当前行的 text top（line box top）
  // caret 顶部应该跟字符 baseline 附近对齐 → 我们用 line top + (lineHeight - fontSize) / 2
  // 但更简单的近似：直接用 marker top 减 scrollTop，caret 高度 = fontSize * ratio
  let lineHeight = parseFloat(cs.lineHeight);
  if (isNaN(lineHeight)) lineHeight = fontSize * 1.2;
  // 几何居中 + 0.5px 下移微调跟字符视觉居中 (蘑菇调出来的偏好)
  const verticalPadding = Math.max(0, (lineHeight - caretHeight) / 2) + 0.5;
  let caretTop = markerRect.top - scrollTop + verticalPadding;

  // 边界裁切：caret 必须在 input 内容区内（不越出 padding 边界）
  const inputRect = el.getBoundingClientRect();
  const padL = parseFloat(cs.paddingLeft);
  const padR = parseFloat(cs.paddingRight);
  const padT = parseFloat(cs.paddingTop);
  const padB = parseFloat(cs.paddingBottom);
  const borL = parseFloat(cs.borderLeftWidth);
  const borT = parseFloat(cs.borderTopWidth);

  const minLeft = inputRect.left + borL + padL;
  const maxLeft = inputRect.right - padR - CARET_WIDTH;
  const minTop = inputRect.top + borT + padT;
  const maxBottom = inputRect.bottom - padB;

  // 在内容区外（被 scroll 出去 / 越界）→ 隐藏
  if (caretLeft < minLeft - 1 || caretLeft > maxLeft + 1 ||
      caretTop + caretHeight < minTop || caretTop > maxBottom) {
    caret.style.display = 'none';
    return;
  }

  caret.style.width = CARET_WIDTH + 'px';
  caret.style.display = 'block';
  caret.style.transform = `translate(${caretLeft}px, ${caretTop}px)`;
  caret.style.height = caretHeight + 'px';
}

function scheduleUpdate() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    updateCaret();
  });
}

function onCompositionStart() {
  composing = true;
  // IME 期间显示原生 caret（避免双 caret 错位 / 候选框定位错）
  if (currentInput) currentInput.style.caretColor = '';
  if (caret) caret.style.display = 'none';
}

function onCompositionEnd() {
  composing = false;
  if (currentInput) currentInput.style.caretColor = 'transparent';
  scheduleUpdate();
}

function onSelectionChange() {
  // 只在当前接管 contenteditable 时响应；input/textarea 已有自己的 listener
  if (currentInput && isContentEditable(currentInput)) scheduleUpdate();
}

function attachListeners(el: Editable) {
  el.addEventListener('input', scheduleUpdate);
  el.addEventListener('keyup', scheduleUpdate);
  el.addEventListener('keydown', scheduleUpdate);
  el.addEventListener('click', scheduleUpdate);
  el.addEventListener('mouseup', scheduleUpdate);
  el.addEventListener('scroll', scheduleUpdate);
  el.addEventListener('compositionstart', onCompositionStart);
  el.addEventListener('compositionend', onCompositionEnd);
  if (isContentEditable(el)) {
    // contenteditable 的 caret 移动用 selectionchange 全局事件感知
    document.addEventListener('selectionchange', onSelectionChange);
  } else {
    el.addEventListener('select', scheduleUpdate);
  }
}

function detachListeners(el: Editable) {
  el.removeEventListener('input', scheduleUpdate);
  el.removeEventListener('keyup', scheduleUpdate);
  el.removeEventListener('keydown', scheduleUpdate);
  el.removeEventListener('click', scheduleUpdate);
  el.removeEventListener('mouseup', scheduleUpdate);
  el.removeEventListener('scroll', scheduleUpdate);
  el.removeEventListener('compositionstart', onCompositionStart);
  el.removeEventListener('compositionend', onCompositionEnd);
  if (isContentEditable(el)) {
    document.removeEventListener('selectionchange', onSelectionChange);
  } else {
    el.removeEventListener('select', scheduleUpdate);
  }
}

function attach(el: Editable) {
  if (currentInput && currentInput !== el) {
    detachListeners(currentInput);
    currentInput.style.caretColor = '';
  }
  currentInput = el;
  ensureElements();
  el.style.caretColor = 'transparent';
  attachListeners(el);
  scheduleUpdate();
}

function detach(el: Editable) {
  detachListeners(el);
  el.style.caretColor = '';
  if (currentInput === el) currentInput = null;
  if (caret) caret.style.display = 'none';
}

function onFocusIn(e: FocusEvent) {
  const t = e.target as Element | null;
  if (isEligible(t)) attach(t);
}

function onFocusOut(e: FocusEvent) {
  const t = e.target as Element | null;
  if (isEligible(t)) detach(t);
}

function onWindowChange() {
  scheduleUpdate();
}

export function startQuinkCaret() {
  // HMR 友好：清理上次挂的全局 listener
  const w = window as any;
  if (w[HMR_KEY]) {
    try { w[HMR_KEY](); } catch {}
  }
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  window.addEventListener('resize', onWindowChange);
  window.addEventListener('scroll', onWindowChange, true);
  // 主题切换 (data-theme) → caret 颜色用 var(--c-accent)，CSS 已自动跟随；不用专门 listener

  // 注入闪烁动画 keyframes + placeholder 让位规则 (HMR 友好: 始终更新 textContent)
  const styleId = '__quinkCaretStyle';
  let style = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = styleId;
    document.head.appendChild(style);
  }
  style.textContent = `
@keyframes quink-caret-blink { 0%, 50% { opacity: 1; } 50.01%, 100% { opacity: 0; } }
/* placeholder 让出 caret 空间:
   input/textarea 用 text-indent (mirror 强制 textIndent=0 让 caret 不跟着移),
   Vditor 用 ::before padding-left (caret 在 ce 内容区起点, 不在 ::before 内, 不受影响) */
input:placeholder-shown, textarea:placeholder-shown { text-indent: 5px; }
.vditor-ir pre.vditor-reset:empty::before,
.vditor-reset:empty::before,
[contenteditable="true"]:empty::before {
  padding-left: 4px !important;
}
`;

  w[HMR_KEY] = () => {
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('focusout', onFocusOut);
    window.removeEventListener('resize', onWindowChange);
    window.removeEventListener('scroll', onWindowChange, true);
    if (currentInput) {
      detachListeners(currentInput);
      currentInput.style.caretColor = '';
      currentInput = null;
    }
    if (caret) { caret.remove(); caret = null; }
    if (mirror) { mirror.remove(); mirror = null; }
  };
}

// 模块加载即启动（被 main.ts import 一次触发）
if (typeof window !== 'undefined') {
  startQuinkCaret();
}
