import { ref, onUnmounted } from 'vue';

// 全局每 30s tick 一次的 now ref. 用于"已过"/"今天"/"几分钟前"等相对时间显示.
// 30s 间隔: 让"今天 09:30" 在 09:31 时及时变"已过"; 1s 太频繁触发不必要的卡片重渲染.
// 单例 + 引用计数: 多个组件 useNow() 共用一个 timer, 全部 unmount 后才停 timer.
const _now = ref(Date.now());
let _interval: ReturnType<typeof setInterval> | null = null;
let _refs = 0;

function ensureTicking() {
  if (_interval) return;
  _interval = setInterval(() => { _now.value = Date.now(); }, 30_000);
}

function stopTicking() {
  if (_interval && _refs === 0) {
    clearInterval(_interval);
    _interval = null;
  }
}

export function useNow() {
  _refs++;
  ensureTicking();
  onUnmounted(() => {
    _refs--;
    if (_refs === 0) stopTicking();
  });
  return _now;
}
