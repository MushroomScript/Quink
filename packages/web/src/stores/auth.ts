import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api, setToken, isLoggedIn, resetRedirectFlag, type User } from '@/api';

// Electron 桌面端注入的接口
declare global {
  interface Window {
    quinkDesktop?: {
      syncToken: (token: string | null) => void;
      reloadShortcuts: () => void;
    };
  }
}

function syncTokenToDesktop(token: string | null) {
  // 双层 optional chaining: `?.syncToken?.()` 防止 quinkDesktop truthy 但 syncToken undefined 触发
  // TypeError → fetchMe catch 把 user 设 null → "请先登录" 假象 (preload.ts 历史踩过). 现在
  // shortcut preload 也注入了 syncToken no-op 不会出问题, 但 ?.()  保险防未来类似 footgun.
  window.quinkDesktop?.syncToken?.(token);
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const loading = ref(false);

  const loggedIn = computed(() => !!user.value);
  const nickname = computed(() => user.value?.nickname || '');
  const avatar = computed(() => user.value?.avatar || '');

  async function register(username: string, password: string, nickname: string) {
    const res = await api.register({ username, password, nickname });
    setToken(res.data.token);
    resetRedirectFlag();
    syncTokenToDesktop(res.data.token);
    user.value = res.data.user;
    return res.data.user;
  }

  async function login(username: string, password: string) {
    const res = await api.login({ username, password });
    setToken(res.data.token);
    resetRedirectFlag();
    syncTokenToDesktop(res.data.token);
    user.value = res.data.user;
    return res.data.user;
  }

  async function fetchMe() {
    if (!isLoggedIn()) return null;
    loading.value = true;
    try {
      const res = await api.getMe();
      user.value = res.data;
      const token = localStorage.getItem('quink_token');
      syncTokenToDesktop(token);
      return res.data;
    } catch (err: any) {
      user.value = null;
      // 只在认证失败时清 token，网络错误/请求取消不清
      if (err.message === '未登录' || err.message === '登录已过期') {
        setToken(null);
        syncTokenToDesktop(null);
      }
      return null;
    } finally {
      loading.value = false;
    }
  }

  async function updateProfile(data: { nickname?: string; avatar?: string; preferences?: Record<string, any> }) {
    const res = await api.updateProfile(data);
    // mutate 保引用: 之前整体替换 user.value = res.data 会让所有 watch user 的组件重跑 (实测改 zoom
    // 500ms 后 data-theme 都被 setAttribute 一次同值无视觉但走 Vue diff). Object.assign 同字段 in-place
    // 更新, Vue 仍能追踪到字段变化但保留对象引用, 依赖 user 引用稳定的 computed/watch 不再误触发.
    // null 防御: updateProfile 一般在已登录状态调, user.value 应不为 null, 但万一是 null 走整体赋值兜底.
    if (user.value) Object.assign(user.value, res.data);
    else user.value = res.data;
    // 如果更新了快捷键，通知桌面端重新注册. 双层 ?. 同 syncTokenToDesktop, 防 truthy + undefined 抛错
    if (data.preferences?.shortcuts) {
      window.quinkDesktop?.reloadShortcuts?.();
    }
    return res.data;
  }

  function logout() {
    user.value = null;
    setToken(null);
    syncTokenToDesktop(null);
  }

  return { user, loading, loggedIn, nickname, avatar, register, login, fetchMe, updateProfile, logout };
});
