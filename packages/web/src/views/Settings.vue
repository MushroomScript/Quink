<script setup lang="ts">
import { ref, reactive, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import { api } from '@/api';
import { PhNotePencil } from '@phosphor-icons/vue';
import { collapseLeave, snapshotCards } from '@/utils/cardLeave';

const router = useRouter();
const auth = useAuthStore();
const toast = useToast();

const activeTab = ref('profile');
const saving = ref(false);

// ── Profile ──
const nickname = ref('');
const avatarPreview = ref('');
const uploadingAvatar = ref(false);

// ── Preferences ──
// 偏好统一在一个 reactive 对象，新加字段只需在这里加默认值 + 在模板里加 UI，
// load / save / watch 通过遍历 prefs 字段自动覆盖
const prefs = reactive({
  theme: 'blueberry',
  fontSize: 14,
  autoSummary: true,
  autoSummaryMinLen: 50,
  autoTranscribeVoice: false,
  showTodoBadge: true,
  aiChatMaxTokens: 8192,
  aiPersona: 'concise',
  aiPersonaCustom: '',
  xfyun: { appId: '', apiKey: '', apiSecret: '' },
});
const personas: Record<string, { label: string; description: string }> = {
  concise: { label: '简洁高效', description: '极简回复，一句话说清' },
  friendly: { label: '亲切友好', description: '温暖有礼，像朋友聊天' },
  professional: { label: '专业严谨', description: '条理清晰，结构化输出' },
  humorous: { label: '幽默轻松', description: '风趣幽默，带点调侃' },
  custom: { label: '自定义', description: '自己写人格提示词' },
};

// ── Shortcuts ──
const shortcuts = ref({
  capture: 'Shift+Space',
  aiChat: 'Alt+Space',
  float: 'Alt+Q',
});
const editingShortcut = ref<string | null>(null);
const recordingKeys = ref('');

// ── AI Configs ──
import type { AiConfigItem, AiPromptItem } from '@/api';
const aiConfigs = ref<AiConfigItem[]>([]);
const aiPrompts = ref<Record<string, AiPromptItem>>({});
const aiBindings = ref<Record<string, string>>({});
const editingConfig = ref<Partial<AiConfigItem> | null>(null);
const editingPromptFeature = ref('');
const editingPromptText = ref('');
const testingId = ref('');
const testResult = ref('');
const showApiKey = ref(false);
const configError = ref('');

const aiProviderOptions = [
  { id: 'openai', label: 'OpenAI', defaultModel: '', defaultUrl: 'https://api.openai.com' },
  { id: 'anthropic', label: 'Anthropic', defaultModel: '', defaultUrl: 'https://api.anthropic.com' },
  { id: 'ollama', label: 'Ollama', defaultModel: '', defaultUrl: 'http://localhost:11434' },
  { id: 'custom', label: '自定义 (OpenAI 兼容)', defaultModel: '', defaultUrl: '' },
];

const aiFeatures = [
  { key: 'auto_tag', label: '自动标签' },
  { key: 'auto_classify', label: '自动分类' },
  { key: 'polish', label: 'AI 润色' },
  { key: 'expand', label: 'AI 扩充' },
  { key: 'write', label: 'AI 写文' },
  { key: 'chat', label: 'AI 对话' },
];

async function loadAiData() {
  try {
    const [cfgs, prms] = await Promise.all([api.getAiConfigs(), api.getAiPrompts()]);
    aiConfigs.value = cfgs.data;
    aiPrompts.value = prms.data;
    aiBindings.value = auth.user?.preferences?.aiBindings || {};

    // 如果只有一个配置，自动绑定到所有未绑定的功能
    if (cfgs.data.length === 1) {
      const id = cfgs.data[0].id;
      let changed = false;
      for (const f of aiFeatures) {
        if (!aiBindings.value[f.key]) { aiBindings.value[f.key] = id; changed = true; }
      }
      if (changed) onBindingChange();
    }

    // 默认展示自动标签的提示词
    if (!editingPromptFeature.value) startEditPrompt('auto_tag');
  } catch {}
}

function startEditConfig(cfg?: AiConfigItem) {
  if (cfg) {
    editingConfig.value = { ...cfg };
  } else {
    editingConfig.value = { name: '', provider: 'openai', baseUrl: 'https://api.openai.com', apiKey: '', model: '' };
  }
}

async function saveConfig() {
  configError.value = '';
  if (!editingConfig.value) return;
  if (!editingConfig.value.name?.trim()) { configError.value = '请输入配置名称'; return; }
  if (!editingConfig.value.model?.trim()) { configError.value = '请输入模型名称'; return; }
  if (!editingConfig.value.baseUrl?.trim()) { configError.value = '请输入 API 地址'; return; }
  saving.value = true;
  const { name, provider, baseUrl, apiKey, model } = editingConfig.value;
  const payload = { name: name!, provider: provider!, baseUrl: baseUrl!, apiKey: apiKey || undefined, model: model!, isDefault: false };
  try {
    if (editingConfig.value.id) {
      await api.updateAiConfig(editingConfig.value.id, payload);
    } else {
      await api.createAiConfig(payload as any);
    }
    editingConfig.value = null;
    configError.value = '';
    await loadAiData();
    showMsg('已保存');
  } catch (err: any) { showMsg(typeof err.message === 'string' ? err.message : '保存失败', 'error'); }
  finally { saving.value = false; }
}

async function deleteConfig(id: string) {
  // 乐观更新：立即从 UI 移除触发淡出动画
  aiConfigs.value = aiConfigs.value.filter(c => c.id !== id);
  try {
    await api.deleteAiConfig(id);
  } catch (err) {
    console.error('[Settings] 删除 AI 配置失败', err);
    await loadAiData();
  }
}

// 数据变更前主动 snapshot AI 配置项位置，避免 onLeave 钩子里拿到的是 v-if 切换后的错位坐标
watch(() => aiConfigs.value.length, () => snapshotCards(), { flush: 'sync' });

async function testConfig(id: string) {
  testingId.value = id; testResult.value = '';
  try {
    const r = await api.testAiConfig(id);
    testResult.value = r.data.message;
  } catch (err: any) { testResult.value = err.message; }
  setTimeout(() => { testingId.value = ''; testResult.value = ''; }, 3000);
}

async function onBindingChange() {
  try {
    await auth.updateProfile({ preferences: { ...(auth.user?.preferences || {}), aiBindings: aiBindings.value } });
  } catch {}
}

function startEditPrompt(feature: string) {
  editingPromptFeature.value = feature;
  editingPromptText.value = aiPrompts.value[feature]?.prompt || '';
}

async function savePrompt() {
  if (!editingPromptFeature.value) return;
  saving.value = true;
  try {
    await api.updateAiPrompt(editingPromptFeature.value, editingPromptText.value);
    await loadAiData();
    showMsg('提示词已保存');
  } catch (err: any) { showMsg(err.message, 'error'); }
  finally { saving.value = false; }
}

async function resetPrompt(feature: string) {
  try {
    const r = await api.resetAiPrompt(feature);
    editingPromptText.value = r.data.prompt;
    await loadAiData();
    showMsg('已恢复默认');
  } catch {}
}

const tabs = [
  { id: 'profile', label: '基本信息' },
  { id: 'preferences', label: '偏好设置' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'ai', label: 'AI 模型' },
  { id: 'export', label: '导出' },
  { id: 'about', label: '关于' },
];

onMounted(() => {
  if (auth.user) {
    nickname.value = auth.user.nickname;
    avatarPreview.value = auth.user.avatar || '';
    const userPrefs = auth.user.preferences || {};
    // 白名单：只把 prefs 已声明的字段从 userPrefs 拷过来；xfyun 嵌套对象单独合并避免覆盖默认结构
    for (const k of Object.keys(prefs) as Array<keyof typeof prefs>) {
      const v = (userPrefs as any)[k];
      if (v === undefined) continue;
      if (k === 'xfyun') Object.assign(prefs.xfyun, v);
      else (prefs as any)[k] = v;
    }
    if (userPrefs.shortcuts) {
      shortcuts.value = { ...shortcuts.value, ...userPrefs.shortcuts };
    }
  }
  loadAiData();
  // 延到下一个 tick 再开启 watch,避免初始化赋值触发自动保存
  setTimeout(() => { prefsLoaded = true; }, 0);
});

// ── Avatar upload ──
function triggerAvatarUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/gif,image/webp';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      showMsg('图片大小不能超过 2MB', 'error');
      return;
    }
    uploadingAvatar.value = true;
    try {
      const res = await api.uploadAvatar(file);
      avatarPreview.value = res.data.url;
      await auth.updateProfile({ avatar: res.data.url });
      showMsg('头像已更新');
    } catch (err: any) {
      showMsg('上传失败: ' + err.message, 'error');
    } finally {
      uploadingAvatar.value = false;
    }
  };
  input.click();
}

