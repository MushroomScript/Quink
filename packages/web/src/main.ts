import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import './style.css';
import './styles/cursors-base.css';
import './styles/loadThemeCursors';
import './composables/useCustomCaret';

const app = createApp(App);
app.use(createPinia());
app.use(router);

// build 后旧页面动态 import 的 chunk hash 变 (旧文件被新 build 删) → 加载 404 → 路由切换卡死 (页面点不动必须手刷).
// 监听 chunk 加载失败 → 自动刷新拿新版. 10s 窗口防 server 真挂时无限刷.
function reloadForNewVersion() {
  const k = 'quink_reload_at';
  if (Date.now() - Number(sessionStorage.getItem(k) || 0) < 10000) return;
  sessionStorage.setItem(k, String(Date.now()));
  window.location.reload();
}
window.addEventListener('vite:preloadError', reloadForNewVersion);
router.onError((err: any) => {
  if (/dynamically imported module|module script failed|Failed to fetch/i.test(err?.message || '')) reloadForNewVersion();
});

// 全局错误捕获，防止白屏
app.config.errorHandler = (err, vm, info) => {
  console.error('[Quink Error]', err, info);
};
window.addEventListener('unhandledrejection', (e) => {
  console.error('[Quink Unhandled]', e.reason);
});

// 即时 mount. 首屏闪烁靠 App.vue 的 showChrome 判空修 (route.name 未 resolve 时不渲染主界面骨架).
// 不用 router.isReady().then 延迟 mount —— 那会打乱 batch bar 的 Teleport defer 首屏挂 #batch-bar-portal 时机, 导致刷新进多选无按钮.
app.mount('#app');

// 实时获取可见视口高度，适配所有移动端浏览器（Safari/Chrome/Firefox）
// window.innerHeight 会自动排除浏览器工具栏、地址栏、底部导航等.
// CSS zoom 修正: html 上有 zoom (Quink "显示比例" 功能) 时, innerHeight 是 zoomed value,
// 把它设到 CSS px 字段会被 zoom 再乘一次, 导致 #app height 是视口的 zoom 倍.
// zoom=1.5 时登录页卡片"快挨着屏幕底端"就是这个 bug. 除以 zoom 还原 unzoomed CSS px
function setAppHeight(zoomOverride?: unknown) {
  // zoom 优先用 applyZoomLevel 切换时传入的确切值 (typeof number); 否则 (resize/orientationchange 触发时传的是 Event)
  // 退回读 inline style.zoom. 关键: 切 CSS zoom 时绝不读 getComputedStyle().zoom — 它的 computed 值更新滞后一帧,
  // setAppHeight 那刻会拿到旧 zoom=1 → --app-height=innerHeight 错, #app 被 zoom 放大顶破视口 → 切换不居中、刷新才对.
  // Electron 端不设 style.zoom (走 setZoomFactor), 读到空 → zoom=1, 此时 innerHeight 已是逻辑值, 正确.
  const zoom = typeof zoomOverride === 'number' ? zoomOverride : (parseFloat(document.documentElement.style.zoom) || 1);
  const cssHeight = window.innerHeight / zoom;
  document.documentElement.style.setProperty('--app-height', `${cssHeight}px`);
}
// 暴露给 App.vue 的 applyZoomLevel 在改 zoom 后调用 (window.innerHeight 不变, 但 zoom 变了要重算)
(window as any).__quink_setAppHeight = setAppHeight;
setAppHeight();
window.addEventListener('resize', setAppHeight);
// 移动端滚动时工具栏显隐也会触发
window.addEventListener('orientationchange', () => { setTimeout(setAppHeight, 100); });

// 兼容 visualViewport API（更精准，键盘弹出时也能适配）
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', setAppHeight);
}
