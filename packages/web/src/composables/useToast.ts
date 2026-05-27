import { ref } from 'vue';

type ToastKind = 'default' | 'success' | 'error';

interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

interface ToastOptions {
  kind?: ToastKind;
  duration?: number;
  action?: ToastAction;
}

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  action?: ToastAction;
  duration: number;
}

// 叠加式 toast: 同时最多显示 N 个,超出踢最早一条 (类似游戏拾取物品的提示堆叠)
const MAX_TOASTS = 5;

const toasts = ref<ToastItem[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let nextId = 1;

function clearTimer(id: number) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

function dismiss(id: number) {
  const idx = toasts.value.findIndex((t) => t.id === id);
  if (idx >= 0) toasts.value.splice(idx, 1);
  clearTimer(id);
}

// hover 暂停: 清 timer; hover 离开: 重新按完整 duration 计时 (不算剩余时间, 多次 hover 都会重置 5s 窗口)
function pause(id: number) {
  clearTimer(id);
}

function resume(id: number) {
  if (timers.has(id)) return;
  const t = toasts.value.find((x) => x.id === id);
  if (!t) return;
  const timer = setTimeout(() => dismiss(id), t.duration);
  timers.set(id, timer);
}

export function useToast() {
  return {
    toasts,
    dismiss,
    pause,
    resume,
    // 兼容老用法 show(msg) / show(msg, 'success') / show(msg, 'error', 3000),
    // 新用法 show(msg, { kind, action, duration }) 支持撤销按钮等附加 action
    show(message: string, kindOrOpts: ToastKind | ToastOptions = 'default', duration = 1600) {
      let kind: ToastKind = 'default';
      let action: ToastAction | undefined;
      let dur = duration;
      if (typeof kindOrOpts === 'string') {
        kind = kindOrOpts;
      } else {
        kind = kindOrOpts.kind ?? 'default';
        action = kindOrOpts.action;
        if (kindOrOpts.duration !== undefined) dur = kindOrOpts.duration;
      }
      const id = nextId++;
      toasts.value.push({ id, message, kind, action, duration: dur });
      // 超上限,踢最早一条 (含正在倒计时的 timer 也一起清掉)
      while (toasts.value.length > MAX_TOASTS) {
        const dropped = toasts.value.shift();
        if (dropped) clearTimer(dropped.id);
      }
      const timer = setTimeout(() => dismiss(id), dur);
      timers.set(id, timer);
      return id;
    },
  };
}
