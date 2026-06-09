// 蘑菇 2026-06-09: 卡片最小宽度偏好, localStorage 存到设备本地 (不跨账号同步, 不进 user.preferences).
// 两种模式:
//  - px: 像素绝对值 (默认 320). cols = floor(main / value), 大屏自然多列, 小屏自动减
//  - percent: 单卡占 main 区的百分比 (默认 25%). cols = floor(100 / value), 列数固定不论 main 多大 (25%=4列, 20%=5列)
// useMasonry 内部每次 getColumnCount 时调 getCardWidthPref 读最新值. Settings 改完调 setCardWidthPref → dispatchEvent('resize') 触发 useMasonry 重算.

export type CardWidthMode = 'px' | 'percent';
export interface CardWidthPref { mode: CardWidthMode; value: number }

const KEY = 'quink_card_min_width';
const DEFAULT: CardWidthPref = { mode: 'px', value: 320 };

export function getCardWidthPref(): CardWidthPref {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const p = JSON.parse(raw);
    if ((p.mode === 'px' || p.mode === 'percent') && typeof p.value === 'number' && p.value > 0) return p;
  } catch {}
  return DEFAULT;
}

export function setCardWidthPref(p: CardWidthPref) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
    // useMasonry 的 onResize handler 监听 window resize, dispatch 让所有打开的 view 重算列数
    window.dispatchEvent(new Event('resize'));
  } catch {}
}

// 算列数. 给 useMasonry 直接调
export function computeColumnCount(mainW: number, pref: CardWidthPref = getCardWidthPref()): number {
  if (pref.mode === 'percent') {
    // 百分比锁列数: 单卡至少占 main 的 value%, 列数 = floor(100/value) 跟 main 无关 (25%=4列, 20%=5列)
    return Math.max(1, Math.floor(100 / Math.max(1, pref.value)));
  }
  // px 模式: 单卡至少 value px, 列数随 main 变化 (大屏多列小屏少列, 无上限)
  return Math.max(1, Math.floor(mainW / Math.max(1, pref.value)));
}
