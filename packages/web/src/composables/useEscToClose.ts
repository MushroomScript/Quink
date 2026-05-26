import { watch, type Ref } from 'vue';

// modal / popover 通用 ESC 关闭. 监听 ref 变 truthy 时挂 document keydown listener,
// ESC 触发就把 ref 设回 closedValue (默认 false). ref 变 falsy 时自动 cleanup, 防 listener 泄漏.
//
// 不做嵌套 modal 优先级处理 — 如果同时多个 modal 开着 (罕见), ESC 会一并关. 这反而是合理行为.
//
// 用法:
//   const open = ref(false);
//   useEscToClose(open);
//
//   const renameTarget = ref<Item | null>(null);
//   useEscToClose(renameTarget, null);  // 关闭值显式传 null
export function useEscToClose<T = boolean>(target: Ref<T>, closedValue: T = false as any) {
  let off: (() => void) | null = null;
  watch(target, (v) => {
    if (off) { off(); off = null; }
    if (!v) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        target.value = closedValue;
      }
    };
    document.addEventListener('keydown', handler);
    off = () => document.removeEventListener('keydown', handler);
  }, { immediate: true });
}
