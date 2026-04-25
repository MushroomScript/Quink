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
  window.quinkDesktop?.syncToken(token);
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
    user.value = res.data;
    // 如果更新了快捷键，通知桌面端重新注册
    if (data.preferences?.shortcuts) {
      window.quinkDesktop?.reloadShortcuts();
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
