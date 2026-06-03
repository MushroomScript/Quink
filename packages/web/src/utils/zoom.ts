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
