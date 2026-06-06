/**
 * 取当前 CSS zoom factor。
 *
 * 背景: Quink 的"显示比例"在 Electron 端走 webContents.setZoomFactor (浏览器 page zoom,
 * 所有 getBoundingClientRect 跟 CSS 坐标都是 zoom 后等价, fixed 元素正常工作);
 * 在 Web/PWA 端走 document.documentElement.style.zoom (CSS zoom 属性, 累积 layout 缩放,
 * 子元素的 getBoundingClientRect 返回 zoom 后视觉坐标, fixed 元素 top/left 也被 zoom 乘 1 次)。
 *
 * 问题: trigger.getBoundingClientRect().top 已经是 zoom 后坐标, 直接赋给 popup style.top
 * 会让 popup 实际渲染位置 = top * zoom → 整体偏 (zoom-1)*100% (蘑菇报: 网页版下拉菜单
 * 位置不对 + 编辑区光标错位)。
 *
 * 修法: web 端把 rect 坐标除以 zoom factor 再赋给 fixed 元素的 top/left/transform,
 * Electron 端 zoom factor 返回 1 (CSS zoom 没设, 走 setZoomFactor) 行为不变。
 */
export function getCssZoom(): number {
  if (typeof document === 'undefined') return 1;
  const z = document.documentElement.style.zoom;
  if (!z) return 1;
  const n = parseFloat(z);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * 给一个 DOMRect (来自 getBoundingClientRect) 或 HTMLElement, 返回 unzoomed CSS pixel 坐标.
 * 跟"设 inline style.top/left/right/bottom"用的 px 单位一致 → 设进去后 fixed 元素渲染位置正确.
 *
 * 用法:
 *   const r = unzoomRect(buttonEl);
 *   popoverStyle.value = { top: `${r.bottom + 4}px`, left: `${r.left}px` };
 *
 * Electron 端 (setZoomFactor) zoom 返回 1, 行为不变 (跟 r.bottom 直接用一样).
 * Web 端 zoom=1.5 时 rect 的 ./1.5 才是真实 layout 坐标.
 */
export function unzoomRect(input: HTMLElement | DOMRect): {
  top: number; bottom: number; left: number; right: number; width: number; height: number;
} {
  const z = getCssZoom();
  const r = input instanceof Element ? input.getBoundingClientRect() : input;
  return {
    top: r.top / z,
    bottom: r.bottom / z,
    left: r.left / z,
    right: r.right / z,
    width: r.width / z,
    height: r.height / z,
  };
}

/**
 * 返回 layout viewport 大小 (unzoomed CSS px), 跟 inline style px 单位一致.
 * Web 端 zoom=1.5 + window.innerWidth=1249 → vw=832 (用户实际可见 CSS px 宽度).
 * Electron 端 zoom=1 → 等同 window.innerWidth/innerHeight.
 */
export function unzoomViewport(): { vw: number; vh: number } {
  const z = getCssZoom();
  return { vw: window.innerWidth / z, vh: window.innerHeight / z };
}