// ── Shortcut recording ──
function startRecording(key: string) {
  editingShortcut.value = key;
  recordingKeys.value = '';
}

function handleShortcutKeydown(e: KeyboardEvent) {
  if (!editingShortcut.value) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape') {
    editingShortcut.value = null;
    return;
  }

  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  // Windows 上忽略 Meta(Win) 键，避免误触发
  if (e.metaKey && navigator.platform.indexOf('Mac') !== -1) parts.push('Meta');

  const key = e.key;
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
    const displayKey = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
    parts.push(displayKey);

    const combo = parts.join('+');
    (shortcuts.value as any)[editingShortcut.value] = combo;
    editingShortcut.value = null;
  } else {
    recordingKeys.value = parts.join('+') + '+...';
  }
}

// ── Save functions ──
async function saveProfile() {
  saving.value = true;
  try {
    await auth.updateProfile({ nickname: nickname.value });
    showMsg('已保存');
  } catch (err: any) {
    showMsg('保存失败: ' + err.message, 'error');
  } finally {
    saving.value = false;
  }
}

let prefsLoaded = false;

// 拼一份完整 preferences：保留 userPrefs 中未托管的字段（aiBindings、shortcuts 等），prefs 顶层覆盖之
function buildPrefs() {
  return { ...(auth.user?.preferences || {}), ...prefs };
}

