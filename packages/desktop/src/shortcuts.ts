import { uIOhook, UiohookKey } from 'uiohook-napi';

type ShortcutCallback = () => void;

interface ShortcutBinding {
  keys: Set<number>;
  callback: ShortcutCallback;
}

const bindings: ShortcutBinding[] = [];
const pressedKeys = new Set<number>();

// 按键名 → uiohook keycode 映射
const KEY_MAP: Record<string, number> = {
  'Space': UiohookKey.Space,
  'Enter': UiohookKey.Enter,
  'Tab': UiohookKey.Tab,
  'Escape': UiohookKey.Escape,
  'Backspace': UiohookKey.Backspace,
  'Delete': UiohookKey.Delete,
  'Shift': UiohookKey.Shift,
  'Ctrl': UiohookKey.Ctrl,
  'Alt': UiohookKey.Alt,
  'Meta': UiohookKey.Meta,
  // Letters
  'A': UiohookKey.A, 'B': UiohookKey.B, 'C': UiohookKey.C, 'D': UiohookKey.D,
  'E': UiohookKey.E, 'F': UiohookKey.F, 'G': UiohookKey.G, 'H': UiohookKey.H,
  'I': UiohookKey.I, 'J': UiohookKey.J, 'K': UiohookKey.K, 'L': UiohookKey.L,
  'M': UiohookKey.M, 'N': UiohookKey.N, 'O': UiohookKey.O, 'P': UiohookKey.P,
  'Q': UiohookKey.Q, 'R': UiohookKey.R, 'S': UiohookKey.S, 'T': UiohookKey.T,
  'U': UiohookKey.U, 'V': UiohookKey.V, 'W': UiohookKey.W, 'X': UiohookKey.X,
  'Y': UiohookKey.Y, 'Z': UiohookKey.Z,
  // Numbers
  '0': UiohookKey[0], '1': UiohookKey[1], '2': UiohookKey[2], '3': UiohookKey[3],
  '4': UiohookKey[4], '5': UiohookKey[5], '6': UiohookKey[6], '7': UiohookKey[7],
  '8': UiohookKey[8], '9': UiohookKey[9],
  // F keys
  'F1': UiohookKey.F1, 'F2': UiohookKey.F2, 'F3': UiohookKey.F3, 'F4': UiohookKey.F4,
  'F5': UiohookKey.F5, 'F6': UiohookKey.F6, 'F7': UiohookKey.F7, 'F8': UiohookKey.F8,
  'F9': UiohookKey.F9, 'F10': UiohookKey.F10, 'F11': UiohookKey.F11, 'F12': UiohookKey.F12,
};

// 将 "Shift+Space" 格式的字符串解析为 keycode 集合
function parseShortcut(shortcut: string): Set<number> | null {
  const parts = shortcut.split('+').map(k => k.trim());
  const codes = new Set<number>();

  for (const part of parts) {
    const code = KEY_MAP[part];
    if (code === undefined) {
      console.warn(`Unknown key: "${part}" in shortcut "${shortcut}"`);
      return null;
    }
    codes.add(code);
  }

  return codes.size > 0 ? codes : null;
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

let started = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function registerShortcut(combo: string, callback: ShortcutCallback): boolean {
  const keys = parseShortcut(combo);
  if (!keys) return false;

  // Remove any existing binding for this combo
  const idx = bindings.findIndex(b => setsEqual(b.keys, keys));
  if (idx !== -1) bindings.splice(idx, 1);

  bindings.push({ keys, callback });
  return true;
}

export function unregisterAll() {
  bindings.length = 0;
}

export function startHook() {
  if (started) return;
  started = true;

  uIOhook.on('keydown', (e) => {
    pressedKeys.add(e.keycode);
    checkBindings();
  });

  uIOhook.on('keyup', (e) => {
    pressedKeys.delete(e.keycode);
  });

  uIOhook.start();
}

export function stopHook() {
  if (!started) return;
  uIOhook.stop();
  started = false;
}

function checkBindings() {
  for (const binding of bindings) {
    if (setsEqual(pressedKeys, binding.keys)) {
      // Debounce to prevent double-firing
      if (debounceTimer) clearTimeout(debounceTimer);
      const cb = binding.callback;
      debounceTimer = setTimeout(() => {
        cb();
      }, 50);
      break;
    }
  }
}
