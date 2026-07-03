<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { api, isLoggedIn } from '@/api';
import {
  PhCheck,
  PhNotePencil,
  PhSparkle,
  PhTranslate,
} from '@phosphor-icons/vue';

const auth = useAuthStore();
// Windows: 窗口去 transparent + native 裁药丸 (避 inactive caption), 窗口=胶囊尺寸无 padding, 投影交给系统;
// Mac: 保持 transparent 药丸 + CSS padding/投影 (Mac 不画 caption)
const isWin = /Win/i.test(navigator.userAgent);
const text = ref('');
const processing = ref(false);
const saved = ref(false);
const savedMsg = ref(''); // saved 态在对勾后显示的一句话提示
const savedCheck = ref(true); // 是否显示对勾: 即时完成 (灵感/笔记/复制) 显示; AI整理是后台处理不显示

onMounted(async () => {
  // 注入透明样式,压过全局 body/--c-body 背景
  const style = document.createElement('style');
  style.textContent = 'html,body,#app{background:transparent !important;overflow:hidden !important;}';
  document.head.appendChild(style);
  await auth.fetchMe();
  // 跟主窗口一样,根据用户偏好设置主题
  const theme = auth.user?.preferences?.theme || 'blueberry';
  document.documentElement.setAttribute('data-theme', theme);
  const params = new URLSearchParams(window.location.search);
  text.value = params.get('text') || '';
  // 持久窗口: 后续每次唤出靠 IPC 传新选中文字 (不重新 loadURL), 更新 text + 重置上次操作残留状态
  try {
    (window as any).quink?.onFloatText?.((newText: string) => {
      text.value = newText || '';
      saved.value = false;
      processing.value = false;
      savedMsg.value = '';
      savedCheck.value = true;
    });
  } catch {}
  // 持久窗口 show 后 focus float-outer: 收 Esc + 让"失焦自动隐藏"生效 (要先获焦点才有 blur);
  // 且 Win32 foreground lock 下 renderer DOM focus 帮 OS 把焦点带过来 (见 desktop CLAUDE.md)
  const focusOuter = () => setTimeout(() => (document.querySelector('.float-outer') as HTMLElement)?.focus(), 50);
  focusOuter();
  try { (window as any).quink?.onWindowShown?.(focusOuter); } catch {}
});

async function addAsNote() {
  if (!text.value.trim() || !isLoggedIn()) return;
  processing.value = true;
  try {
    // 笔记字段值 'note'
    await api.createNote({ content: text.value, type: 'note', category: '笔记' });
    savedMsg.value = '已存为笔记';
    saved.value = true;
    setTimeout(() => hideWindow(), 900);
  } catch {}
  processing.value = false;
}

async function aiOrganize() {
  if (!text.value.trim() || !isLoggedIn()) return;
  processing.value = true;
  try {
    // AI 整理: 直接存成笔记, 后端后台按精简提示词处理 content 再回填 (simplifyContent 触发)
    await api.createNote({ content: text.value, type: 'note', simplifyContent: true });
    savedCheck.value = false; // 后台处理不是即时完成, 不显示对勾
    savedMsg.value = '已提交后台整理';
    saved.value = true;
    setTimeout(() => hideWindow(), 900);
  } catch {}
  processing.value = false;
}

// 按中文字符占比自动判语向: 中文过半 → 翻成英文, 否则 → 翻成中文
function detectTargetLang(s: string): string {
  const zh = (s.match(/[一-鿿]/g) || []).length;
  const nonSpace = s.replace(/\s/g, '').length;
  return nonSpace > 0 && zh / nonSpace > 0.5 ? '英语' : '中文';
}

function translate() {
  if (!text.value.trim() || !isLoggedIn()) return;
  // 不在悬浮窗转圈: 点了直接开翻译窗口 (译文留空), 由窗口内译文区转圈 + 发起翻译.
  // 前端只负责自动判初始语向 (中文占比), 译文交给窗口翻
  const target = detectTargetLang(text.value);
  openTranslateResult(text.value, '', target);
  hideWindow();
}

function openTranslateResult(original: string, translated: string, lang: string) {
  try { (window as any).quink?.openTranslateResult(original, translated, lang); } catch {}
}

function hideWindow() {
  try { (window as any).quink?.hideWindow(); } catch {}
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') hideWindow();
}
</script>

<template>
  <div class="float-outer" :class="{ win: isWin }" @keydown="onKeydown" tabindex="0">
    <div class="float-bar">

    <!-- Processing -->
    <div v-if="processing" class="float-state">
      <span class="spinner" />
    </div>

    <!-- Saved -->
    <div v-else-if="saved" class="float-state saved">
      <PhCheck v-if="savedCheck" size="0.8125rem" weight="fill" />
      <span v-if="savedMsg">{{ savedMsg }}</span>
    </div>

    <!-- Icons + text -->
    <div v-else class="float-group">
      <button @click="addAsNote" class="float-btn" title="笔记">
        <PhNotePencil size="0.8125rem" weight="fill" />
        <span>笔记</span>
      </button>
      <div class="float-divider" />
      <button @click="aiOrganize" class="float-btn" title="AI 整理">
        <PhSparkle size="0.8125rem" weight="fill" />
        <span>AI整理</span>
      </button>
      <div class="float-divider" />
      <button @click="translate" class="float-btn" title="翻译">
        <PhTranslate size="0.8125rem" weight="fill" />
        <span>翻译</span>
      </button>
    </div>
    </div>
  </div>
</template>

<style scoped>
.float-outer {
  height: 100%;
  padding: 10px;
  display: flex;
  outline: none;
  user-select: none;
  -webkit-app-region: drag;
}
.float-bar {
  flex: 1;
  display: flex;
  align-items: stretch;
  background: rgb(var(--c-sidebar));
  border-radius: 999px;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.16), 0 0 0 1px rgba(0, 0, 0, 0.05);
  overflow: hidden;
}
/* Windows: 窗口撑满 (无投影留白) + Win11 系统圆角管外形, float-bar 自己不要圆角/投影.
   float-bar 若留 999px 胶囊圆角: 平时跟窗口同色看不出, 但 hover 高亮会被胶囊圆角裁出胶囊弧 → 必须归零 */
.float-outer.win { padding: 0; }
.float-outer.win .float-bar { box-shadow: none; border-radius: 0; }
.float-btn:focus,
.float-btn:focus-visible {
  outline: none;
}

.float-group {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  width: 100%;
  height: 100%;
}

.float-btn {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--sb-dim);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0;
  white-space: nowrap;
  cursor: var(--cur-pointer), pointer;
  transition: background 0.12s ease, color 0.12s ease;
  -webkit-app-region: no-drag;
}
.float-btn:hover {
  background: var(--sb-active-bg);
  color: var(--sb-active-text);
}
.float-btn:active {
  background: var(--sb-active-bg);
  color: var(--sb-active-text);
}
.float-btn:disabled { opacity: 0.4; cursor: var(--cur-not-allowed), not-allowed; }
.float-btn svg { flex-shrink: 0; }

.float-divider {
  width: 1px;
  margin: 6px 0;
  background: var(--sb-hover);
  flex-shrink: 0;
}

.float-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: 100%;
  color: var(--sb-dim);
  font-size: 12px;
}
.float-state.saved { color: var(--sb-active-text); }

.spinner {
  width: 12px; height: 12px;
  border: 2px solid var(--sb-hover);
  border-top-color: var(--sb-dim);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
