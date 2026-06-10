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

// 全局错误捕获，防止白屏
app.config.errorHandler = (err, vm, info) => {
  console.error('[Quink Error]', err, info);
};
window.addEventListener('unhandledrejection', (e) => {
  console.error('[Quink Unhandled]', e.reason);
});

app.mount('#app');

// 实时获取可见视口高度，适配所有移动端浏览器（Safari/Chrome/Firefox）
// window.innerHeight 会自动排除浏览器工具栏、地址栏、底部导航等.
// CSS zoom 修正: html 上有 zoom (Quink "显示比例" 功能) 时, innerHeight 是 zoomed value,
// 把它设到 CSS px 字段会被 zoom 再乘一次, 导致 #app height 是视口的 zoom 倍.
// zoom=1.5 时登录页卡片"快挨着屏幕底端"就是这个 bug. 除以 zoom 还原 unzoomed CSS px
function setAppHeight() {
  const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
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
