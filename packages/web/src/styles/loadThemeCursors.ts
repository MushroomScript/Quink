/**
 * 按 <html data-theme> 动态加载对应主题的 cursor 变量 CSS。
 *
 * - 文件位置：packages/web/public/cursors/cursors-{theme}.css（vite 原样 serve）
 * - 首次加载只下当前主题的一份（~7KB gzip）
 * - 切主题时直接换 link.href，浏览器自动 fetch + 解析新文件，:root 变量值刷新
 * - 旧主题 CSS 留在浏览器缓存里，下次切回零开销
 *
 * 跟 composables/useTheme.ts 用同一套 MutationObserver 思路 + HMR 友好。
 */

const LINK_ID = 'quink-theme-cursors';
const HMR_KEY = '__quinkCursorsObserver';
const DEFAULT_THEME = 'blueberry';

function load(theme: string) {
  let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = LINK_ID;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  link.href = `/cursors/cursors-${theme}.css`;

  // 防御 vite dev race / CDN 误 serve：link 加载后若解析出 0 条 CSS 规则，
  // 说明拿到的不是真 CSS（多半是 SPA fallback 的 index.html），加 cache-buster 重拉一次。
  // 重试上限 1 次，避免 CDN 真挂时陷入死循环。
  link.onload = () => {
    queueMicrotask(() => {
      try {
        const ok = link!.sheet && link!.sheet.cssRules.length > 0;
        if (ok) return;
        if ((link as any)._quinkRetried) {
          console.error('[Quink Cursors] cursor CSS still empty after retry; giving up for', theme);
          return;
        }
        (link as any)._quinkRetried = true;
        console.warn('[Quink Cursors] empty stylesheet for', theme, '— retrying once');
        link!.href = `/cursors/cursors-${theme}.css?retry=${Date.now()}`;
      } catch {}
    });
  };
}

const w = window as any;
if (w[HMR_KEY]) {
  try { w[HMR_KEY].disconnect(); } catch {}
}

load(document.documentElement.getAttribute('data-theme') || DEFAULT_THEME);

const observer = new MutationObserver(() => {
  load(document.documentElement.getAttribute('data-theme') || DEFAULT_THEME);
});
observer.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme']
});
w[HMR_KEY] = observer;
