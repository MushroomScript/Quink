<script setup lang="ts">
import { ref, reactive, watch, nextTick, computed } from 'vue';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { RRule } from 'rrule';
import { useNow } from '@/composables/useNow';
dayjs.locale('zh-cn');

// 响应式 now: picker 开 1 小时不动时, computed 用打开瞬间的 Date.now() 算"时间是否已过"会失真.
// 用全局每 30s tick 的 nowRef 让 saveBlockReason / previewOccurrences 自动重算
const nowRef = useNow();

const props = defineProps<{
  open: boolean;
  // 当前提醒时间 (ISO datetime) 和 RRULE; null = 未设
  remindAt: string | null;
  rrule: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  // 保存: remindAt = null 表示清除提醒
  (e: 'save', payload: { remindAt: string | null; rrule: string | null }): void;
}>();

// datetime-local input 要 "YYYY-MM-DDTHH:mm" 格式 (本地时区, 不带 Z)
const localTime = ref('');
const rruleValue = ref<string | null>(null);
const advancedOpen = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);

const PRESETS = [
  { label: '不重复', value: null },
  { label: '每天', value: 'FREQ=DAILY' },
  { label: '工作日', value: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { label: '每周', value: 'FREQ=WEEKLY' },
  { label: '每月', value: 'FREQ=MONTHLY' },
  { label: '每年', value: 'FREQ=YEARLY' },
] as const;

// 当前选中的 preset, 用于高亮按钮
// 规则: textarea 可见且有内容时, 视为"自定义编辑", 6 个 preset 全不高亮 (含"不重复");
//       否则按 rruleValue 匹配预设, null/未设时 "不重复" 高亮
// 直接按 rruleValue 是否匹配预设决定: 匹配 → 高亮对应预设 (含"不重复"); 不匹配 → 'custom' 全不亮.
// 不要加 advancedOpen 判断: 展开过高级再点预设时, rruleValue 变了但 advancedOpen 仍是 true,
// 会让"明明 rruleValue=FREQ=DAILY"的"每天"按钮被强制判为 custom 不亮.
// 注意 ?? 'custom' 会把"不重复"的 null value 错误兜底, 用显式三元保留 null.
const activePreset = computed(() => {
  const v = rruleValue.value;
  const found = PRESETS.find(p => (p.value || null) === (v || null));
  return found ? found.value : 'custom';
});

// ── 中文 GUI: 频率 / 间隔 / 周几 / 月日 / 结束条件 ──
// GUI 状态独立维护. 打开 picker / 进入高级模式时尝试从 rruleValue 反向 parse 同步一次,
// 之后 GUI 任何改动 → watcher 拼字符串覆盖 rruleValue (单向). textarea 也用 rruleValue 双向绑.
const WEEKDAYS = [
  { code: 'MO', label: '一' },
  { code: 'TU', label: '二' },
  { code: 'WE', label: '三' },
  { code: 'TH', label: '四' },
  { code: 'FR', label: '五' },
  { code: 'SA', label: '六' },
  { code: 'SU', label: '日' },
] as const;

type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
type EndMode = 'never' | 'count' | 'until';

const gui = reactive({
  freq: 'DAILY' as Freq,
  interval: 1,
  byday: [] as string[],
  // 默认今天的日号 (1-31), 让 MONTHLY 频率切过来立即有合理值, 不需要用户手填
  bymonthday: dayjs().date() as string | number,
  endMode: 'never' as EndMode,
  endCount: 10,
  endUntil: '', // YYYY-MM-DD
});

const FREQ_UNIT: Record<Freq, string> = { DAILY: '天', WEEKLY: '周', MONTHLY: '月', YEARLY: '年' };

// 用 GUI 状态拼 RRULE 字符串
function buildRrule(): string {
  const parts: string[] = [`FREQ=${gui.freq}`];
  if (gui.interval > 1) parts.push(`INTERVAL=${gui.interval}`);
  if (gui.freq === 'WEEKLY' && gui.byday.length > 0) {
    parts.push(`BYDAY=${gui.byday.join(',')}`);
  }
  if (gui.freq === 'MONTHLY' && gui.bymonthday) {
    parts.push(`BYMONTHDAY=${gui.bymonthday}`);
  }
  if (gui.endMode === 'count' && gui.endCount > 0) {
    parts.push(`COUNT=${gui.endCount}`);
  }
  if (gui.endMode === 'until' && gui.endUntil) {
    // RRULE UNTIL 用 UTC YYYYMMDDTHHMMSSZ. 取当天 23:59:59 当截止. 项目没装 dayjs/utc 插件, 用原生 Date 拼
    const d = new Date(gui.endUntil + 'T23:59:59');
    const pad = (n: number) => String(n).padStart(2, '0');
    const u = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    parts.push(`UNTIL=${u}`);
  }
  return parts.join(';');
}

// 从已有 RRULE 字符串反向 parse 到 GUI (用于打开 picker / 进入高级 时初始化)
function parseRruleToGui(s: string | null | undefined) {
  // 默认重置. bymonthday 用今天的日号兜底, 不留空 (蘑菇 2026-06: 切到 MONTHLY 应该立即有合理值)
  gui.freq = 'DAILY';
  gui.interval = 1;
  gui.byday = [];
  gui.bymonthday = dayjs().date();
  gui.endMode = 'never';
  gui.endCount = 10;
  gui.endUntil = '';
  if (!s) return;
  s.split(';').forEach(part => {
    const [k, v] = part.split('=');
    if (!k || !v) return;
    switch (k.toUpperCase()) {
      case 'FREQ':
        if (['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(v)) gui.freq = v as Freq;
        break;
      case 'INTERVAL': {
        const n = parseInt(v, 10);
        if (!isNaN(n) && n > 0) gui.interval = n;
        break;
      }
      case 'BYDAY':
        // 去掉前缀数字 (如 -1FR / 2MO) 只留两字符 weekday code; GUI 不支持序数, 复杂规则交给 textarea 手编
        gui.byday = v.split(',').map(d => d.replace(/^[+-]?\d+/, '')).filter(d => /^(MO|TU|WE|TH|FR|SA|SU)$/.test(d));
        break;
      case 'BYMONTHDAY': {
        const n = parseInt(v, 10);
        if (!isNaN(n)) gui.bymonthday = n;
        break;
      }
      case 'COUNT': {
        const n = parseInt(v, 10);
        if (!isNaN(n) && n > 0) { gui.endMode = 'count'; gui.endCount = n; }
        break;
      }
      case 'UNTIL': {
        // YYYYMMDDTHHMMSSZ → YYYY-MM-DD (本地)
        const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
        if (m) { gui.endMode = 'until'; gui.endUntil = `${m[1]}-${m[2]}-${m[3]}`; }
        break;
      }
    }
  });
}

function toggleWeekday(code: string) {
  const i = gui.byday.indexOf(code);
  if (i >= 0) gui.byday.splice(i, 1);
  else gui.byday.push(code);
  // 按周一到周日顺序排, 让 RRULE 输出稳定
  const order: string[] = WEEKDAYS.map(w => w.code);
  gui.byday.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

// bymonthday 校验: 0 RRULE 标准不合法, 按 ▲/▼ 跨过时跳 ±1; 空字符串/NaN 回填今天的日号
watch(() => gui.bymonthday, (v, oldV) => {
  if (v === 0) {
    gui.bymonthday = typeof oldV === 'number' && oldV > 0 ? -1 : 1;
    return;
  }
  if (v === '' || v === null || (typeof v === 'number' && isNaN(v))) {
    gui.bymonthday = dayjs().date();
  }
});

// gui 任何字段变化 → 重新拼 RRULE, 但只在 advancedOpen=true 时同步 (避免打开 picker 时 reset gui 触发不必要的更新)
let guiSyncEnabled = false;
watch(gui, () => {
  if (!guiSyncEnabled || !advancedOpen.value) return;
  rruleValue.value = buildRrule();
}, { deep: true });

// "关 sync → 改 gui 字段 → nextTick 后开 sync" 原子化封装.
// 避免每个入口手写 "关-改-开" 三步骤漏掉某一步 (蘑菇 2026-06: selectPreset 漏开导致 GUI 不同步).
// fn 内做需要避免 watch 反向覆盖 rruleValue 的修改 (parseRruleToGui 等).
function withGuiSyncDisabled(fn: () => void) {
  guiSyncEnabled = false;
  fn();
  nextTick(() => { guiSyncEnabled = true; });
}

watch(() => props.open, (v) => {
  if (!v) {
    guiSyncEnabled = false; // picker 关闭时显式禁用, 下次打开靠 withGuiSyncDisabled 重新初始化
    return;
  }
  // 已有提醒: ISO → local datetime; 没有: 默认填明早 9:00 让用户改
  if (props.remindAt) {
    localTime.value = dayjs(props.remindAt).format('YYYY-MM-DDTHH:mm');
  } else {
    localTime.value = dayjs().add(1, 'day').hour(9).minute(0).second(0).format('YYYY-MM-DDTHH:mm');
  }
  rruleValue.value = props.rrule || null;
  advancedOpen.value = !!(props.rrule && !PRESETS.some(p => p.value === props.rrule));
  withGuiSyncDisabled(() => parseRruleToGui(props.rrule));
  nextTick(() => inputEl.value?.focus());
});

// 切到高级模式时也同步一次 GUI (防止用户先点预设 'FREQ=YEARLY' 再展开高级, GUI 还是 DAILY 跟当前 rrule 不一致)
watch(advancedOpen, (v) => {
  if (!v) return;
  withGuiSyncDisabled(() => parseRruleToGui(rruleValue.value));
});

function selectPreset(value: string | null) {
  // 写 rruleValue + 把 GUI 状态对齐到这个预设, 让用户随后在 GUI 微调有正确基线
  withGuiSyncDisabled(() => {
    rruleValue.value = value;
    parseRruleToGui(value);
  });
}

function onSave() {
  if (!localTime.value) {
    emit('save', { remindAt: null, rrule: null });
    emit('update:open', false);
    return;
  }
  // local datetime → ISO; dayjs 默认就当本地时区解析
  const iso = dayjs(localTime.value).toISOString();
  emit('save', { remindAt: iso, rrule: rruleValue.value || null });
  emit('update:open', false);
}

function onClear() {
  emit('save', { remindAt: null, rrule: null });
  emit('update:open', false);
}

function onCancel() {
  emit('update:open', false);
}

// 未来 N 次提醒预览. 从 now 开始算未来触发, 过滤过去 occurrences (用 rule.between(now, future, true))
// 单次提醒 (无 rrule): 时间在未来才算 1 次; 过去时间 → items 空
// 返回 { items, error }: error 非空 = RRULE 解析失败; items=[] = 未来无触发
const PREVIEW_COUNT = 10;
const previewOccurrences = computed<{ items: string[]; error: string | null }>(() => {
  if (!localTime.value) return { items: [], error: null };
  const start = new Date(localTime.value);
  if (isNaN(start.getTime())) return { items: [], error: null };
  const nowMs = nowRef.value; // 响应式 now, picker 开着时每 30s 自动重算

  if (!rruleValue.value || !rruleValue.value.trim()) {
    // 单次: 时间在未来才算
    if (start.getTime() >= nowMs) {
      return { items: [dayjs(start).format('YYYY-MM-DD HH:mm ddd')], error: null };
    }
    return { items: [], error: null };
  }
  try {
    const opts = RRule.parseString(rruleValue.value);
    const rule = new RRule({ ...opts, dtstart: start });
    // 从 now (或 start, 取靠后那个) 算未来 N 次, 跳过过去 occurrences
    const fromD = new Date(Math.max(nowMs, start.getTime()));
    const farD = dayjs(nowMs).add(20, 'year').toDate();
    const occurrences = rule.between(fromD, farD, true).slice(0, PREVIEW_COUNT);
    return {
      items: occurrences.map(d => dayjs(d).format('YYYY-MM-DD HH:mm ddd')),
      error: null,
    };
  } catch (e: any) {
    return { items: [], error: e?.message || 'RRULE 无法解析' };
  }
});

// 保存阻塞原因 (给具体提示, 同时 canSave = 没原因). 优先级: 没填时间 → 时间过去 → RRULE 错 → 未来 0 次
const saveBlockReason = computed(() => {
  if (!localTime.value) return '请填提醒时间';
  const start = new Date(localTime.value);
  if (isNaN(start.getTime())) return '时间格式错误';
  if (start.getTime() < nowRef.value) return '提醒时间已过, 请改成未来';
  if (previewOccurrences.value.error) return 'RRULE 无法解析, 请修正或清空';
  if (previewOccurrences.value.items.length === 0) return '此规则未来无触发 (COUNT 已满或 UNTIL 已过)';
  return '';
});
const canSave = computed(() => !saveBlockReason.value);
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="onCancel" />
        <!-- 整体: flex-col (顶部内容区 + 底部 footer button bar)
             固定高 h-[480px]: 不管 details 折叠 / GUI 切频率 / 预览列表多少, 外形稳定
             宽度 w-96 单栏 / w-[720px] 双栏, width transition
             overflow-hidden: 让内部 footer/border 不溢出圆角 -->
        <!-- 单栏: w-96 + 高度自然 (内容紧贴, 短). 双栏: w-768 + h-480 整体放大.
             宽度必须 ≥ 2*w-96=768 否则右栏溢出被 overflow-hidden 裁切 -->
        <div class="relative bg-white rounded-xl shadow-xl flex flex-col reminder-picker overflow-hidden transition-[width,height] duration-300 ease-out"
             :class="advancedOpen ? 'w-[768px] h-[480px]' : 'w-96'">

          <!-- 顶部内容区 (左右两栏), 占满高度减去 footer -->
          <div class="flex-1 min-h-0 flex">

            <!-- ── 左栏: 基础设置 (始终显示, 自然高度紧贴排列, 不强制拉高) ── -->
            <div class="w-96 p-5 shrink-0 overflow-y-auto">
              <p class="text-sm text-gray-700 mb-3 font-medium">设置提醒</p>

              <label class="block text-xs text-gray-500 mb-1">提醒时间</label>
              <input
                ref="inputEl"
                v-model="localTime"
                type="datetime-local"
                class="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 focus:outline-none focus:border-primary tabular-nums"
                spellcheck="false"
              />

              <label class="block text-xs text-gray-500 mt-4 mb-2">重复规则</label>
              <div class="grid grid-cols-3 gap-2">
                <button
                  v-for="p in PRESETS"
                  :key="String(p.value)"
                  type="button"
                  class="preset-btn"
                  :class="{ 'preset-active': activePreset === p.value }"
                  @click="selectPreset(p.value)"
                >{{ p.label }}</button>
              </div>

              <!-- RRULE 字符串. 仅 advancedOpen=true 时显示, 单栏模式下不出现避免普通用户困惑.
                   单行 input (不支持多行 RRULE, 蘑菇 2026-06: 多行不做), 长了水平滚动 -->
              <template v-if="advancedOpen">
                <label class="block text-xs text-gray-500 mt-4 mb-1">RRULE串</label>
                <input
                  v-model="rruleValue"
                  type="text"
                  placeholder="留空 = 不重复"
                  spellcheck="false"
                  class="w-full px-3 py-2 text-xs rounded-lg border border-gray-200 focus:outline-none focus:border-primary font-mono"
                />
              </template>

              <!-- toggle 右对齐, 跟右栏方向一致 (展开后弹出去的方向) -->
              <div class="mt-3 flex justify-end">
                <button
                  type="button"
                  class="text-xs text-gray-500 hover:text-primary"
                  @click="advancedOpen = !advancedOpen"
                >{{ advancedOpen ? '◀ 收起' : '高级 ▶' }}</button>
              </div>
            </div>

            <!-- ── 右栏: 高级规则 (advancedOpen 才显示) ── -->
            <div v-if="advancedOpen" class="w-96 p-5 shrink-0 border-l border-gray-200 reminder-picker-right space-y-3 overflow-y-auto">
              <p class="text-sm text-gray-700 font-medium">高级规则</p>

            <!-- GUI: 频率 / 间隔 / 周几 / 月日 / 结束条件 -->
            <div class="rrule-gui p-3 rounded-lg border border-gray-200 space-y-2.5">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-xs text-gray-500 shrink-0">频率</span>
                <select v-model="gui.freq" class="rrule-input">
                  <option value="DAILY">每天</option>
                  <option value="WEEKLY">每周</option>
                  <option value="MONTHLY">每月</option>
                  <option value="YEARLY">每年</option>
                </select>
                <span class="text-xs text-gray-500 shrink-0">每</span>
                <input v-model.number="gui.interval" type="number" min="1" max="999"
                  class="rrule-input w-14 text-center tabular-nums" />
                <span class="text-xs text-gray-500 shrink-0">{{ FREQ_UNIT[gui.freq] }}</span>
              </div>

              <div v-if="gui.freq === 'WEEKLY'" class="flex items-center gap-1.5 flex-wrap">
                <span class="text-xs text-gray-500 shrink-0 mr-1">周几</span>
                <button v-for="d in WEEKDAYS" :key="d.code" type="button"
                  class="weekday-btn"
                  :class="{ 'weekday-active': gui.byday.includes(d.code) }"
                  @click="toggleWeekday(d.code)"
                >{{ d.label }}</button>
              </div>

              <div v-if="gui.freq === 'MONTHLY'" class="flex items-center gap-2 flex-wrap">
                <span class="text-xs text-gray-500 shrink-0">每月第</span>
                <input v-model.number="gui.bymonthday" type="number" min="-7" max="31"
                  class="rrule-input w-14 text-center tabular-nums" />
                <span class="text-xs text-gray-500">天（负数为倒数）</span>
              </div>

              <!-- 三个选项行高统一 h-7, 让竖向间距视觉一致 (否则第二/三行带输入框比第一行"永不"高一点)
                   "结束"字也 h-7 + items-center, 跟第一行 radio 中线对齐 -->
              <div class="flex items-start gap-2">
                <span class="text-xs text-gray-500 shrink-0 h-7 flex items-center">结束</span>
                <div class="flex-1 space-y-1.5">
                  <label class="flex items-center gap-2 text-xs cursor-pointer h-7">
                    <input type="radio" v-model="gui.endMode" value="never" class="rrule-radio" />
                    <span>永不</span>
                  </label>
                  <label class="flex items-center gap-2 text-xs cursor-pointer h-7">
                    <input type="radio" v-model="gui.endMode" value="count" class="rrule-radio" />
                    <span>重复</span>
                    <input v-model.number="gui.endCount" type="number" min="1" max="9999"
                      class="rrule-input w-16 text-center tabular-nums"
                      :disabled="gui.endMode !== 'count'" />
                    <span>次</span>
                  </label>
                  <label class="flex items-center gap-2 text-xs cursor-pointer h-7">
                    <input type="radio" v-model="gui.endMode" value="until" class="rrule-radio" />
                    <span>直到</span>
                    <input v-model="gui.endUntil" type="date"
                      class="rrule-input tabular-nums"
                      :disabled="gui.endMode !== 'until'" />
                  </label>
                </div>
              </div>
            </div>

            <!-- 最近 N 次预览. 标题不变, 报错挪到框内用更显眼红色 + 加粗 -->
            <div>
              <p class="text-xs text-gray-500 mb-1">未来 {{ Math.min(previewOccurrences.items.length, PREVIEW_COUNT) }} 次触发时间</p>
              <div class="rrule-preview text-[11px] rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 max-h-32 overflow-y-auto tabular-nums text-gray-600">
                <div v-if="previewOccurrences.error" style="color: #ef4444; font-weight: 600;">
                  RRULE 无法解析：{{ previewOccurrences.error }}<br />
                  请检查或清空 RRULE 串后再保存
                </div>
                <div v-else-if="previewOccurrences.items.length === 0" class="text-gray-400">{{ localTime ? '此规则未来无触发 (时间已过 / COUNT 已满 / UNTIL 已过)' : '(填写提醒时间后预览)' }}</div>
                <div v-else v-for="(t, i) in previewOccurrences.items" :key="i">{{ t }}</div>
              </div>
            </div>

            <details>
              <summary class="text-[11px] text-gray-500 hover:text-primary cursor-pointer select-none">什么是 RRULE? 怎么写?</summary>
              <div class="mt-2 text-[11px] text-gray-500 leading-relaxed space-y-1.5 bg-gray-50 rounded-lg p-2.5">
                <p>RRULE 是 <span class="font-mono text-gray-700">RFC 5545</span> 日历重复规则标准 — Google 日历、Apple 日历、Outlook 都用同一套语法。</p>
                <p class="font-medium text-gray-600">常用示例:</p>
                <ul class="space-y-0.5 font-mono text-[10.5px] text-gray-600">
                  <li>每周二四: <span class="bg-white px-1 rounded">FREQ=WEEKLY;BYDAY=TU,TH</span></li>
                  <li>工作日: <span class="bg-white px-1 rounded">FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR</span></li>
                  <li>每两天: <span class="bg-white px-1 rounded">FREQ=DAILY;INTERVAL=2</span></li>
                  <li>每月最后周五: <span class="bg-white px-1 rounded">FREQ=MONTHLY;BYDAY=-1FR</span></li>
                  <li>共 10 次: <span class="bg-white px-1 rounded">FREQ=DAILY;COUNT=10</span></li>
                </ul>
                <p>可视化生成器:
                  <a href="https://jkbrzt.github.io/rrule/" target="_blank" rel="noopener" class="text-primary hover:underline">jkbrzt.github.io/rrule</a>
                  (写好后复制粘贴到上面框里)
                </p>
                <p class="text-gray-400">DTSTART 不用写, 后端会用上面"提醒时间"补</p>
              </div>
            </details>
            </div>
          </div>

          <!-- 底部 footer: 跨整个 picker 宽度. 不放进左栏内部, 避免左栏被拉高出现空白 -->
          <div class="border-t border-gray-200 px-5 py-3 flex items-center justify-between reminder-picker-footer">
            <button
              v-if="remindAt"
              type="button"
              class="px-3 py-1.5 text-xs rounded-lg text-red-500 bg-red-50 hover:bg-red-100"
              @click="onClear"
            >清除提醒</button>
            <span v-else></span>
            <div class="flex gap-2">
              <button
                type="button"
                class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                @click="onCancel"
              >取消</button>
              <button
                type="button"
                class="px-4 py-1.5 text-xs rounded-lg font-medium text-white bg-primary hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary"
                :disabled="!canSave"
                :title="saveBlockReason"
                @click="onSave"
              >保存</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<!-- 样式全部挪到 src/style.css (Vue scoped + :global + Teleport 联合下 dark 规则会被编译器吞,
     为了避免 light/dark 分散两处, 现在 light 也一起搬过去, 集中维护) -->
