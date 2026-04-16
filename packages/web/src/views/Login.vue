<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();

const isRegister = ref(false);
const username = ref(localStorage.getItem('quink_last_username') || '');
const password = ref('');
const nickname = ref('');
const error = ref('');
const submitting = ref(false);

async function handleSubmit() {
  error.value = '';
  submitting.value = true;
  try {
    if (isRegister.value) {
      if (!nickname.value.trim()) { error.value = '请输入昵称'; return; }
      await auth.register(username.value, password.value, nickname.value);
    } else {
      await auth.login(username.value, password.value);
    }
    localStorage.setItem('quink_last_username', username.value);
    router.push('/');
  } catch (err: any) {
    error.value = err.message || '操作失败';
  } finally {
    submitting.value = false;
  }
}

function toggleMode() { isRegister.value = !isRegister.value; error.value = ''; }
</script>

<template>
  <div class="login-page min-h-full flex items-center justify-center px-4 relative overflow-hidden">
    <!-- Background glow -->
    <div class="absolute top-1/4 left-1/2 -translate-x-1/2 w-[500px] h-[500px] rounded-full blur-[120px] pointer-events-none" style="background: rgb(var(--c-accent) / 0.15)"></div>

    <div class="w-full max-w-sm relative z-10">
      <div class="text-center mb-8">
        <h1 class="text-4xl font-bold tracking-tight" style="color: rgb(var(--c-accent))">Quink</h1>
        <p class="text-sm mt-2" style="color: var(--sb-dim)">一念 - 记录你的每一个闪念</p>
      </div>

      <div class="login-card rounded-2xl border p-7 shadow-xl">
        <h2 class="text-lg font-semibold mb-5 login-title">
          {{ isRegister ? '创建账号' : '登录' }}
        </h2>

        <form @submit.prevent="handleSubmit" class="space-y-4">
          <div>
            <label class="block text-xs font-medium mb-1.5 login-label">用户名</label>
            <input v-model="username" type="text" required autocomplete="username"
              class="login-input w-full px-4 py-2.5 rounded-xl text-sm outline-none"
              placeholder="请输入用户名" />
          </div>

          <div v-if="isRegister">
            <label class="block text-xs font-medium mb-1.5 login-label">昵称</label>
            <input v-model="nickname" type="text"
              class="login-input w-full px-4 py-2.5 rounded-xl text-sm outline-none"
              placeholder="别人看到的名字" />
          </div>

          <div>
            <label class="block text-xs font-medium mb-1.5 login-label">密码</label>
            <input v-model="password" type="password" required autocomplete="current-password"
              class="login-input w-full px-4 py-2.5 rounded-xl text-sm outline-none"
              placeholder="请输入密码" />
          </div>

          <div v-if="error" class="text-red-500 text-xs bg-red-500/10 rounded-xl px-4 py-2.5 border border-red-500/20">
            {{ error }}
          </div>

          <button type="submit" :disabled="submitting"
            class="w-full py-2.5 text-white text-sm font-medium rounded-xl disabled:opacity-50 transition-all"
            style="background: rgb(var(--c-accent)); box-shadow: 0 4px 12px rgb(var(--c-accent) / 0.25)">
            {{ submitting ? '请稍候...' : isRegister ? '注册' : '登录' }}
          </button>
        </form>

        <div class="mt-5 text-center">
          <button @click="toggleMode" class="text-xs transition-colors login-link">
            {{ isRegister ? '已有账号？去登录' : '没有账号？去注册' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 登录页始终用深色背景，不受主题影响 */
.login-page {
  background: #16161e;
}
.login-card {
  background: rgba(255,255,255,0.06);
  border-color: rgba(255,255,255,0.08);
  backdrop-filter: blur(20px);
}
.login-title { color: rgba(255,255,255,0.9); }
.login-label { color: rgba(255,255,255,0.45); }
.login-input {
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.1);
  color: #fff;
}
.login-input::placeholder { color: rgba(255,255,255,0.25); }
.login-input:focus {
  border-color: rgb(var(--c-accent));
  box-shadow: 0 0 0 2px rgb(var(--c-accent) / 0.15);
}
.login-link { color: rgba(255,255,255,0.35); }
.login-link:hover { color: rgba(255,255,255,0.7); }
</style>
