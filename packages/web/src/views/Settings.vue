<script setup lang="ts">
import { ref, reactive, onMounted, watch, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useSseSync } from '@/utils/sseSync';
import { useNotesStore } from '@/stores/notes';
import { useToast } from '@/composables/useToast';
import { api } from '@/api';
import { collapseLeave, snapshotCards } from '@/utils/cardLeave';
import { useTheme } from '@/composables/useTheme';
import { useEscToClose } from '@/composables/useEscToClose';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import CustomSelect from '@/components/CustomSelect.vue';
import DatePicker from '@/components/DatePicker.vue';
import { resolveFileUrl, resolveFileThumbUrl, thumbErrorFallback } from '@/utils/fileUrl';
import { getCardWidthPref, setCardWidthPref, type CardWidthMode } from '@/utils/cardWidth';
import dayjs from 'dayjs';

const router = useRouter();
const auth = useAuthStore();
const notesStore = useNotesStore();
const toast = useToast();
const currentTheme = useTheme();

const activeTab = ref('profile');
const saving = ref(false);

// ── Profile ──
const nickname = ref('');
const avatarPreview = ref('');
const uploadingAvatar = ref(false);

// 下载目录 (本地配置, 不进 prefs 走 server preferences 因为 path 是设备本地的).
// 手机/网页端没有 quinkDesktop, 整块隐藏.
const isElectron = !!(window as any).quinkDesktop?.isElectron;
const downloadDir = ref<string>(localStorage.getItem('quink_download_dir') || '');
const defaultDownloadDir = ref<string>('');
async function pickDownloadDir(): Promise<void> {
  const desk = (window as any).quinkDesktop;
  if (!desk?.pickDirectory) return;
  const picked = await desk.pickDirectory();
  if (!picked) return;
  downloadDir.value = picked;
  localStorage.setItem('quink_download_dir', picked);
  desk.syncDownloadPath?.(picked);
}
function resetDownloadDir(): void {
  const desk = (window as any).quinkDesktop;
  downloadDir.value = '';
  localStorage.removeItem('quink_download_dir');
  // 路径为空时 main 端 currentDownloadDir 用默认 app.getPath('downloads'), 这里推空字符串 main 会忽略
  // 改成主动推默认路径让 main 立刻切换
  if (defaultDownloadDir.value) desk?.syncDownloadPath?.(defaultDownloadDir.value);
}

// ── Preferences ──
// 偏好统一在一个 reactive 对象，新加字段只需在这里加默认值 + 在模板里加 UI，
// load / save / watch 通过遍历 prefs 字段自动覆盖
const prefs = reactive({
  theme: 'blueberry',
  zoomLevel: 100,
  autoTag: true,
  autoCategorize: true,
  autoSummary: true,
  autoSummaryMinLen: 200,
  autoTranscribeVoice: false,
  showTodoBadge: true,
  trashRetentionDays: 30,
  // 笔记列表排序字段: created (默认, 按创建时间) / updated (按最后编辑时间).
  // 改后 store watch(sortBy) 清各 view 缓存, 切回 view 时 onActivated 走 reset 拉新顺序
  notesSortBy: 'created' as 'created' | 'updated',
  // 群组共享笔记可见范围 (3 主 view 灵感/笔记/待办). 私密笔记始终显示, 此偏好仅控制
  // 主页面纳入哪些群组共享笔记, 映射到 vs.scope:
  //   own     = 仅我发布的群组共享笔记 (= mine scope, private + 我分享出去的 shared, 默认, 跟历史行为一致)
  //   others  = 仅他人发布的群组共享笔记 (= others_shared scope, 我的 private + 他人分享给我的, 我的 shared 被过滤)
  //   none    = 群组共享笔记全部隐藏 (= private scope, 仅 private)
  //   all     = 群组共享笔记全部显示 (= all scope, private + 我分享的 + 他人分享的)
  sharedDisplay: 'own' as 'own' | 'others' | 'none' | 'all',
  aiChatMaxTokens: 8192,
  aiPersona: 'concise',
  aiPersonaCustom: '',
  xfyun: { appId: '', apiKey: '', apiSecret: '' },
});
// 文本/数字输入框: 本地 ref + @blur 比对真变了才写回 prefs.
// 否则 v-model 直绑 prefs.xxx → 输入过程每个字符都触发 watch deep → 防抖保存 → 频繁后端请求 + 频繁 toast.
// 失焦时若 local !== prefs[key] 才写回, 触发原 watch 走防抖保存路径. 同步是单向 prefs → local, 只在 onMounted 拷完字段后做一次.
const localXfyunAppId = ref('');
const localXfyunApiKey = ref('');
const localXfyunApiSecret = ref('');
const localAiPersonaCustom = ref('');
// 卡片最小宽度本地偏好 (localStorage 不跨账号). onMounted 读 + 改完调 saveCardWidth 触发 useMasonry 重算
const cardWidth = reactive<{ mode: CardWidthMode; value: number }>({ mode: 'px', value: 320 });
// 像素档位 220-500 步长 10 (共 29 项), 百分比档位 10-50 步长 5 (共 9 项). 下拉而非 input (光标问题)
const cardWidthPxOptions = Array.from({ length: 29 }, (_, i) => ({ value: 220 + i * 10, label: `${220 + i * 10} px` }));
const cardWidthPctOptions = Array.from({ length: 9 }, (_, i) => {
  const v = 10 + i * 5;
  return { value: v, label: `${v}% (≈ ${Math.max(1, Math.floor(100 / v))} 列)` };
});
function saveCardWidth() {
  setCardWidthPref({ mode: cardWidth.mode, value: Math.max(1, Math.round(cardWidth.value || 1)) });
}
const localAutoSummaryMinLen = ref(200);
// 模板里 ref 自动 unwrap, 所以第一参数收到的是值不是 ref 本身
function commitField(value: any, target: any, key: string) {
  if (value !== target[key]) target[key] = value;
}

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

// ── Reminder Channels ──
import type { ReminderChannel, ReminderChannelType } from '@/api';
import { NOTIFICATION_GROUPS, ALL_NOTIFICATION_TYPES, TOTAL_UI_TYPE_COUNT, countSelectedUiTypes, metaTypes, type NotificationTypeMeta } from '@/utils/notificationTypes';
const reminderChannels = ref<ReminderChannel[]>([]);
// 加 selectedTypes 通知类型白名单. UI 内部按数组管, 保存时全选 → 写 null (兼容老 row + 全收语义)
const editingChannel = ref<{ id?: string; type: ReminderChannelType; name: string; config: Record<string, any>; enabled: boolean; selectedTypes: string[] } | null>(null);
const expandedTypeCategories = ref<Set<string>>(new Set(['reminder', 'content', 'group'])); // 默认全展开
const channelError = ref('');
const testingChannelId = ref<string | null>(null);
const browserPermission = ref<NotificationPermission>(typeof Notification !== 'undefined' ? Notification.permission : 'denied');

const channelTypeOptions: Array<{ id: ReminderChannelType; label: string; description: string }> = [
  { id: 'browser', label: '浏览器 / Electron', description: '应用打开时弹系统通知' },
  { id: 'email', label: '邮件 (SMTP)', description: '通过 SMTP 发邮件' },
  { id: 'bark', label: 'Bark (iOS)', description: 'iOS 个人推送, 仅 App Store 提供, 无安卓版' },
  { id: 'wecom_bot', label: '企业微信机器人', description: '群机器人 webhook' },
  { id: 'dingtalk_bot', label: '钉钉机器人', description: '群机器人 webhook (可选加签)' },
  { id: 'feishu_bot', label: '飞书机器人', description: '群机器人 webhook (可选加签)' },
  { id: 'telegram', label: 'Telegram', description: 'Bot API sendMessage' },
  { id: 'webhook', label: '通用 Webhook', description: '自定义 URL POST JSON' },
];

