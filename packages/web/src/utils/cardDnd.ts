// 自定义卡片拖放 (pointer events, 不用 HTML5 DnD).
// 起因: Chromium 在 HTML5 DnD 期间彻底拦截 wheel 事件, 即使 capture + preventDefault 也拿不到.
// 改用 pointer events 自己实现: pointerdown 启动 + pointermove 检测 + pointerup drop.
// 期间 wheel/mousemove/任何事件都正常派发, 用户可以滚 sidebar 看到更多目标.
//
// dropzone 标识: DOM 元素加 data-drop-target="type:note" / "cat:工作" / "action:trash"
// (跟之前 HTML5 模式同语义, NoteCard / Sidebar 改造时仅改触发方式不改协议).
import { reactive } from 'vue';
import { useNotesStore } from '@/stores/notes';

const DRAG_THRESHOLD = 4;

interface DragState {
  active: boolean;
  ids: string[];
  fromType: string | null;       // 仅单条拖动时有值, 多条 null (用于 same-type 跳过判断)
  fromCategory: string;          // 同上
  hoverTarget: string | null;    // 当前 elementFromPoint 命中的 [data-drop-target] 值
  ghostX: number;                // 鼠标位置 (ghost 跟着鼠标)
  ghostY: number;
  ghostText: string;             // ghost 上显示的文字 ("X 条" / 笔记摘要前 30 字)
}

export const dragState = reactive<DragState>({
  active: false,
  ids: [],
  fromType: null,
  fromCategory: '',
  hoverTarget: null,
  ghostX: 0,
  ghostY: 0,
  ghostText: '',
});

interface PendingStart {
  x: number;
  y: number;
  ids: string[];
  type: string | null;
  category: string;
  text: string;
}

let pendingStart: PendingStart | null = null;
let activePointerId: number | null = null;
// AI hover 停留检测: 拖到 sidebar "AI" 项停留 N ms → 派 quink-ai-expand 让 Sidebar navigate /ai (拖动状态保持, 用户继续拖到 conv).
// 用 setTimeout 启动独立 timer (不依赖鼠标移动); hover 离开 AI 时 clearTimeout 重置, 重新 hover 时重新计时
let aiHoverTimer: number | null = null;
let expandedAi = false;
const AI_HOVER_EXPAND_MS = 400;

function clearAiHoverTimer() {
  if (aiHoverTimer !== null) { clearTimeout(aiHoverTimer); aiHoverTimer = null; }
}
function startAiHoverTimer() {
  clearAiHoverTimer();
  aiHoverTimer = window.setTimeout(() => {
    aiHoverTimer = null;
    // timer 到时再次确认 hover 还在 AI 项 (防中途离开未及时 clear)
    if (dragState.active && dragState.hoverTarget === 'action:ai' && !expandedAi) {
      expandedAi = true;
      window.dispatchEvent(new CustomEvent('quink-ai-expand'));
    }
  }, AI_HOVER_EXPAND_MS);
}

// NoteCard pointerdown 调用. payload 内 ids 单/多 由 selectMode 判断
export function startCardDrag(e: PointerEvent, payload: {
  ids: string[];
  type: string | null;
  category: string;
  text: string;
}) {
  if (e.button !== 0) return;
  if (!payload.ids.length) return;
  pendingStart = { x: e.clientX, y: e.clientY, ...payload };
  activePointerId = e.pointerId;
  document.addEventListener('pointermove', onMove, { passive: false });
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}