async function savePreferences(silent = false) {
  saving.value = true;
  try {
    await auth.updateProfile({ preferences: buildPrefs() });
    document.documentElement.setAttribute('data-theme', prefs.theme);
    localStorage.setItem('quink_theme', prefs.theme);
    try { (window as any).quinkDesktop?.syncTheme?.(prefs.theme); } catch {}
    document.documentElement.style.fontSize = prefs.fontSize + 'px';
    if (!silent) showMsg('已保存');
  } catch (err: any) {
    showMsg('保存失败: ' + err.message, 'error');
  } finally {
    saving.value = false;
  }
}

// 任一字段变化：先乐观更新 auth.user.preferences 让其他组件立即响应，再防抖保存到后端
// watch(reactive对象) 默认 deep，xfyun 等嵌套字段也会触发
let savePrefsTimer: ReturnType<typeof setTimeout> | null = null;
watch(prefs, () => {
  if (!prefsLoaded) return;
  if (auth.user) auth.user.preferences = buildPrefs();
  if (savePrefsTimer) clearTimeout(savePrefsTimer);
  savePrefsTimer = setTimeout(() => savePreferences(true).then(() => toast.show('已保存')), 300);
});

async function saveShortcuts() {
  saving.value = true;
  try {
    await auth.updateProfile({
      preferences: {
        ...(auth.user?.preferences || {}),
        shortcuts: shortcuts.value,
      },
    });
    showMsg('已保存');
    try { (window as any).quinkDesktop?.reloadShortcuts?.(); } catch {}
  } catch (err: any) {
    showMsg('保存失败: ' + err.message, 'error');
  } finally {
    saving.value = false;
  }
}


// ── Password ──
const oldPwd = ref('');
const newPwd = ref('');
const pwdMsg = ref('');

async function changePassword() {
  pwdMsg.value = '';
  if (!oldPwd.value || !newPwd.value) { pwdMsg.value = '请填写完整'; return; }
  if (newPwd.value.length < 6) { pwdMsg.value = '新密码至少6位'; return; }
  saving.value = true;
  try {
    await api.changePassword(oldPwd.value, newPwd.value);
    pwdMsg.value = '密码修改成功';
    oldPwd.value = ''; newPwd.value = '';
  } catch (err: any) { pwdMsg.value = err.message; }
  finally { saving.value = false; }
}

// ── Export / Import ──
const exporting = ref(false);
const importing = ref(false);
const importResult = ref('');

async function handleExport() {
  exporting.value = true;
  try { await api.exportData(); showMsg('导出成功'); } catch (err: any) { showMsg(err.message, 'error'); }
  finally { exporting.value = false; }
}

function triggerImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    importing.value = true;
    importResult.value = '';
    try {
      const res = await api.importData(file);
      importResult.value = `成功导入 ${res.data.imported} 条笔记`;
    } catch (err: any) {
      importResult.value = err.message;
    } finally { importing.value = false; }
  };
  input.click();
}

