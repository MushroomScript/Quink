<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/api';
import { PhCopy, PhCheck, PhX } from '@phosphor-icons/vue';

const auth = useAuthStore();
const original = ref('');
const translated = ref('');
const targetLang = ref('中文');
const copied = ref(false);
const retranslating = ref(false);

const langOptions = ['中文', '英语', '日语', '韩语', '法语', '德语', '俄语', '西班牙语', '葡萄牙语', '意大利语', '阿拉伯语'];

onMounted(async () => {
  const params = new URLSearchParams(window.location.search);
  original.value = params.get('o') || '';
  translated.value = params.get('t') || '';
  targetLang.value = params.get('lang') || '中文';
  // 主题跟随: main 创建窗口时已按 currentTheme 设了 backgroundColor 防闪, 这里设 data-theme 让 CSS 变量生效
  // 译文为空 (float 直接开窗没预翻) → 立即发起翻译, 译文区转圈 (不等 fetchMe, 并行走)
  if (!translated.value && original.value.trim()) doTranslate(targetLang.value);
  await auth.fetchMe();
  const theme = auth.user?.preferences?.theme || 'blueberry';
  document.documentElement.setAttribute('data-theme', theme);
});

// 发起翻译 (窗口打开自动翻 / 二次选语言重翻共用). translate feature + targetLang 参数.
// aiProcess 已切流式 (commit 33d77cf), 用 onDelta 增量拼到 translated 让用户看到打字机效果
async function doTranslate(lang: string) {
  if (!original.value.trim() || retranslating.value) return;
  retranslating.value = true;
  translated.value = '';
  try {
    translated.value = await api.aiProcess('translate', original.value, undefined, lang, (chunk) => {
      translated.value += chunk;
    });
  } catch (err: any) {
    translated.value = '翻译失败：' + (err?.message || '未知错误');
  }
  retranslating.value = false;
}

// 二次选语言: 用原文重新翻成新目标语言
function onLangChange(e: Event) {
  const lang = (e.target as HTMLSelectElement).value;
  if (lang === targetLang.value || retranslating.value) return;
  targetLang.value = lang;
  doTranslate(lang);
}

async function copyTranslated() {
  if (!translated.value) return;
  try {
    await navigator.clipboard.writeText(translated.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch {}
}

function close() {
  try { (window as any).quink?.hideWindow(); } catch {}
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}
</script>

<template>
  <div class="tr-root" @keydown="onKeydown" tabindex="0">
    <!-- 顶部: 标题(可拖) + 目标语言下拉 + 复制/关闭 -->
    <div class="tr-header">
      <span class="tr-title">翻译</span>
      <div class="tr-actions">
        <select class="tr-lang" :value="targetLang" @change="onLangChange" :disabled="retranslating" title="翻译成">
          <option v-for="l in langOptions" :key="l" :value="l">{{ l }}</option>
        </select>
        <button class="tr-btn" @click="copyTranslated" title="复制译文">
          <PhCheck v-if="copied" size="0.875rem" weight="bold" />
          <PhCopy v-else size="0.875rem" weight="fill" />
          <span>{{ copied ? '已复制' : '复制' }}</span>
        </button>
        <button class="tr-btn tr-close" @click="close" title="关闭 (Esc)">
          <PhX size="0.875rem" weight="bold" />
        </button>
      </div>
    </div>
    <!-- 左右对照 -->
    <div class="tr-body">
      <div class="tr-pane">
        <div class="tr-pane-label">原文</div>
        <div class="tr-text">{{ original }}</div>
      </div>
      <div class="tr-divider" />
      <div class="tr-pane">
        <div class="tr-pane-label">译文</div>
        <div class="tr-text">
          <span v-if="retranslating" class="tr-spinner" />
          <template v-else>{{ translated }}</template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tr-root {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: rgb(var(--c-body));
  outline: none;
  overflow: hidden;
  -webkit-app-region: drag;
}
.tr-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgb(var(--c-accent) / 0.12);
  flex-shrink: 0;
}
.tr-title { font-size: 13px; font-weight: 600; color: var(--sb-text); }
.tr-actions { display: flex; align-items: center; gap: 8px; -webkit-app-region: no-drag; }
.tr-lang {
  padding: 5px 8px;
  border: 1px solid rgb(var(--c-accent) / 0.25);
  border-radius: 8px;
  background: rgb(var(--c-accent-light));
  color: rgb(var(--c-accent-dark));
  font-size: 12px; font-weight: 500;
  cursor: var(--cur-pointer), pointer;
  outline: none;
}
.tr-lang:disabled { opacity: 0.5; cursor: var(--cur-not-allowed), not-allowed; }
.tr-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 12px; border: none; border-radius: 8px;
  background: rgb(var(--c-accent-light)); color: rgb(var(--c-accent-dark));
  font-size: 12px; font-weight: 500; white-space: nowrap;
  cursor: var(--cur-pointer), pointer;
  transition: background 0.12s ease;
}
.tr-btn:hover { background: rgb(var(--c-accent) / 0.2); }
.tr-close { background: transparent; color: var(--sb-dim); padding: 5px 8px; }
.tr-close:hover { background: rgb(var(--c-accent) / 0.1); color: rgb(var(--c-accent-dark)); }
.tr-body {
  flex: 1; display: flex; min-height: 0;
  -webkit-app-region: no-drag;
}
.tr-pane {
  flex: 1; display: flex; flex-direction: column; min-width: 0;
  padding: 12px 16px;
}
.tr-pane-label {
  font-size: 11px; color: var(--sb-dim); margin-bottom: 6px; flex-shrink: 0;
  user-select: none;
}
.tr-spinner {
  display: inline-block;
  width: 18px; height: 18px;
  border: 2px solid rgb(var(--c-accent) / 0.2);
  border-top-color: rgb(var(--c-accent-dark));
  border-radius: 50%;
  animation: tr-spin 0.7s linear infinite;
}
@keyframes tr-spin { to { transform: rotate(360deg); } }
.tr-text {
  flex: 1; overflow-y: auto;
  font-size: 13px; line-height: 1.7; color: var(--sb-text);
  white-space: pre-wrap; word-break: break-word;
  user-select: text;
}
.tr-divider { width: 1px; background: rgb(var(--c-accent) / 0.12); flex-shrink: 0; }
</style>
