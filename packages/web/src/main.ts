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
// window.innerHeight 会自动排除浏览器工具栏、地址栏、底部导航等
function setAppHeight() {
  document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);
}
setAppHeight();
window.addEventListener('resize', setAppHeight);
// 移动端滚动时工具栏显隐也会触发
window.addEventListener('orientationchange', () => { setTimeout(setAppHeight, 100); });

// 兼容 visualViewport API（更精准，键盘弹出时也能适配）
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', setAppHeight);
}