function applyTheme(t: string) {
  document.documentElement.setAttribute('data-theme', t);
}

function showMsg(msg: string, type: 'success' | 'error' = 'success') {
  toast.show(msg, type === 'error' ? 'error' : 'default');
}

function goBack() {
  router.push('/');
}
</script>

<template>
  <div class="px-4 md:px-8 py-8" @keydown="handleShortcutKeydown">
    <!-- Tabs -->
    <div class="flex flex-wrap gap-1 border-b border-gray-200 mb-6">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        @click="activeTab = tab.id"
        class="px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px whitespace-nowrap"
        :class="activeTab === tab.id
          ? 'border-primary text-primary font-medium'
          : 'border-transparent text-gray-500 hover:text-gray-700'"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- ═══ 基本信息 ═══ -->
    <div v-if="activeTab === 'profile'" class="space-y-6">
      <div class="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <!-- Avatar -->
        <div class="flex items-center gap-5">
          <button @click="triggerAvatarUpload" class="relative group shrink-0" :disabled="uploadingAvatar">
            <div
              v-if="avatarPreview"
              class="w-20 h-20 rounded-full bg-cover bg-center border-2 border-gray-100"
              :style="{ backgroundImage: `url(${avatarPreview})` }"
            />
            <div
              v-else
              class="w-20 h-20 rounded-full bg-primary-light text-primary flex items-center justify-center text-3xl font-bold border-2 border-gray-100"
            >
              {{ nickname ? nickname.charAt(0).toUpperCase() : '?' }}
            </div>
            <!-- Overlay -->
            <div class="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <span v-if="uploadingAvatar" class="text-white text-xs">上传中...</span>
              <span v-else class="text-white text-xs">更换头像</span>
            </div>
          </button>
          <div>
            <div class="text-sm font-medium text-gray-800">{{ nickname || '未设置' }}</div>
            <div class="text-xs text-gray-400">@{{ auth.user?.username }}</div>
            <button @click="triggerAvatarUpload" class="text-xs text-primary hover:underline mt-1">
              {{ avatarPreview ? '更换头像' : '上传头像' }}
            </button>
          </div>
        </div>

        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">昵称</label>
          <input
            v-model="nickname"
            type="text"
            class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary"
          />
        </div>

        <button
          @click="saveProfile"
          :disabled="saving"
          class="px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-dark disabled:opacity-50"
        >
          {{ saving ? '保存中...' : '保存' }}
        </button>
      </div>

      <!-- Change password -->
      <div class="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h3 class="text-sm font-medium text-gray-800">修改密码</h3>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">旧密码</label>
          <input v-model="oldPwd" type="password" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary" />
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">新密码</label>
          <input v-model="newPwd" type="password" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary" placeholder="至少6位" />
        </div>
        <div v-if="pwdMsg" class="text-xs" :class="pwdMsg.includes('成功') ? 'text-green-600' : 'text-red-500'">{{ pwdMsg }}</div>
        <button @click="changePassword" :disabled="saving" class="px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-dark disabled:opacity-50">
          {{ saving ? '修改中...' : '修改密码' }}
        </button>
      </div>
    </div>

    <!-- ═══ 偏好设置 ═══ -->
    <div v-if="activeTab === 'preferences'" class="space-y-6">
      <div class="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-2">主题色</label>
          <div class="flex gap-3">
            <button v-for="t in [
              { value: 'blueberry', label: '蓝莓', color: '#748ffc' },
              { value: 'lavender', label: '薰衣草', color: '#a78bfa' },
              { value: 'mint', label: '薄荷', color: '#5eceac' },
              { value: 'peach', label: '蜜桃', color: '#fc9686' },
              { value: 'lemon', label: '柠檬', color: '#f0be50' },
              { value: 'cloud', label: '云雾', color: '#8ca0b9' },
              { value: 'dark', label: '深色', color: '#1e1e2a' },
            ]" :key="t.value" @click="prefs.theme = t.value; applyTheme(t.value)"
              class="flex flex-col items-center gap-1.5 p-2 rounded-xl border-2 transition-all"
              :class="prefs.theme === t.value ? 'border-gray-800 bg-gray-50' : 'border-transparent hover:bg-gray-50'">
              <div class="w-8 h-8 rounded-full shadow-sm border" :style="{ background: t.color, borderColor: t.value === 'dark' ? '#333' : t.color }"></div>
              <span class="text-[11px] text-gray-600">{{ t.label }}</span>
            </button>
          </div>
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">字体大小</label>
          <select v-model.number="prefs.fontSize" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none">
            <option value="12">12px</option>
            <option value="13">13px</option>
            <option value="14">14px</option>
            <option value="15">15px</option>
            <option value="16">16px（默认）</option>
            <option value="17">17px</option>
            <option value="18">18px</option>
            <option value="20">20px</option>
            <option value="22">22px</option>
          </select>
        </div>
        <!-- 待办未完成数字提示 -->
        <div class="flex items-center justify-between pt-2 border-t border-gray-100">
          <div>
            <div class="text-sm text-gray-700 font-medium">待办未完成数字提示</div>
            <div class="text-xs text-gray-400 mt-0.5">侧边栏「待办」后显示未完成数量的红色徽标</div>
          </div>
          <button @click="prefs.showTodoBadge = !prefs.showTodoBadge"
            class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ml-4"
            :class="prefs.showTodoBadge ? 'bg-primary' : 'bg-gray-300'">
            <span class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
              :class="prefs.showTodoBadge ? 'translate-x-6' : 'translate-x-1'" />
          </button>
        </div>
        <!-- 自动摘要 -->
        <div class="flex items-center justify-between pt-2 border-t border-gray-100">
          <div>
            <div class="text-sm text-gray-700 font-medium">自动摘要</div>
            <div class="text-xs text-gray-400 mt-0.5">新建笔记后 AI 自动生成内容摘要</div>
          </div>
          <button @click="prefs.autoSummary = !prefs.autoSummary"
            class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ml-4"
            :class="prefs.autoSummary ? 'bg-primary' : 'bg-gray-300'">
            <span class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
              :class="prefs.autoSummary ? 'translate-x-6' : 'translate-x-1'" />
          </button>
        </div>
        <div v-if="prefs.autoSummary" class="flex items-center gap-2">
          <span class="text-xs text-gray-400 shrink-0">最少字符数</span>
          <input v-model.number="prefs.autoSummaryMinLen" type="number" min="10" max="500" step="10"
            class="w-20 px-2 py-1 border border-gray-200 rounded-lg text-xs outline-none bg-white text-center" />
          <span class="text-xs text-gray-300">少于此长度不生成摘要</span>
        </div>
        <!-- 讯飞语音识别 -->
        <div class="pt-2 border-t border-gray-100 space-y-2">
          <div class="text-sm text-gray-700 font-medium">语音识别（讯飞）</div>
          <div class="text-xs text-gray-400 mb-1">用于编辑器的语音输入功能，注册 xfyun.cn 获取</div>
          <div class="space-y-1.5">
            <div class="flex items-center gap-2">
              <span class="text-xs text-gray-500 w-16 shrink-0">APPID</span>
              <input v-model="prefs.xfyun.appId" class="flex-1 px-2 py-1.5 border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs text-gray-500 w-16 shrink-0">APIKey</span>
              <input v-model="prefs.xfyun.apiKey" class="flex-1 px-2 py-1.5 border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs text-gray-500 w-16 shrink-0">APISecret</span>
              <input v-model="prefs.xfyun.apiSecret" type="password" class="flex-1 px-2 py-1.5 border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
          </div>
          <!-- 自动转写 -->
          <div class="flex items-center justify-between mt-3">
            <div>
              <div class="text-xs text-gray-600">录音时自动转写文字</div>
              <div class="text-[11px] text-gray-400">开启后录音保存时自动调讯飞转写，AI 对话可引用语音内容</div>
            </div>
            <button @click="prefs.autoTranscribeVoice = !prefs.autoTranscribeVoice"
              class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ml-4"
              :class="prefs.autoTranscribeVoice ? 'bg-primary' : 'bg-gray-300'">
              <span class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
                :class="prefs.autoTranscribeVoice ? 'translate-x-6' : 'translate-x-1'" />
            </button>
          </div>
        </div>

        <!-- AI 对话设置 -->
        <div class="pt-2 border-t border-gray-100 space-y-3">
          <div class="text-sm text-gray-700 font-medium">AI 对话</div>
          <!-- 人格选择 -->
          <div>
            <div class="text-xs text-gray-600 mb-1.5">AI 人格风格</div>
            <div class="grid grid-cols-2 gap-1.5">
              <button v-for="(p, key) in personas" :key="key" @click="prefs.aiPersona = key"
                class="px-3 py-2 rounded-lg text-left text-xs transition-colors border"
                :class="prefs.aiPersona === key ? 'border-primary bg-primary-light text-primary-dark font-medium' : 'border-gray-200 text-gray-500 hover:bg-gray-50'">
                <div class="font-medium">{{ p.label }}</div>
                <div class="text-[11px] mt-0.5 opacity-70">{{ p.description }}</div>
              </button>
            </div>
            <textarea v-if="prefs.aiPersona === 'custom'" v-model="prefs.aiPersonaCustom" rows="3" placeholder="输入自定义人格提示词..."
              class="w-full mt-2 px-3 py-2 border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-primary/30 resize-none" />
          </div>
          <!-- Token 上限 -->
          <div class="flex items-center justify-between">
            <div>
              <div class="text-xs text-gray-600">上下文 Token 上限</div>
              <div class="text-[11px] text-gray-400">越大记住越多对话历史，但消耗更多 Token</div>
            </div>
            <select v-model.number="prefs.aiChatMaxTokens" class="px-2 py-1.5 border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-primary/30">
              <option :value="4096">4K</option>
              <option :value="8192">8K</option>
              <option :value="16384">16K</option>
              <option :value="32768">32K</option>
              <option :value="65536">64K</option>
              <option :value="131072">128K</option>
              <option :value="262144">256K</option>
              <option :value="524288">512K</option>
              <option :value="1048576">1M</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ 快捷键 ═══ -->
    <div v-if="activeTab === 'shortcuts'">
      <div class="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <p class="text-xs text-gray-400 mb-2">点击快捷键区域，然后按下新的组合键来修改</p>

        <div class="space-y-3">
          <!-- Capture shortcut -->
          <div class="flex items-center justify-between py-3 border-b border-gray-50">
            <div>
              <div class="text-sm text-gray-700 font-medium">快速记录</div>
              <div class="text-xs text-gray-400">弹出输入窗口，写下新想法</div>
            </div>
            <button
              @click="startRecording('capture')"
              class="px-3 py-1.5 rounded-lg text-xs font-mono border transition-colors min-w-[140px] text-center"
              :class="editingShortcut === 'capture'
                ? 'border-primary bg-primary-light text-primary animate-pulse'
                : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300'"
            >
              {{ editingShortcut === 'capture' ? (recordingKeys || '按下快捷键...') : shortcuts.capture }}
            </button>
          </div>

          <!-- AI Chat shortcut -->
          <div class="flex items-center justify-between py-3 border-b border-gray-50">
            <div>
              <div class="text-sm text-gray-700 font-medium">AI 对话</div>
              <div class="text-xs text-gray-400">和 AI 对话，搜索你的想法</div>
            </div>
            <button
              @click="startRecording('aiChat')"
              class="px-3 py-1.5 rounded-lg text-xs font-mono border transition-colors min-w-[140px] text-center"
              :class="editingShortcut === 'aiChat'
                ? 'border-primary bg-primary-light text-primary animate-pulse'
                : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300'"
            >
              {{ editingShortcut === 'aiChat' ? (recordingKeys || '按下快捷键...') : shortcuts.aiChat }}
            </button>
          </div>

          <!-- Float shortcut -->
          <div class="flex items-center justify-between py-3 border-b border-gray-50">
            <div>
              <div class="text-sm text-gray-700 font-medium">悬浮窗</div>
              <div class="text-xs text-gray-400">抓取选中文字，弹出操作菜单</div>
            </div>
            <button
              @click="startRecording('float')"
              class="px-3 py-1.5 rounded-lg text-xs font-mono border transition-colors min-w-[140px] text-center"
              :class="editingShortcut === 'float'
                ? 'border-primary bg-primary-light text-primary animate-pulse'
                : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300'"
            >
              {{ editingShortcut === 'float' ? (recordingKeys || '按下快捷键...') : shortcuts.float }}
            </button>
          </div>

          <!-- Fixed shortcuts -->
        </div>

        <button @click="saveShortcuts" :disabled="saving" class="mt-4 px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-dark disabled:opacity-50">
          {{ saving ? '保存中...' : '保存' }}
        </button>
      </div>
    </div>

    <!-- ═══ AI 配置 ═══ -->
    <div v-if="activeTab === 'ai'" class="space-y-6">
      <!-- Config list -->
      <div class="bg-white rounded-xl border border-gray-200 p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-sm font-medium text-gray-800">AI 配置</h3>
          <button @click="startEditConfig()" class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors" style="background: rgb(var(--c-accent) / 0.1); color: rgb(var(--c-accent))">
            + 新增配置
          </button>
        </div>

        <div v-if="aiConfigs.length === 0" class="text-center py-8 text-gray-400 text-sm">
          还没有 AI 配置，点击上方按钮创建
        </div>

        <TransitionGroup tag="div" data-animated-list class="space-y-2" :css="false" @leave="collapseLeave">
          <div v-for="cfg in aiConfigs" :key="cfg.id" class="flex items-center gap-3 p-3 rounded-lg border border-gray-100 hover:border-gray-200 transition-all duration-300">
            <div class="w-2 h-2 rounded-full shrink-0" :class="cfg.isDefault ? 'bg-green-500' : 'bg-gray-300'"></div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-gray-700 truncate">{{ cfg.name }}</div>
              <div class="text-xs text-gray-400">{{ cfg.provider }} · {{ cfg.model }}</div>
            </div>
            <button @click="testConfig(cfg.id)" class="text-xs text-gray-400 hover:text-gray-600 px-2">
              {{ testingId === cfg.id ? (testResult || '测试中...') : '测试' }}
            </button>
            <button @click="startEditConfig(cfg)" class="text-xs text-gray-400 hover:text-gray-600">编辑</button>
            <button @click="deleteConfig(cfg.id)" class="text-xs text-gray-400 hover:text-red-500">删除</button>
          </div>
        </TransitionGroup>

        <!-- Edit/Create form -->
        <div v-if="editingConfig" class="mt-4 p-4 rounded-lg border border-gray-200 bg-gray-50 space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs text-gray-500 mb-1">名称</label>
              <input v-model="editingConfig.name" class="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary" placeholder="如：GPT-5.4-nano 标签用" />
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">服务商</label>
              <select v-model="editingConfig.provider" @change="() => {
                const p = aiProviderOptions.find(x => x.id === editingConfig!.provider);
                if (p) { editingConfig!.baseUrl = p.defaultUrl; editingConfig!.model = p.defaultModel; }
              }" class="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none">
                <option v-for="p in aiProviderOptions" :key="p.id" :value="p.id">{{ p.label }}</option>
              </select>
            </div>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">API 地址</label>
            <input v-model="editingConfig.baseUrl" class="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary font-mono" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs text-gray-500 mb-1">API Key</label>
              <div class="relative">
                <input v-model="editingConfig.apiKey" :type="showApiKey ? 'text' : 'password'" placeholder="sk-..." class="w-full px-3 py-1.5 pr-8 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary font-mono" />
                <button @click="showApiKey = !showApiKey" type="button" class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs">
                  {{ showApiKey ? '🙈' : '👁' }}
                </button>
              </div>
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">模型</label>
              <input v-model="editingConfig.model" class="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary font-mono" />
            </div>
          </div>
          <div v-if="configError" class="text-red-500 text-xs bg-red-50 rounded-lg px-3 py-2">{{ configError }}</div>
          <div class="flex gap-2">
            <button @click="saveConfig" :disabled="saving" class="px-4 py-1.5 text-white text-xs font-medium rounded-lg disabled:opacity-50" style="background: rgb(var(--c-accent))">
              {{ saving ? '保存中...' : '保存' }}
            </button>
            <button @click="editingConfig = null; configError = ''" class="px-4 py-1.5 text-xs text-gray-500 rounded-lg hover:bg-gray-100">取消</button>
          </div>
        </div>
      </div>

      <!-- Feature bindings -->
      <div class="bg-white rounded-xl border border-gray-200 p-6">
        <h3 class="text-sm font-medium text-gray-800 mb-4">功能绑定</h3>
        <p class="text-xs text-gray-400 mb-4">为每个 AI 功能选择使用哪个配置，选择后自动保存</p>
        <div class="space-y-3">
          <div v-for="f in aiFeatures" :key="f.key" class="flex items-center justify-between">
            <span class="text-sm text-gray-600">{{ f.label }}</span>
            <select v-model="aiBindings[f.key]" @change="onBindingChange" class="w-48 px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none">
              <option v-if="aiConfigs.length === 0" value="" disabled>请先创建 AI 配置</option>
              <option v-for="cfg in aiConfigs" :key="cfg.id" :value="cfg.id">{{ cfg.name }}</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Prompts -->
      <div class="bg-white rounded-xl border border-gray-200 p-6">
        <h3 class="text-sm font-medium text-gray-800 mb-4">提示词</h3>
        <div class="flex gap-1 mb-4 flex-wrap">
          <button v-for="f in aiFeatures" :key="f.key" @click="startEditPrompt(f.key)"
            class="px-3 py-1.5 rounded-lg text-xs transition-colors"
            :class="editingPromptFeature === f.key ? 'bg-primary-light text-primary-dark font-medium' : 'text-gray-500 hover:bg-gray-100'">
            {{ f.label }}
            <span v-if="aiPrompts[f.key]?.isCustom" class="ml-1 text-[10px]">*</span>
          </button>
        </div>
        <div v-if="editingPromptFeature">
          <textarea v-model="editingPromptText" rows="8" spellcheck="false"
            class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs leading-relaxed outline-none focus:border-primary font-mono resize-none text-gray-600" />
          <p class="text-xs text-gray-400 mt-1">用 {content} 表示笔记内容，{context} 表示上下文</p>
          <div class="flex gap-2 mt-3">
            <button @click="savePrompt" :disabled="saving" class="px-4 py-1.5 text-white text-xs font-medium rounded-lg disabled:opacity-50" style="background: rgb(var(--c-accent))">
              {{ saving ? '保存中...' : '保存' }}
            </button>
            <button @click="resetPrompt(editingPromptFeature)" class="px-4 py-1.5 text-xs text-gray-500 rounded-lg hover:bg-gray-100">恢复默认</button>
          </div>
        </div>
        <div v-else class="text-center py-6 text-gray-400 text-xs">点击上方功能标签查看和编辑提示词</div>
      </div>
    </div>

    <!-- ═══ 导出 ═══ -->
    <div v-if="activeTab === 'export'" class="space-y-6">
      <!-- Export -->
      <div class="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h3 class="text-sm font-medium text-gray-800">数据导出</h3>
        <p class="text-sm text-gray-500">将所有笔记导出为 Markdown 文件 + 附件，打包成 ZIP。</p>
        <button @click="handleExport" :disabled="exporting"
          class="px-4 py-2 text-sm font-medium rounded-lg transition-colors" style="background: rgb(var(--c-accent) / 0.1); color: rgb(var(--c-accent))">
          {{ exporting ? '导出中...' : '导出 ZIP' }}
        </button>
      </div>
      <!-- Import -->
      <div class="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h3 class="text-sm font-medium text-gray-800">数据导入</h3>
        <p class="text-sm text-gray-500">从之前导出的 ZIP 文件恢复笔记。</p>
        <button @click="triggerImport" :disabled="importing"
          class="px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          style="background: rgb(var(--c-accent) / 0.1); color: rgb(var(--c-accent))">
          {{ importing ? '导入中...' : '选择 ZIP 文件导入' }}
        </button>
        <p v-if="importResult" class="text-xs" :class="importResult.startsWith('成功') ? 'text-green-600' : 'text-red-500'">{{ importResult }}</p>
      </div>
    </div>

    <!-- ═══ 关于 ═══ -->
    <div v-if="activeTab === 'about'">
      <div class="bg-white rounded-xl border border-gray-200 p-8 max-w-md mx-auto">
        <div class="text-center mb-6">
          <div class="w-16 h-16 rounded-2xl mx-auto mb-3 flex items-center justify-center" style="background: rgb(var(--c-accent-light)); color: rgb(var(--c-accent-dark))">
            <PhNotePencil size="2.25rem" weight="fill" />
          </div>
          <h3 class="text-2xl font-bold" style="color: rgb(var(--c-accent-dark))">Quink</h3>
          <p class="text-gray-500 text-sm mt-1">一念 · Quick Think</p>
          <p class="text-xs text-gray-400 mt-1">v0.1.0</p>
        </div>

        <div class="space-y-3 text-sm text-gray-500 mb-6">
          <p class="text-center">按下快捷键，闪电记录脑中闪念</p>
          <p class="text-center">AI 自动归类总结，随时回顾</p>
        </div>

        <div class="border-t border-gray-100 pt-4">
          <div class="flex justify-between text-xs">
            <span class="text-gray-400">技术栈</span>
            <span class="text-gray-500">Electron + Vue 3 + Hono + SQLite</span>
          </div>
        </div>

        <p class="text-center text-[10px] text-gray-300 mt-6">Made with ❤️ by Mushroom</p>
      </div>
    </div>
  </div>
</template>