function onMove(e: PointerEvent) {
  if (activePointerId !== null && e.pointerId !== activePointerId) return;
  if (pendingStart && !dragState.active) {
    const dx = e.clientX - pendingStart.x;
    const dy = e.clientY - pendingStart.y;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    // 超阈值, 正式进入拖动
    dragState.active = true;
    dragState.ids = pendingStart.ids;
    dragState.fromType = pendingStart.type;
    dragState.fromCategory = pendingStart.category;
    dragState.ghostText = pendingStart.text;
    pendingStart = null;
  }
  if (!dragState.active) return;
  // 阻止默认 (避免拖动时 text selection / 浏览器自带拖动行为)
  e.preventDefault();
  dragState.ghostX = e.clientX;
  dragState.ghostY = e.clientY;
  // 探测当前 hover 的 dropzone: data-drop-target 属性
  const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
  const dropEl = el?.closest?.('[data-drop-target]') as HTMLElement | null;
  const prevTarget = dragState.hoverTarget;
  let nextTarget: string | null = null;
  if (dropEl) {
    const target = dropEl.getAttribute('data-drop-target');
    // same-type / same-cat 不接受 (单条拖动且 from === to)
    if (target?.startsWith('type:') && dragState.ids.length === 1 && dragState.fromType === target.slice(5)) {
      nextTarget = null;
    } else if (target?.startsWith('cat:') && dragState.ids.length === 1 && dragState.fromCategory === target.slice(4)) {
      nextTarget = null;
    } else {
      nextTarget = target;
    }
  }
  if (nextTarget !== prevTarget) {
    dragState.hoverTarget = nextTarget;
    if (nextTarget === 'action:ai' && !expandedAi) {
      startAiHoverTimer();  // 进入 AI 项, 启动停留计时
    } else {
      clearAiHoverTimer();  // 离开 AI 项, 取消计时
    }
  }
}

async function onUp(e: PointerEvent) {
  if (activePointerId !== null && e.pointerId !== activePointerId) return;
  document.removeEventListener('pointermove', onMove);
  document.removeEventListener('pointerup', onUp);
  document.removeEventListener('pointercancel', onUp);
  activePointerId = null;
  if (!dragState.active) {
    // 没超阈值 → 当作单击, 不阻止后续 click 自然走 NoteCard handleClick
    pendingStart = null;
    return;
  }
  const target = dragState.hoverTarget;
  const ids = dragState.ids.slice();
  reset();
  if (target) await handleDrop(target, ids);
}

async function handleDrop(target: string, ids: string[]) {
  const store = useNotesStore();
  if (target.startsWith('type:')) {
    const type = target.slice(5) as 'note' | 'snippet' | 'todo';
    for (const id of ids) {
      try { await store.updateNote(id, { type } as any); } catch {}
    }
    if (store.selectMode) store.clearSelection();
  } else if (target.startsWith('cat:')) {
    const name = target.slice(4);
    for (const id of ids) {
      try { await store.updateNote(id, { category: name } as any); } catch {}
    }
    if (store.selectMode) store.clearSelection();
  } else if (target === 'action:trash') {
    // 软删除走确认弹窗: 派事件让 Sidebar 处理 (跟之前 HTML5 模式一致)
    window.dispatchEvent(new CustomEvent('quink-drop-trash', { detail: ids }));
  } else if (target === 'action:ai') {
    // 拖到 sidebar AI 松手 (没停留 1s 自动展开 / 或停留过但在 AI 项松手) → 跳 /ai + 新对话 + 引用塞输入框
    sessionStorage.setItem('quink_ai_pending_drop', JSON.stringify({ kind: 'new', ids }));
    window.dispatchEvent(new CustomEvent('quink-ai-expand'));  // Sidebar navigate /ai
    window.dispatchEvent(new CustomEvent('quink-ai-drop', { detail: { kind: 'new', ids } }));
  } else if (target.startsWith('conv:')) {
    const convId = target.slice(5);
    sessionStorage.setItem('quink_ai_pending_drop', JSON.stringify({ kind: 'conv', ids, convId }));
    window.dispatchEvent(new CustomEvent('quink-ai-drop', { detail: { kind: 'conv', ids, convId } }));
  } else if (target === 'ai-page') {
    sessionStorage.setItem('quink_ai_pending_drop', JSON.stringify({ kind: 'current', ids }));
    window.dispatchEvent(new CustomEvent('quink-ai-drop', { detail: { kind: 'current', ids } }));
  }
  if (store.selectMode) store.clearSelection();
}

function reset() {
  dragState.active = false;
  dragState.ids = [];
  dragState.fromType = null;
  dragState.fromCategory = '';
  dragState.hoverTarget = null;
  dragState.ghostText = '';
  pendingStart = null;
  clearAiHoverTimer();
  expandedAi = false;
}
