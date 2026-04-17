import { uIOhook, UiohookKey } from 'uiohook-napi';

type ShortcutCallback = () => void;

interface ShortcutBinding {
  keys: Set<number>;
  callback: ShortcutCallback;
}

const bindings: ShortcutBinding[] = [];
const pressedKeys = new Set<number>();

// 按键名 → uiohook keycode 映射（完整）
const KEY_MAP: Record<string, number> = {
  // Modifiers
  'Shift': UiohookKey.Shift, 'ShiftRight': UiohookKey.ShiftRight,
  'Ctrl': UiohookKey.Ctrl, 'CtrlRight': UiohookKey.CtrlRight,
  'Alt': UiohookKey.Alt, 'AltRight': UiohookKey.AltRight,
  'Meta': UiohookKey.Meta, 'MetaRight': UiohookKey.MetaRight,
  // Letters
  'A': UiohookKey.A, 'B': UiohookKey.B, 'C': UiohookKey.C, 'D': UiohookKey.D,
  'E': UiohookKey.E, 'F': UiohookKey.F, 'G': UiohookKey.G, 'H': UiohookKey.H,
  'I': UiohookKey.I, 'J': UiohookKey.J, 'K': UiohookKey.K, 'L': UiohookKey.L,
  'M': UiohookKey.M, 'N': UiohookKey.N, 'O': UiohookKey.O, 'P': UiohookKey.P,
  'Q': UiohookKey.Q, 'R': UiohookKey.R, 'S': UiohookKey.S, 'T': UiohookKey.T,
  'U': UiohookKey.U, 'V': UiohookKey.V, 'W': UiohookKey.W, 'X': UiohookKey.X,
  'Y': UiohookKey.Y, 'Z': UiohookKey.Z,
  // Numbers (top row)
  '0': UiohookKey[0], '1': UiohookKey[1], '2': UiohookKey[2], '3': UiohookKey[3],
  '4': UiohookKey[4], '5': UiohookKey[5], '6': UiohookKey[6], '7': UiohookKey[7],
  '8': UiohookKey[8], '9': UiohookKey[9],
  // F keys
  'F1': UiohookKey.F1, 'F2': UiohookKey.F2, 'F3': UiohookKey.F3, 'F4': UiohookKey.F4,
  'F5': UiohookKey.F5, 'F6': UiohookKey.F6, 'F7': UiohookKey.F7, 'F8': UiohookKey.F8,
  'F9': UiohookKey.F9, 'F10': UiohookKey.F10, 'F11': UiohookKey.F11, 'F12': UiohookKey.F12,
  'F13': UiohookKey.F13, 'F14': UiohookKey.F14, 'F15': UiohookKey.F15, 'F16': UiohookKey.F16,
  'F17': UiohookKey.F17, 'F18': UiohookKey.F18, 'F19': UiohookKey.F19, 'F20': UiohookKey.F20,
  'F21': UiohookKey.F21, 'F22': UiohookKey.F22, 'F23': UiohookKey.F23, 'F24': UiohookKey.F24,
  // Navigation
  'Space': UiohookKey.Space, 'Enter': UiohookKey.Enter, 'Tab': UiohookKey.Tab,
  'Escape': UiohookKey.Escape, 'Backspace': UiohookKey.Backspace, 'Delete': UiohookKey.Delete,
  'Insert': UiohookKey.Insert, 'Home': UiohookKey.Home, 'End': UiohookKey.End,
  'PageUp': UiohookKey.PageUp, 'PageDown': UiohookKey.PageDown,
  'ArrowUp': UiohookKey.ArrowUp, 'ArrowDown': UiohookKey.ArrowDown,
  'ArrowLeft': UiohookKey.ArrowLeft, 'ArrowRight': UiohookKey.ArrowRight,
  'Up': UiohookKey.ArrowUp, 'Down': UiohookKey.ArrowDown,
  'Left': UiohookKey.ArrowLeft, 'Right': UiohookKey.ArrowRight,
  // Punctuation & symbols
  '`': UiohookKey.Backquote, 'Backquote': UiohookKey.Backquote,
  '-': UiohookKey.Minus, 'Minus': UiohookKey.Minus,
  '=': UiohookKey.Equal, 'Equal': UiohookKey.Equal,
  '[': UiohookKey.BracketLeft, 'BracketLeft': UiohookKey.BracketLeft,
  ']': UiohookKey.BracketRight, 'BracketRight': UiohookKey.BracketRight,
  '\\': UiohookKey.Backslash, 'Backslash': UiohookKey.Backslash,
  ';': UiohookKey.Semicolon, 'Semicolon': UiohookKey.Semicolon,
  "'": UiohookKey.Quote, 'Quote': UiohookKey.Quote,
  ',': UiohookKey.Comma, 'Comma': UiohookKey.Comma,
  '.': UiohookKey.Period, 'Period': UiohookKey.Period,
  '/': UiohookKey.Slash, 'Slash': UiohookKey.Slash,
  // Lock keys
  'CapsLock': UiohookKey.CapsLock, 'NumLock': UiohookKey.NumLock, 'ScrollLock': UiohookKey.ScrollLock,
  'PrintScreen': UiohookKey.PrintScreen,
  // Numpad
  'Numpad0': UiohookKey.Numpad0, 'Numpad1': UiohookKey.Numpad1, 'Numpad2': UiohookKey.Numpad2,
  'Numpad3': UiohookKey.Numpad3, 'Numpad4': UiohookKey.Numpad4, 'Numpad5': UiohookKey.Numpad5,
  'Numpad6': UiohookKey.Numpad6, 'Numpad7': UiohookKey.Numpad7, 'Numpad8': UiohookKey.Numpad8,
  'Numpad9': UiohookKey.Numpad9,
  'NumpadAdd': UiohookKey.NumpadAdd, 'NumpadSubtract': UiohookKey.NumpadSubtract,
  'NumpadMultiply': UiohookKey.NumpadMultiply, 'NumpadDivide': UiohookKey.NumpadDivide,
  'NumpadDecimal': UiohookKey.NumpadDecimal, 'NumpadEnter': UiohookKey.NumpadEnter,
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

  const idx = bindings.findIndex(b => setsEqual(b.keys, keys));
  if (idx !== -1) bindings.splice(idx, 1);

  bindings.push({ keys, callback });
  // 按键数降序排列，优先匹配更长的组合
  bindings.sort((a, b) => b.keys.size - a.keys.size);
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
  // 标准化：左右修饰键合并
  const normalized = new Set<number>();
  for (const k of pressedKeys) {
    if (k === UiohookKey.CtrlRight) normalized.add(UiohookKey.Ctrl);
    else if (k === UiohookKey.ShiftRight) normalized.add(UiohookKey.Shift);
    else if (k === UiohookKey.AltRight) normalized.add(UiohookKey.Alt);
    else if (k === UiohookKey.MetaRight) normalized.add(UiohookKey.Meta);
    else normalized.add(k);
  }

  // 找最长的匹配（所有 binding 的键都在 normalized 中）
  let bestMatch: ShortcutBinding | null = null;
  for (const binding of bindings) {
    let allFound = true;
    for (const k of binding.keys) {
      if (!normalized.has(k)) { allFound = false; break; }
    }
    if (allFound) {
      if (!bestMatch || binding.keys.size > bestMatch.keys.size) {
        bestMatch = binding;
      }
    }
  }

  if (bestMatch) {
    if (debounceTimer) clearTimeout(debounceTimer);
    const cb = bestMatch.callback;
    debounceTimer = setTimeout(() => { cb(); }, 50);
  }
}
