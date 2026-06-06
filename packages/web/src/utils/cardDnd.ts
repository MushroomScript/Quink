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
// Hover 停留自动 navigate: 拖到 sidebar 主导航 (灵感/笔记/待办/AI) 任一项停留 N ms → 派 quink-ai-expand
// (event 名历史遗留: 原本只给 AI 用, 现复用做通用 sidebar drag-hover navigate; detail.path 区分目标路径)
// → Sidebar 收到后 router.push(path), 拖动状态保持不释放, 用户能继续拖目标视图里的更细 drop target
// (或直接松手 → handleDrop 仍照常改 type / 加进 AI), 同时视图已切走 → 改完立刻看到结果.
// 同一个 target 一次拖动里只触发一次 navigate (navigatedTarget 记录); hover 离开时 clearTimeout 重置.
let hoverNavTimer: number | null = null;
let navigatedTarget: string | null = null;
const HOVER_NAV_MS = 400;

// dropzone target → sidebar nav 路径. 返回 null = 该 target 不参与 hover-navigate (cat: / action:trash 等).
// 跟 cardLeave.ts 的 TYPE_TO_NAV_PATH 同源映射 (type→view 全局只此两处, 加 view 时记得两边都改).
function hoverTargetToNavPath(target: string): string | null {
  if (target === 'action:ai') return '/ai';
  if (target === 'type:note') return '/';
  if (target === 'type:snippet') return '/notes';
  if (target === 'type:todo') return '/todos';
  return null;
}

function clearHoverNavTimer() {
  if (hoverNavTimer !== null) { clearTimeout(hoverNavTimer); hoverNavTimer = null; }
}
function startHoverNavTimer(target: string) {
  clearHoverNavTimer();
  hoverNavTimer = window.setTimeout(() => {
    hoverNavTimer = null;
    // timer 到时再次确认 hover 还在原 target (防中途离开未及时 clear) + 未 navigate 过
    if (dragState.active && dragState.hoverTarget === target && navigatedTarget !== target) {
      const path = hoverTargetToNavPath(target);
      if (!path) return;
      navigatedTarget = target;
      window.dispatchEvent(new CustomEvent('quink-ai-expand', { detail: { path } }));
    }
  }, HOVER_NAV_MS);
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
    // 进入参与 hover-navigate 的主导航 target (灵感/笔记/待办/AI) 且本次未跳转过 → 启动停留计时
    if (nextTarget && nextTarget !== navigatedTarget && hoverTargetToNavPath(nextTarget)) {
      startHoverNavTimer(nextTarget);
    } else {
      clearHoverNavTimer();
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
    const type = target.slice(5) as 'quink' | 'note' | 'todo';
    for (const id of ids) {
      try { await store.updateNote(id, { type } as any); } catch {}
    }
    if (store.selectMode) store.exitSelectMode();
  } else if (target.startsWith('cat:')) {
    const name = target.slice(4);
    for (const id of ids) {
      try { await store.updateNote(id, { category: name } as any); } catch {}
    }
    if (store.selectMode) store.exitSelectMode();
  } else if (target === 'action:trash') {
    // 软删除走确认弹窗: 派事件让 Sidebar 处理 (跟之前 HTML5 模式一致)
    window.dispatchEvent(new CustomEvent('quink-drop-trash', { detail: ids }));
  } else if (target === 'action:ai') {
    // 拖到 sidebar AI 松手 (没停留够 400ms 自动 navigate / 或停留过但在 AI 项松手) → 跳 /ai + 新对话 + 引用塞输入框
    sessionStorage.setItem('quink_ai_pending_drop', JSON.stringify({ kind: 'new', ids }));
    window.dispatchEvent(new CustomEvent('quink-ai-expand', { detail: { path: '/ai' } }));  // Sidebar navigate /ai
    window.dispatchEvent(new CustomEvent('quink-ai-drop', { detail: { kind: 'new', ids } }));
  } else if (target.startsWith('conv:')) {
    const convId = target.slice(5);
    sessionStorage.setItem('quink_ai_pending_drop', JSON.stringify({ kind: 'conv', ids, convId }));
    window.dispatchEvent(new CustomEvent('quink-ai-drop', { detail: { kind: 'conv', ids, convId } }));
  } else if (target === 'ai-page') {
    sessionStorage.setItem('quink_ai_pending_drop', JSON.stringify({ kind: 'current', ids }));
    window.dispatchEvent(new CustomEvent('quink-ai-drop', { detail: { kind: 'current', ids } }));
  }
  if (store.selectMode) store.exitSelectMode();
}

function reset() {
  dragState.active = false;
  dragState.ids = [];
  dragState.fromType = null;
  dragState.fromCategory = '';
  dragState.hoverTarget = null;
  dragState.ghostText = '';
  pendingStart = null;
  clearHoverNavTimer();
  navigatedTarget = null;
}
