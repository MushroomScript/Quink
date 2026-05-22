import { ref } from 'vue';

// 全局共享一个 theme ref,跟随 <html data-theme="..."> 属性变化
// MutationObserver 启动一次,永不 disconnect(全局副作用,组件 mount/unmount 无关)
// HMR 友好:模块重载时先清掉旧 observer
const HMR_KEY = '__quinkThemeObserver';
const w = window as any;
if (w[HMR_KEY]) {
  try { w[HMR_KEY].disconnect(); } catch {}
}

const currentTheme = ref(document.documentElement.getAttribute('data-theme') || 'blueberry');

const observer = new MutationObserver(() => {
  const t = document.documentElement.getAttribute('data-theme') || 'blueberry';
  if (t !== currentTheme.value) currentTheme.value = t;
});
observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
w[HMR_KEY] = observer;

export function useTheme() {
  return currentTheme;
}