// 每种 channel type 的配置字段定义 — 模板按这个表动态渲染表单
const channelTypeFields: Record<ReminderChannelType, Array<{ key: string; label: string; placeholder?: string; type?: 'text' | 'password' | 'number' | 'textarea'; optional?: boolean }>> = {
  browser: [],
  email: [
    { key: 'host', label: 'SMTP 服务器', placeholder: 'smtp.qq.com' },
    { key: 'port', label: '端口', placeholder: '465', type: 'number' },
    { key: 'user', label: '用户名 (邮箱)' },
    { key: 'pass', label: '密码 / 授权码', type: 'password' },
    { key: 'from', label: '发件地址', placeholder: '"Quink 提醒" <xxx@qq.com>' },
    { key: 'to', label: '收件地址', placeholder: 'you@example.com' },
  ],
  bark: [
    { key: 'url', label: 'Bark 推送 URL', placeholder: 'https://api.day.app/<your-key>' },
  ],
  wecom_bot: [
    { key: 'webhook', label: 'Webhook URL', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...' },
  ],
  dingtalk_bot: [
    { key: 'webhook', label: 'Webhook URL', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...' },
    { key: 'secret', label: '加签 secret (可选)', optional: true, type: 'password' },
  ],
  feishu_bot: [
    { key: 'webhook', label: 'Webhook URL', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...' },
    { key: 'secret', label: '加签 secret (可选)', optional: true, type: 'password' },
  ],
  telegram: [
    { key: 'bot_token', label: 'Bot Token', placeholder: '123456:ABC-DEF1234...', type: 'password' },
    { key: 'chat_id', label: 'Chat ID', placeholder: '123456789 或 -100xxxxxx' },
  ],
  webhook: [
    { key: 'url', label: 'URL', placeholder: 'https://your.host/endpoint' },
    { key: 'method', label: 'Method (默认 POST)', optional: true, placeholder: 'POST' },
    { key: 'headers', label: 'Headers JSON (可选)', type: 'textarea', optional: true, placeholder: '{"Authorization": "Bearer xxx"}' },
  ],
};

async function loadReminderChannels() {
  try {
    const r = await api.getReminderChannels();
    reminderChannels.value = r.data;
  } catch (e) {
    console.error('[Settings] loadReminderChannels failed:', e);
  }
}

// 多设备 SSE 同步: 其他设备改了配置 → Settings 自动 reload 对应区块
useSseSync('reminder-channels', loadReminderChannels);
useSseSync(['ai-configs', 'ai-prompts'], loadAiData);
useSseSync('user-profile', () => auth.fetchMe?.());

// browser 通道全用户唯一: 后端拦截了, 这里 UI 同步 disable. 编辑现有 browser channel 时不算 (id 自己排除)
const hasBrowserChannel = computed(() => reminderChannels.value.some(c => c.type === 'browser'));

function startEditChannel(ch?: ReminderChannel) {
  channelError.value = '';
  if (ch) {
    editingChannel.value = {
      id: ch.id,
      type: ch.type,
      name: ch.name,
      config: { ...(ch.config || {}) },
      enabled: ch.enabled,
      // 老 row types=null 视作"全收" 展开成全部勾选; 新 row 跟着写
      selectedTypes: ch.types && ch.types.length > 0 ? [...ch.types] : [...ALL_NOTIFICATION_TYPES],
    };
  } else {
    // 没有 browser 通道时默认到 browser; 已有就跳到第一个非 browser 类型, 避免新建时弹出 disabled 选项
    editingChannel.value = {
      type: hasBrowserChannel.value ? 'email' : 'browser',
      name: '我的提醒',
      config: {},
      enabled: true,
      selectedTypes: [...ALL_NOTIFICATION_TYPES], // 新建默认全选
    };
  }
}

// 切换某个 meta (含 siblings 联动)
function toggleChannelType(t: NotificationTypeMeta) {
  if (!editingChannel.value) return;
  const all = metaTypes(t); // [t.type, ...siblings]
  const list = editingChannel.value.selectedTypes;
  const checked = list.includes(t.type);
  if (checked) {
    editingChannel.value.selectedTypes = list.filter(tp => !all.includes(tp));
  } else {
    editingChannel.value.selectedTypes = Array.from(new Set([...list, ...all]));
  }
}
// 整个 category 全选/全不选 (含 siblings)
function toggleChannelCategory(category: 'reminder' | 'content' | 'group') {
  if (!editingChannel.value) return;
  const group = NOTIFICATION_GROUPS.find(g => g.category === category);
  if (!group) return;
  const all = group.types.flatMap(t => metaTypes(t));
  const allChecked = group.types.every(t => editingChannel.value!.selectedTypes.includes(t.type));
  if (allChecked) {
    editingChannel.value.selectedTypes = editingChannel.value.selectedTypes.filter(t => !all.includes(t));
  } else {
    editingChannel.value.selectedTypes = Array.from(new Set([...editingChannel.value.selectedTypes, ...all]));
  }
}
function toggleCategoryExpand(category: string) {
  if (expandedTypeCategories.value.has(category)) expandedTypeCategories.value.delete(category);
  else expandedTypeCategories.value.add(category);
}
// 列表显示用: channel 已选 N/总数 摘要 (按 UI 选项数, siblings 算 1)
function channelTypesSummary(ch: ReminderChannel): string {
  return `已选 ${countSelectedUiTypes(ch.types)}/${TOTAL_UI_TYPE_COUNT}`;
}

async function saveChannel() {
  if (!editingChannel.value) return;
  const e = editingChannel.value;
  if (!e.name.trim()) { channelError.value = '请填写名称'; return; }

  // headers 是 textarea, 用户写的是 JSON 字符串 — 保存时解析回对象, 失败给提示
  const payloadConfig: Record<string, any> = { ...e.config };
  if (e.type === 'webhook' && typeof payloadConfig.headers === 'string') {
    const raw = (payloadConfig.headers as string).trim();
    if (raw) {
      try { payloadConfig.headers = JSON.parse(raw); }
      catch { channelError.value = 'Headers JSON 格式错误'; return; }
    } else {
      delete payloadConfig.headers;
    }
  }

  // 全选时写 null (兼容老 row + 全收语义节省存储), 否则写数组
  const types = e.selectedTypes.length === ALL_NOTIFICATION_TYPES.length ? null : e.selectedTypes;
  try {
    if (e.id) {
      await api.updateReminderChannel(e.id, { name: e.name, config: payloadConfig, enabled: e.enabled, types });
    } else {
      await api.createReminderChannel({ type: e.type, name: e.name, config: payloadConfig, enabled: e.enabled, types });
    }
    editingChannel.value = null;
    await loadReminderChannels();
    showMsg('已保存');
  } catch (err: any) {
    channelError.value = err?.message || '保存失败';
  }
}

async function deleteChannel(id: string) {
  if (!confirm('删除这个提醒通道?')) return;
  try {
    await api.deleteReminderChannel(id);
    await loadReminderChannels();
    showMsg('已删除');
  } catch (e: any) {
    toast.show(e?.message || '删除失败', 'error');
  }
}

async function testChannel(id: string) {
  testingChannelId.value = id;
  try {
    await api.testReminderChannel(id);
    toast.show('测试消息已发送', 'success');
  } catch (e: any) {
    toast.show(e?.message || '发送失败', 'error');
  } finally {
    testingChannelId.value = null;
  }
}

async function toggleChannelEnabled(ch: ReminderChannel) {
  try {
    await api.updateReminderChannel(ch.id, { enabled: !ch.enabled });
    await loadReminderChannels();
  } catch (e: any) {
    toast.show(e?.message || '更新失败', 'error');
  }
}

async function requestBrowserPermission() {
  if (typeof Notification === 'undefined') {
    toast.show('当前环境不支持系统通知', 'error');
    return;
  }
  const p = await Notification.requestPermission();
  browserPermission.value = p;
  if (p === 'granted') toast.show('已授权', 'success');
  else toast.show('已拒绝/未授权', 'default');
}

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
  { id: 'openai', label: 'OpenAI', defaultModel: '', defaultUrl: 'https://api.deepseek.com' },
  { id: 'anthropic', label: 'Anthropic', defaultModel: '', defaultUrl: 'https://api.deepseek.com/anthropic' },
  { id: 'ollama', label: 'Ollama', defaultModel: '', defaultUrl: 'http://localhost:11434' },
];

const aiFeatures = [
  { key: 'auto_tag', label: '自动标签' },
  { key: 'auto_classify', label: '自动分类' },
  { key: 'auto_summary', label: '自动摘要' },
  { key: 'polish', label: 'AI 润色' },
  { key: 'expand', label: 'AI 扩充' },
  { key: 'write', label: 'AI 写文' },
  { key: 'chat', label: 'AI 对话' },
];

// 3 个 auto_* feature 在提示词 tab 栏上带迷你开关 (开关从偏好设置搬到这里).
// 其他 feature (polish/expand/write/chat) 没开关 —— 它们是用户主动触发的, 没"自动开关"语义.
const featureToggleKey: Record<string, 'autoTag' | 'autoCategorize' | 'autoSummary'> = {
  auto_tag: 'autoTag',
  auto_classify: 'autoCategorize',
  auto_summary: 'autoSummary',
};
function getAutoToggle(featureKey: string): boolean {
  const k = featureToggleKey[featureKey];
  return k ? (prefs[k] as boolean) : false;
}
function flipAutoToggle(featureKey: string) {
  const k = featureToggleKey[featureKey];
  if (k) prefs[k] = !prefs[k];
}

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
    editingConfig.value = { name: '', provider: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: '', model: '' };
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
  { id: 'reminders', label: '提醒' },
  { id: 'export', label: '导出' },
  { id: 'about', label: '关于' },
];

onMounted(async () => {
  // 拿系统默认下载目录的真实路径 (Windows 跟 *nix 表达不同), Settings 显示用
  try {
    const desk = (window as any).quinkDesktop;
    if (desk?.getDefaultDownloadDir) defaultDownloadDir.value = await desk.getDefaultDownloadDir();
  } catch {}
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
    // 同步本地 ref (放 prefsLoaded=true 之前, 不触发 watch); 5 个文本/数字输入框 @blur 才写回 prefs
    localXfyunAppId.value = prefs.xfyun.appId;
    localXfyunApiKey.value = prefs.xfyun.apiKey;
    localXfyunApiSecret.value = prefs.xfyun.apiSecret;
    localAiPersonaCustom.value = prefs.aiPersonaCustom;
    localAutoSummaryMinLen.value = prefs.autoSummaryMinLen;
  }
  // 卡片最小宽度 (设备本地, 不进 user.preferences)
  const cw = getCardWidthPref();
  cardWidth.mode = cw.mode;
  cardWidth.value = cw.value;
  // 同步排序偏好到 notesStore (放 if(auth.user) 块外: 未登录场景 prefs 走默认值也要确保 store 一致,
  // 否则 store.sortBy 可能残留前一次 session 的值. 用户偏好跟 store 默认值不同时触发 store watch
  // 清缓存 → 主 view 在 KeepAlive 后台 vs.notes 清空, 切回时 onActivated wasEmpty 走 reset 拉新顺序)
  notesStore.sortBy = prefs.notesSortBy;
  notesStore.sharedDisplay = prefs.sharedDisplay;
  loadAiData();
  loadReminderChannels();
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

// 改"回收站保留时间"时, 若新天数会让现有 trash 笔记立刻被永久清掉, 先弹窗确认再写回 prefs (写回触发下面 prefs watch → PATCH /me → 后端 cleanTrashForUser).
// 之所以拦在这里而不是放后端: 后端 PATCH /me 在保存的同步路径里直接 DELETE, 用户没机会撤回.
// CustomSelect 在模板里改成 :modelValue + @update:modelValue → tryChangeRetention, 缩短保留期才检测.
const pendingRetentionConfirm = ref<{ count: number; newVal: number; oldVal: number } | null>(null);
useEscToClose(pendingRetentionConfirm, null);

async function tryChangeRetention(newVal: number | string) {
  const next = Number(newVal);
  const oldVal = prefs.trashRetentionDays;
  if (next === oldVal) return;
  if (pendingRetentionConfirm.value) return; // 上一次弹窗未关, 防 race
  // 仅在缩短保留期 (含"永久 0 → 有限天数") 时才需要检测; 扩大或保持永久 0 不会触发删除
  const shrinking = next !== 0 && (oldVal === 0 || next < oldVal);
  if (!shrinking) { prefs.trashRetentionDays = next; return; }
  let count = 0;
  try {
    const res = await api.getTrash();
    const cutoff = dayjs().subtract(next, 'day');
    count = (res.data || []).filter((n: any) => n.deletedAt && dayjs(n.deletedAt).isBefore(cutoff)).length;
  } catch { /* 拉失败兜底直接保存, 后端清理是 idempotent 不会出错 */ }
  if (count === 0) { prefs.trashRetentionDays = next; return; }
  pendingRetentionConfirm.value = { count, newVal: next, oldVal };
}
function confirmRetentionChange() {
  if (!pendingRetentionConfirm.value) return;
  prefs.trashRetentionDays = pendingRetentionConfirm.value.newVal;
  pendingRetentionConfirm.value = null;
}
function cancelRetentionChange() {
  pendingRetentionConfirm.value = null;
  // 不动 prefs.trashRetentionDays, CustomSelect 因为绑 :modelValue=prefs.trashRetentionDays 自动回原值显示
}

// 拼一份完整 preferences：保留 userPrefs 中未托管的字段（aiBindings、shortcuts 等），prefs 顶层覆盖之
// 同时清理老 fontSize 字段 (zoom 改造后 prefs.zoomLevel 是真值, 防止 buildPrefs 把老 fontSize 又带回 DB)
function buildPrefs() {
  const { fontSize: _legacy, ...rest } = (auth.user?.preferences || {}) as any;
  return { ...rest, ...prefs };
}

async function savePreferences(silent = false) {
  saving.value = true;
  try {
    await auth.updateProfile({ preferences: buildPrefs() });
    document.documentElement.setAttribute('data-theme', prefs.theme);
    localStorage.setItem('quink_theme', prefs.theme);
    try { (window as any).quinkDesktop?.syncTheme?.(prefs.theme); } catch {}
    // Electron 端: 主进程 setZoomFactor 应用到所有 3 个窗口 + 调整 Capture 窗口尺寸; Web/PWA 端用 CSS zoom (二选一, 双方同设会双重缩放).
    // localStorage 缓存让 ensureCurrentZoomLevel / inline script 拿得到上次值
    localStorage.setItem('quink_zoom_level', String(prefs.zoomLevel));
    if ((window as any).quinkDesktop?.isElectron) {
      try { (window as any).quinkDesktop.syncZoom(prefs.zoomLevel); } catch {}
    } else {
      (document.documentElement.style as any).zoom = (prefs.zoomLevel / 100).toString();
    }
    // 改 zoom 后必须重算 --app-height, 否则 #app 高度用旧 zoom 算、被新 zoom 放大顶破视口 → 切换不居中、刷新才对.
    // (真凶: 设置页改显示比例走的是这里、不走 App.vue 的 applyZoomLevel, 之前一直漏了这处重算.)
    // 传确切 zoom 不让 setAppHeight 读 DOM (getComputedStyle 切换后滞后一帧); Electron 走 setZoomFactor 不改 CSS 布局故传 1.
    try { (window as any).__quink_setAppHeight?.((window as any).quinkDesktop?.isElectron ? 1 : prefs.zoomLevel / 100); } catch {}
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

// 排序偏好同步到 notesStore: 用户在偏好里改 select 时立即推到 store, 触发 store watch 清各 view 缓存,
// 切回主 view 时 onActivated wasEmpty 走 reset 拉新顺序. onMounted 加载时也会同步一次 (那里不走此 watch
// 因为有 prefsLoaded 闸门, 但 onMounted 里手动同步了一次)
watch(() => prefs.notesSortBy, (v) => {
  if (!prefsLoaded) return;
  notesStore.sortBy = v;
});
// 共享显示策略同步到 notesStore (同款套路): 用户改 select → 推到 store → store watch 清缓存 + 改各 view scope
watch(() => prefs.sharedDisplay, (v) => {
  if (!prefsLoaded) return;
  notesStore.sharedDisplay = v;
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
    pwdMsg.value = '密码修改成功, 即将退出登录...';
    oldPwd.value = ''; newPwd.value = '';
    // 安全审计 M2: 改密码后立即清 token 跳登录页 (后端 tokenVersion++ 已让旧 token 失效, 不主动登出会让本设备所有后续请求 401)
    setTimeout(() => {
      localStorage.removeItem('quink_token');
      window.location.href = '/login';
    }, 1500);
  } catch (err: any) { pwdMsg.value = err.message; }
  finally { saving.value = false; }
}

// 安全审计: "登出所有设备" - 跟改密码同款 tokenVersion++ 效果, 区别仅是不需旧密码
const confirmLogoutAll = ref(false);
const logoutAllSaving = ref(false);
async function doLogoutAll() {
  if (logoutAllSaving.value) return;
  logoutAllSaving.value = true;
  try {
    await api.logoutAllDevices();
    confirmLogoutAll.value = false;
    // 跟 changePassword 同款: 1.5s 让用户看到反馈再跳登录. 本机 token 此刻已失效 (server tokenVersion 已升), 即使用户立即关页面下次进来也会被 401 兜底跳登录
    setTimeout(() => {
      localStorage.removeItem('quink_token');
      window.location.href = '/login';
    }, 1500);
  } catch (err: any) {
    logoutAllSaving.value = false;
    confirmLogoutAll.value = false;
    showMsg('登出失败: ' + (err.message || '未知错误'), 'error');
  }
}

// ── Export / Import ──
const exporting = ref(false);
const importing = ref(false);
const importResult = ref('');
// 导出筛选 (都不填 = 全量): 分类单选 + 日期范围 x~x
const exportCategory = ref('');
const exportDateFrom = ref('');
const exportDateTo = ref('');
const exportCategories = ref<{ name: string }[]>([]);
api.getCategories().then(res => { exportCategories.value = res.data as any; }).catch(() => {});
const exportCategoryOptions = computed(() => [
  { value: '', label: '全部分类' },
  { value: '__uncategorized__', label: '未分类' },
  ...exportCategories.value.map(c => ({ value: c.name, label: c.name })),
]);

async function handleExport() {
  exporting.value = true;
  try {
    await api.exportData({
      category: exportCategory.value || undefined,
      dateFrom: exportDateFrom.value || undefined,
      dateTo: exportDateTo.value || undefined,
    });
    showMsg('导出成功');
  } catch (err: any) { showMsg(err.message, 'error'); }
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
  router.push('/quink');
}
</script>

<template>
  <div class="px-4 md:px-8 pb-8 select-none" @keydown="handleShortcutKeydown">
    <!-- Tabs (sticky 锁顶, -mx 抵消 root padding 占全宽, 顶部 box-shadow 分隔.
         背景走 --c-body 不透明 (跟页面同色融为一体): 之前用 bg-gray-50 在 dark 主题下被 style.css 覆盖成 5% 白半透明,
         sticky 锁顶时下面卡片透过来视觉脏 → 改用主题变量保证 7 套主题都不透明) -->
    <div class="sticky top-0 z-[var(--z-sticky)] -mx-4 md:-mx-8 px-4 md:px-8 pt-[8px] mb-6 flex flex-wrap gap-1 border-b border-gray-200"
      style="background-color: var(--c-body); box-shadow: 0 1px 3px var(--c-topbar-shadow), 0 1px 0 var(--sb-border)">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        @click="activeTab = tab.id"
        class="px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px whitespace-nowrap grid"
        :class="activeTab === tab.id
          ? 'border-primary text-primary'
          : 'border-transparent text-gray-500 hover:text-gray-700'"
      >
        <!-- 用 grid 双 span 叠加: 占位 span(粗体, invisible) 撑出宽度永远按粗体算,
             显示 span 按当前选中状态切 font-weight, 不影响 layout, 解决"选中后挤右边 1px"抖动 -->
        <span class="invisible font-medium col-start-1 row-start-1">{{ tab.label }}</span>
        <span class="col-start-1 row-start-1" :class="activeTab === tab.id ? 'font-medium' : ''">{{ tab.label }}</span>
      </button>
    </div>

    <!-- ═══ 基本信息 ═══ -->
    <div v-if="activeTab === 'profile'" class="space-y-6">
      <div class="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <!-- Avatar -->
        <div class="flex items-center gap-5">
          <button @click="triggerAvatarUpload" class="relative group shrink-0" :disabled="uploadingAvatar">
            <!-- 用 <img> 而非 background-image: Chromium 对 <img> 的 downsample 路径质量更高 (大头像缩 80px 不会看着锐化).
                 src 走 thumb URL, thumb 没生成时 @error 一次性降级到原图. draggable=false 防按住头像意外触发 OS 拖图 -->
            <img
              v-if="avatarPreview"
              :src="resolveFileThumbUrl(avatarPreview)"
              @error="thumbErrorFallback($event, resolveFileUrl(avatarPreview))"
              draggable="false"
              alt="头像"
              class="w-20 h-20 rounded-full object-cover border-2 border-gray-100"
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
          class="px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-dark disabled:opacity-50 inline-grid place-items-center"
        >
          <!-- grid stack: invisible span 永远撑 "保存中" 宽度防按钮抖, 可见 span 显示当前文字 -->
          <span class="col-start-1 row-start-1 invisible">保存中</span>
          <span class="col-start-1 row-start-1">{{ saving ? '保存中' : '保存' }}</span>
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
        <div class="flex items-center gap-3">
          <button @click="changePassword" :disabled="saving || logoutAllSaving" class="px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-dark disabled:opacity-50 inline-grid place-items-center">
            <span class="col-start-1 row-start-1 invisible">修改密码</span>
            <span class="col-start-1 row-start-1">{{ saving ? '修改中' : '修改密码' }}</span>
          </button>
          <!-- 安全审计: 登出所有设备 (含本机). 跟改密码一样让旧 token 立即失效, 区别只是不需要旧密码. 后续 2FA / 邮箱验证码改密码也会从这里扩展 -->
          <button @click="confirmLogoutAll = true" :disabled="saving || logoutAllSaving" class="px-5 py-2 text-sm font-medium rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            登出所有设备
          </button>
        </div>
      </div>
    </div>

    <!-- 登出所有设备确认弹窗 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="confirmLogoutAll" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
          <div class="absolute inset-0 bg-black/30" @click="confirmLogoutAll = false" />
          <div class="relative bg-white rounded-xl shadow-xl p-5 w-80 text-center">
            <p class="text-sm text-gray-700 mb-1">登出所有设备</p>
            <p class="text-xs text-gray-400 mb-4">将使本账号所有登录设备立即登出</p>
            <div class="flex gap-2 justify-center">
              <button @click="confirmLogoutAll = false" :disabled="logoutAllSaving"
                class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">取消</button>
              <button @click="doLogoutAll" :disabled="logoutAllSaving"
                class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600 disabled:opacity-50">
                {{ logoutAllSaving ? '处理中...' : '确认登出' }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- ═══ 偏好设置 ═══ -->
    <!-- 父容器去掉 space-y-5, 改用每项 py-3 border-t 上下对称 (border-t 到内容上下距离都是 12px) -->
    <div v-if="activeTab === 'preferences'" class="space-y-6">
      <div class="bg-white rounded-xl border border-gray-200 p-6">
        <!-- 主题色: 第一项无 border-t, pb-3 给下方留空间跟下一项 pt-3 对称 -->
        <div class="pb-3">
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
              class="flex flex-col items-center gap-1.5 p-2 rounded-xl border-2 transition-all theme-pick-btn"
              :class="prefs.theme === t.value ? 'theme-pick-selected border-gray-800 bg-gray-50 ring-2 ring-gray-300 ring-offset-1' : 'border-transparent hover:bg-gray-50'">
              <img :src="`/quink-${t.value}-192.png`" :alt="t.label" class="w-8 h-8" draggable="false" />
              <span class="text-[11px] text-gray-600">{{ t.label }}</span>
            </button>
          </div>
        </div>
        <!-- 显示比例: horizontal 跟其他项一致 -->
        <div class="py-3 border-t border-gray-100">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm text-gray-700 font-medium">显示比例</div>
              <div class="text-xs text-gray-400 mt-0.5">界面整体缩放比例</div>
            </div>
            <CustomSelect v-model="prefs.zoomLevel" size="compact" :options="[
              { value: 75, label: '75%' },
              { value: 80, label: '80%' },
              { value: 90, label: '90%' },
              { value: 100, label: '100%（默认）' },
              { value: 110, label: '110%' },
              { value: 125, label: '125%' },
              { value: 150, label: '150%' },
              { value: 200, label: '200%' },
            ]" />
          </div>
        </div>
        <!-- 列表排序: 灵感/笔记/待办 3 主 view 按此字段排序 (置顶永远在最前, 组内按所选时间排) -->
        <div class="py-3 border-t border-gray-100">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm text-gray-700 font-medium">列表排序</div>
              <div class="text-xs text-gray-400 mt-0.5">灵感/笔记/待办列表的排序依据 (置顶始终在前)</div>
            </div>
            <CustomSelect v-model="prefs.notesSortBy" size="compact" :options="[
              { value: 'created', label: '创建时间' },
              { value: 'updated', label: '最后编辑时间' },
            ]" />
          </div>
        </div>
        <!-- 群组共享笔记可见范围: 改后清各 view 缓存, 切回主 view 时 onActivated wasEmpty 走 reset 拉新 scope 数据.
             私人笔记不受此设置影响, 始终显示; 此设置仅决定主页面是否纳入群组共享笔记 -->
        <div class="py-3 border-t border-gray-100">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm text-gray-700 font-medium">群组共享笔记可见范围</div>
              <div class="text-xs text-gray-400 mt-0.5">私人笔记始终显示, 此设置仅决定主页面纳入哪些群组共享笔记</div>
            </div>
            <CustomSelect v-model="prefs.sharedDisplay" size="compact" :options="[
              { value: 'own', label: '仅我发布的' },
              { value: 'others', label: '仅他人发布的' },
              { value: 'none', label: '全部隐藏' },
              { value: 'all', label: '全部显示' },
            ]" />
          </div>
        </div>
        <!-- 待办未完成数字提示 -->
        <div class="flex items-center justify-between py-3 border-t border-gray-100">
          <div>
            <div class="text-sm text-gray-700 font-medium">待办未完成数字提示</div>
            <div class="text-xs text-gray-400 mt-0.5">侧边栏「待办」后显示未完成数量的红色徽标</div>
          </div>
          <ToggleSwitch v-model="prefs.showTodoBadge" class="ml-4" />
        </div>
        <!-- 回收站保留天数 -->
        <div class="py-3 border-t border-gray-100">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm text-gray-700 font-medium">回收站保留时间</div>
              <div class="text-xs text-gray-400 mt-0.5">超过此时长的已删除内容会自动永久删除</div>
            </div>
            <CustomSelect :modelValue="prefs.trashRetentionDays" @update:modelValue="tryChangeRetention" size="compact" :options="[
              { value: 7, label: '7 天' },
              { value: 14, label: '14 天' },
              { value: 30, label: '30 天' },
              { value: 60, label: '60 天' },
              { value: 90, label: '90 天' },
              { value: 180, label: '180 天' },
              { value: 0, label: '永久保留' },
            ]" />
          </div>
        </div>
        <!-- 卡片最小宽度 (设备本地, localStorage 不跨账号). px 模式按绝对像素切列; percent 模式按 main 区百分比锁列数 -->
        <div class="py-3 border-t border-gray-100">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <div class="flex-1 min-w-0">
              <div class="text-sm text-gray-700 font-medium">卡片最小宽度</div>
              <div class="text-xs text-gray-400 mt-0.5">
                影响主视图笔记瀑布流列数. 保存在本设备, 不跨账号. 默认 320px.
                {{ cardWidth.mode === 'percent' ? '(百分比模式锁定列数, 不论屏幕宽窄)' : '' }}
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <CustomSelect :modelValue="cardWidth.mode"
                @update:modelValue="(v: any) => { cardWidth.mode = v; cardWidth.value = v === 'px' ? 320 : 25; saveCardWidth(); }"
                size="compact" :options="[
                { value: 'px', label: '像素' },
                { value: 'percent', label: '百分比' },
              ]" />
              <CustomSelect :modelValue="cardWidth.value"
                @update:modelValue="(v: any) => { cardWidth.value = v; saveCardWidth(); }"
                size="compact"
                :options="cardWidth.mode === 'percent' ? cardWidthPctOptions : cardWidthPxOptions" />
            </div>
          </div>
        </div>
        <!-- 下载目录 (本地配置, localStorage 存, 不跨设备同步因为 path 跟 OS 相关).
             非 Electron (手机/网页端) 没有 quinkDesktop, 浏览器自己处理下载, 隐藏整块 -->
        <div v-if="isElectron" class="py-3 border-t border-gray-100">
          <div class="flex items-center justify-between gap-3">
            <div class="flex-1 min-w-0">
              <div class="text-sm text-gray-700 font-medium">下载文件夹</div>
              <div class="text-xs text-gray-400 mt-0.5 truncate"
                :title="downloadDir || defaultDownloadDir">
                {{ downloadDir || defaultDownloadDir }}
              </div>
            </div>
            <div class="shrink-0 flex items-center gap-2">
              <button v-if="downloadDir" @click="resetDownloadDir"
                class="px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
                title="恢复到系统默认下载目录">
                恢复默认
              </button>
              <button @click="pickDownloadDir" class="px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
                更改
              </button>
            </div>
          </div>
        </div>
        <!-- 自动标签 / 自动分类 / 自动摘要 3 个开关已搬到"AI 模型 → 提示词" tab 栏;
             "自动摘要 · 最少字符数"已挪到提示词编辑区 (auto_summary tab 选中时显示在恢复默认按钮右侧). -->
        <!-- 讯飞语音识别 -->
        <div class="py-3 border-t border-gray-100 space-y-2">
          <div class="text-sm text-gray-700 font-medium">语音识别（讯飞）</div>
          <div class="text-xs text-gray-400 mb-1">用于编辑器的语音输入功能，注册 xfyun.cn 获取</div>
          <div class="space-y-1.5">
            <div class="flex items-center gap-2">
              <span class="text-xs text-gray-500 w-16 shrink-0">APPID</span>
              <input v-model="localXfyunAppId" @blur="commitField(localXfyunAppId, prefs.xfyun, 'appId')"
                class="flex-1 px-2 py-1.5 border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs text-gray-500 w-16 shrink-0">APIKey</span>
              <input v-model="localXfyunApiKey" @blur="commitField(localXfyunApiKey, prefs.xfyun, 'apiKey')"
                class="flex-1 px-2 py-1.5 border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs text-gray-500 w-16 shrink-0">APISecret</span>
              <input v-model="localXfyunApiSecret" @blur="commitField(localXfyunApiSecret, prefs.xfyun, 'apiSecret')"
                type="password" class="flex-1 px-2 py-1.5 border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
          </div>
          <!-- 自动转写 -->
          <div class="flex items-center justify-between mt-3">
            <div>
              <div class="text-xs text-gray-600">录音时自动转写文字</div>
              <div class="text-[11px] text-gray-400">开启后录音保存时自动调讯飞转写，AI 对话可引用语音内容</div>
            </div>
            <ToggleSwitch v-model="prefs.autoTranscribeVoice" class="ml-4" />
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ 快捷键 ═══ -->
    <!-- 内层 space-y-3 去掉, 3 项靠 border-b 自己分隔, 每条线上下 12px 对称 -->
    <div v-if="activeTab === 'shortcuts'">
      <div class="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <div>
          <!-- Capture shortcut: 第一项 pb-3 (无 pt) 让标题贴卡片顶部 padding 跟偏好设置一致 -->
          <div class="flex items-center justify-between pb-3 border-b border-gray-50">
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

        <button @click="saveShortcuts" :disabled="saving" class="mt-4 px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-dark disabled:opacity-50 inline-grid place-items-center">
          <span class="col-start-1 row-start-1 invisible">保存中</span>
          <span class="col-start-1 row-start-1">{{ saving ? '保存中' : '保存' }}</span>
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
            <button @click="testConfig(cfg.id)" class="px-2.5 py-1 text-xs rounded-md bg-primary-light text-primary-dark hover:bg-primary/20">
              {{ testingId === cfg.id ? (testResult || '测试中') : '测试' }}
            </button>
            <button @click="startEditConfig(cfg)" class="px-2.5 py-1 text-xs rounded-md bg-gray-100 text-gray-600 hover:bg-gray-200">编辑</button>
            <button @click="deleteConfig(cfg.id)" class="px-2.5 py-1 text-xs rounded-md bg-red-50 text-red-500 hover:bg-red-100">删除</button>
          </div>
        </TransitionGroup>

        <!-- Edit/Create form -->
        <div v-if="editingConfig" class="mt-4 p-4 rounded-lg border border-gray-200 bg-gray-50 space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs text-gray-500 mb-1">名称</label>
              <input v-model="editingConfig.name" class="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary" placeholder="如：deepseek-v4-flash 标签用" />
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">服务商</label>
              <CustomSelect v-model="editingConfig.provider" size="compact" class="w-full"
                :options="aiProviderOptions.map(p => ({ value: p.id, label: p.label }))"
                @change="() => {
                  const p = aiProviderOptions.find(x => x.id === editingConfig!.provider);
                  if (p) { editingConfig!.baseUrl = p.defaultUrl; editingConfig!.model = p.defaultModel; }
                }" />
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
            <button @click="saveConfig" :disabled="saving" class="px-4 py-1.5 text-white text-xs font-medium rounded-lg disabled:opacity-50 inline-grid place-items-center" style="background: rgb(var(--c-accent))">
              <span class="col-start-1 row-start-1 invisible">保存中</span>
              <span class="col-start-1 row-start-1">{{ saving ? '保存中' : '保存' }}</span>
            </button>
            <button @click="editingConfig = null; configError = ''" class="px-4 py-1.5 text-xs text-gray-500 rounded-lg hover:bg-gray-100">取消</button>
          </div>
        </div>
      </div>

      <!-- Feature bindings -->
      <div class="bg-white rounded-xl border border-gray-200 p-6">
        <h3 class="text-sm font-medium text-gray-800 mb-4">功能绑定</h3>
        <div class="space-y-3">
          <div v-for="f in aiFeatures" :key="f.key" class="flex items-center justify-between">
            <span class="text-sm text-gray-600">{{ f.label }}</span>
            <CustomSelect v-model="aiBindings[f.key]" size="compact" class="w-48"
              :disabled="aiConfigs.length === 0"
              :placeholder="aiConfigs.length === 0 ? '请先创建 AI 配置' : '请选择'"
              :options="aiConfigs.map(cfg => ({ value: cfg.id, label: cfg.name }))"
              @change="onBindingChange" />
          </div>
        </div>
      </div>

      <!-- Prompts -->
      <div class="bg-white rounded-xl border border-gray-200 p-6">
        <h3 class="text-sm font-medium text-gray-800 mb-4">提示词</h3>
        <div class="flex gap-1 mb-4 flex-wrap">
          <button v-for="f in aiFeatures" :key="f.key" @click="startEditPrompt(f.key)"
            class="px-3 py-1.5 rounded-lg text-xs transition-colors inline-flex items-center gap-1.5"
            :class="editingPromptFeature === f.key ? 'bg-primary-light text-primary-dark font-medium' : 'text-gray-500 hover:bg-gray-100'">
            <span>{{ f.label }}</span>
            <!-- 3 个 auto_* feature 后面带迷你开关. @click.stop 阻止冒泡: 点开关不切 tab; 点 button 其他区域正常切 tab.
                 用 :model-value + @update:model-value 而非 v-model 是因为状态读/写都走 getAutoToggle/flipAutoToggle (prefs key 映射). -->
            <ToggleSwitch v-if="featureToggleKey[f.key]" size="sm"
              :model-value="getAutoToggle(f.key)" @update:model-value="flipAutoToggle(f.key)" @click.stop
              :title="getAutoToggle(f.key) ? '自动开启 - 点击关闭' : '已关闭 - 点击开启'" />
          </button>
        </div>
        <div v-if="editingPromptFeature">
          <textarea v-model="editingPromptText" rows="8" spellcheck="false"
            class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs leading-relaxed outline-none focus:border-primary font-mono resize-none text-gray-600" />
          <p class="text-xs text-gray-400 mt-1">用 {content} 表示笔记内容，{context} 表示上下文</p>
          <div class="flex gap-2 mt-3 items-center">
            <button @click="savePrompt" :disabled="saving" class="px-4 py-1.5 text-white text-xs font-medium rounded-lg disabled:opacity-50 inline-grid place-items-center" style="background: rgb(var(--c-accent))">
              <span class="col-start-1 row-start-1 invisible">保存中</span>
              <span class="col-start-1 row-start-1">{{ saving ? '保存中' : '保存' }}</span>
            </button>
            <button @click="resetPrompt(editingPromptFeature)" class="px-4 py-1.5 text-xs text-gray-500 rounded-lg hover:bg-gray-100">恢复默认</button>
            <!-- 仅 auto_summary tab 显示触发阈值, 跟保存/恢复同行右侧 (从偏好设置挪过来集中) -->
            <div v-if="editingPromptFeature === 'auto_summary'" class="flex items-center gap-2 ml-2">
              <span class="text-xs text-gray-400 shrink-0">长度小于</span>
              <input v-model.number="localAutoSummaryMinLen" @blur="commitField(localAutoSummaryMinLen, prefs, 'autoSummaryMinLen')"
                type="number" min="10" max="500" step="10"
                class="w-20 px-2 py-1 border border-gray-200 rounded-lg text-xs outline-none bg-white text-center" />
              <span class="text-xs text-gray-400 shrink-0">不生成摘要</span>
            </div>
          </div>
        </div>
        <div v-else class="text-center py-6 text-gray-400 text-xs">点击上方功能标签查看和编辑提示词</div>
      </div>

      <!-- AI 对话 (人格 + Token 上限, 从偏好设置挪过来) -->
      <div class="bg-white rounded-xl border border-gray-200 p-6 space-y-3">
        <h3 class="text-sm font-medium text-gray-800">AI 对话</h3>
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
          <textarea v-if="prefs.aiPersona === 'custom'" v-model="localAiPersonaCustom"
            @blur="commitField(localAiPersonaCustom, prefs, 'aiPersonaCustom')"
            rows="3" placeholder="输入自定义人格提示词..."
            class="w-full mt-2 px-3 py-2 border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-primary/30 resize-none" />
        </div>
        <!-- Token 上限 -->
        <div class="flex items-center justify-between">
          <div class="text-xs text-gray-600">上下文 Token 上限</div>
          <CustomSelect v-model="prefs.aiChatMaxTokens" size="sm" :options="[
            { value: 4096, label: '4K' },
            { value: 8192, label: '8K' },
            { value: 16384, label: '16K' },
            { value: 32768, label: '32K' },
            { value: 65536, label: '64K' },
            { value: 131072, label: '128K' },
            { value: 262144, label: '256K' },
            { value: 524288, label: '512K' },
            { value: 1048576, label: '1M' },
          ]" />
        </div>
      </div>
    </div>

    <!-- ═══ 提醒通道 ═══ -->
    <div v-if="activeTab === 'reminders'" class="space-y-6">
      <div class="bg-white rounded-xl border border-gray-200 p-6">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h3 class="text-sm font-medium text-gray-800">提醒通道</h3>
            <p class="text-xs text-gray-400 mt-1">待办设了"提醒时间"到点会通过这里的所有启用通道推送一份</p>
          </div>
          <button @click="startEditChannel()" class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors" style="background: rgb(var(--c-accent) / 0.1); color: rgb(var(--c-accent))">
            + 添加通道
          </button>
        </div>

        <div v-if="reminderChannels.length === 0" class="text-center py-8 text-gray-400 text-sm">
          还没有提醒通道，点击上方按钮添加
        </div>

        <TransitionGroup tag="div" data-animated-list class="space-y-2" :css="false" @leave="collapseLeave">
          <div v-for="ch in reminderChannels" :key="ch.id"
            class="flex items-center gap-3 p-3 rounded-lg border border-gray-100 hover:border-gray-200 transition-all duration-300">
            <div class="w-2 h-2 rounded-full shrink-0" :class="ch.enabled ? 'bg-green-500' : 'bg-gray-300'"></div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-gray-700 truncate">{{ ch.name }}</div>
              <div class="text-xs text-gray-400">
                {{ channelTypeOptions.find(o => o.id === ch.type)?.label || ch.type }}
                <span class="text-gray-300 mx-1.5">·</span>
                <span class="text-gray-500">{{ channelTypesSummary(ch) }} 类通知</span>
              </div>
            </div>
            <ToggleSwitch :model-value="ch.enabled" @update:model-value="toggleChannelEnabled(ch)" size="sm" />
            <button @click="testChannel(ch.id)" :disabled="testingChannelId === ch.id"
              class="px-2.5 py-1 text-xs rounded-md bg-primary-light text-primary-dark hover:bg-primary/20 disabled:opacity-50">
              {{ testingChannelId === ch.id ? '发送中' : '测试' }}
            </button>
            <button @click="startEditChannel(ch)" class="px-2.5 py-1 text-xs rounded-md bg-gray-100 text-gray-600 hover:bg-gray-200">编辑</button>
            <button @click="deleteChannel(ch.id)" class="px-2.5 py-1 text-xs rounded-md bg-red-50 text-red-500 hover:bg-red-100">删除</button>
          </div>
        </TransitionGroup>

        <!-- Edit/Create form -->
        <div v-if="editingChannel" class="mt-4 p-4 rounded-lg border border-gray-200 bg-gray-50 space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs text-gray-500 mb-1">名称</label>
              <input v-model="editingChannel.name" class="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary" placeholder="如：我的提醒" />
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">类型</label>
              <CustomSelect v-model="editingChannel.type" size="compact" class="w-full"
                :disabled="!!editingChannel.id"
                :options="channelTypeOptions.map(t => ({
                  value: t.id,
                  label: t.label + (t.id === 'browser' && hasBrowserChannel && editingChannel!.type !== 'browser' ? ' (已添加)' : ''),
                  disabled: t.id === 'browser' && hasBrowserChannel && editingChannel!.type !== 'browser',
                }))" />
            </div>
          </div>
          <p class="text-xs text-gray-400 -mt-1">{{ channelTypeOptions.find(o => o.id === editingChannel?.type)?.description }}</p>

          <!-- browser 特殊: 没有配置字段, 只显示授权状态 -->
          <div v-if="editingChannel.type === 'browser'" class="rounded-lg bg-white border border-gray-200 px-3 py-2 text-xs flex items-center justify-between">
            <span class="text-gray-600">浏览器通知权限：
              <span :class="browserPermission === 'granted' ? 'text-green-600' : browserPermission === 'denied' ? 'text-red-500' : 'text-gray-400'">
                {{ browserPermission === 'granted' ? '已授权' : browserPermission === 'denied' ? '已拒绝' : '未授权' }}
              </span>
            </span>
            <button v-if="browserPermission !== 'granted'" @click="requestBrowserPermission"
              class="text-primary hover:underline">立即授权</button>
          </div>

          <!-- 其他类型: 按 channelTypeFields 表动态渲染 -->
          <div v-for="f in channelTypeFields[editingChannel.type]" :key="f.key">
            <label class="block text-xs text-gray-500 mb-1">{{ f.label }}</label>
            <textarea v-if="f.type === 'textarea'" v-model="editingChannel.config[f.key]" rows="3"
              :placeholder="f.placeholder" spellcheck="false"
              class="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs outline-none focus:border-primary font-mono resize-none" />
            <input v-else v-model="editingChannel.config[f.key]" :type="f.type || 'text'"
              :placeholder="f.placeholder" spellcheck="false"
              class="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary font-mono" />
          </div>

          <!-- 通知类型白名单 3 category 分组 -->
          <div class="border-t border-gray-200 pt-3 space-y-2">
            <div class="text-xs text-gray-500 mb-1">接收哪些类型的通知</div>
            <div v-for="group in NOTIFICATION_GROUPS" :key="group.category" class="bg-white rounded-lg border border-gray-200">
              <button @click="toggleCategoryExpand(group.category)" type="button"
                class="w-full px-3 py-2 flex items-center gap-2 hover:bg-gray-50 transition-colors text-left">
                <input type="checkbox"
                  :checked="group.types.every(t => editingChannel!.selectedTypes.includes(t.type))"
                  :indeterminate.prop="group.types.some(t => editingChannel!.selectedTypes.includes(t.type)) && !group.types.every(t => editingChannel!.selectedTypes.includes(t.type))"
                  @click.stop="toggleChannelCategory(group.category)"
                  class="w-4 h-4 accent-primary cursor-pointer" />
                <span class="text-xs font-medium text-gray-700 flex-1">{{ group.label }}</span>
                <span class="text-[10px] text-gray-400">{{ group.types.filter(t => editingChannel!.selectedTypes.includes(t.type)).length }}/{{ group.types.length }}</span>
                <span class="text-gray-300 text-xs">{{ expandedTypeCategories.has(group.category) ? '−' : '+' }}</span>
              </button>
              <div v-if="expandedTypeCategories.has(group.category)" class="px-3 pb-2 space-y-1 border-t border-gray-100 pt-2">
                <label v-for="t in group.types" :key="t.type"
                  class="flex items-start gap-2 py-1 cursor-pointer hover:bg-gray-50 px-1 rounded ml-[10px]">
                  <input type="checkbox"
                    :checked="editingChannel!.selectedTypes.includes(t.type)"
                    @change="toggleChannelType(t)"
                    class="w-3.5 h-3.5 mt-[3px] accent-primary cursor-pointer" />
                  <span class="flex-1 min-w-0 -mt-[4px]">
                    <span class="text-xs text-gray-700">{{ t.label }}</span>
                  </span>
                </label>
              </div>
            </div>
          </div>

          <div v-if="channelError" class="text-red-500 text-xs bg-red-50 rounded-lg px-3 py-2">{{ channelError }}</div>
          <div class="flex gap-2">
            <button @click="saveChannel" class="px-4 py-1.5 text-white text-xs font-medium rounded-lg" style="background: rgb(var(--c-accent))">
              保存
            </button>
            <button @click="editingChannel = null; channelError = ''" class="px-4 py-1.5 text-xs text-gray-500 rounded-lg hover:bg-gray-100">
              取消
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ 导出 ═══ -->
    <div v-if="activeTab === 'export'" class="space-y-6">
      <!-- Export -->
      <div class="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h3 class="text-sm font-medium text-gray-800">数据导出</h3>
        <p class="text-sm text-gray-500">导出笔记为 Markdown + 正文引用的附件，打包成 ZIP。</p>
        <div class="flex flex-wrap items-end gap-3">
          <div>
            <label class="block text-xs text-gray-500 mb-1">开始日期</label>
            <div class="w-40"><DatePicker v-model="exportDateFrom" placeholder="不限" /></div>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">结束日期</label>
            <div class="w-40"><DatePicker v-model="exportDateTo" placeholder="不限" /></div>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">分类</label>
            <CustomSelect v-model="exportCategory" size="compact" class="w-40" :options="exportCategoryOptions" />
          </div>
        </div>
        <button @click="handleExport" :disabled="exporting"
          class="px-4 py-2 text-sm font-medium rounded-lg transition-colors" style="background: rgb(var(--c-accent) / 0.1); color: rgb(var(--c-accent))">
          {{ exporting ? '导出中' : '导出 ZIP' }}
        </button>
      </div>
      <!-- Import -->
      <div class="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h3 class="text-sm font-medium text-gray-800">数据导入</h3>
        <p class="text-sm text-gray-500">从之前导出的 ZIP 文件恢复笔记。</p>
        <button @click="triggerImport" :disabled="importing"
          class="px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          style="background: rgb(var(--c-accent) / 0.1); color: rgb(var(--c-accent))">
          {{ importing ? '导入中' : '选择 ZIP 文件导入' }}
        </button>
        <p v-if="importResult" class="text-xs" :class="importResult.startsWith('成功') ? 'text-green-600' : 'text-red-500'">{{ importResult }}</p>
      </div>
    </div>

    <!-- ═══ 关于 ═══ -->
    <div v-if="activeTab === 'about'">
      <div class="bg-white rounded-xl border border-gray-200 p-8 max-w-md mx-auto">
        <div class="text-center mb-6">
          <img :src="`/quink-${currentTheme}-192.png`" alt="Quink" class="w-16 h-16 mx-auto mb-3" />
          <h3 class="text-2xl font-bold" style="color: rgb(var(--c-accent-dark))">Quink</h3>
          <p class="text-gray-500 text-sm mt-1">一念 · Quick Think</p>
          <p class="text-xs text-gray-400 mt-1">v0.1.0</p>
        </div>

        <div class="space-y-3 text-sm text-gray-500 mb-6">
          <p class="text-center">一念之间，落笔即存</p>
          <p class="text-center">AI 自动整理，灵感不再走散</p>
        </div>

        <div class="border-t border-gray-100 pt-4">
          <div class="flex justify-between items-center text-xs">
            <span class="text-gray-400">GitHub</span>
            <!-- Electron 端 main.ts setWindowOpenHandler 已统一把 target=_blank 走 shell.openExternal -->
            <a href="https://github.com/MushroomScript/Quink" target="_blank" rel="noopener"
              class="text-gray-500 hover:text-primary transition-colors font-mono">
              MushroomScript/Quink
            </a>
          </div>
        </div>

        <p class="text-center text-[10px] text-gray-300 mt-6">Made with ❤️ by Mushroom</p>
      </div>
    </div>

    <!-- 改回收站保留时间触发"立即永久删除 N 条"时的确认弹窗 (CLAUDE.md: 危险操作必须弹窗确认) -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="pendingRetentionConfirm" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
          <div class="absolute inset-0 bg-black/30" @click="cancelRetentionChange" />
          <div class="relative bg-white rounded-xl shadow-xl p-5 w-80 text-center">
            <p class="text-sm text-gray-700 mb-1">缩短回收站保留时间</p>
            <p class="text-xs text-gray-400 mb-4">将立即永久删除 {{ pendingRetentionConfirm.count }} 条已删除内容，不可恢复</p>
            <div class="flex gap-2 justify-center">
              <button @click="cancelRetentionChange" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
              <button @click="confirmRetentionChange" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">确定</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
