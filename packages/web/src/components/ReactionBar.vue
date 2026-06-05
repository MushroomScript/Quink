<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, type NoteReactionSummaryItem } from '@/api';

// PR #6: 5 个固定 emoji, 跟后端 ALLOWED_REACTION_EMOJIS 同一份. 不让用户自定义防垃圾/兼容性问题
const ALLOWED_EMOJIS = ['👍', '❤️', '🤔', '✅', '😂'] as const;

const props = defineProps<{
  noteId: string;
  summary: NoteReactionSummaryItem[];
  // 'full' 永远渲染 5 个胶囊 + 可 toggle (NoteDetail/NoteEditModal 用)
  // 'compact' 只显示 count>0 的 + readonly (NoteCard 用, 点 NoteCard 进详情交互)
  mode?: 'full' | 'compact';
}>();
const emit = defineEmits<{ 'update:summary': [NoteReactionSummaryItem[]] }>();

const busy = ref(false);
// 早期版本有 interactive prop, 但 Vue 3 对 Boolean 类型 prop 不传时默认 = false (special casting),
// 让 NoteDetail 没传时被 cast 成 false → readonly bug. 简化: mode 直接控制 readonly 与否
const isInteractive = computed(() => props.mode !== 'compact');

// 把 summary 按 emoji 做索引方便取. 缺失的 emoji 视为 count=0/mine=false
const summaryMap = computed(() => {
  const m = new Map<string, NoteReactionSummaryItem>();
  for (const s of props.summary) m.set(s.emoji, s);
  return m;
});

// 渲染列表: full 走全部 5 个 (即使 count=0); compact 过滤只留 count>0 的, 没数据整行不渲染
const displayed = computed(() => {
  const list = ALLOWED_EMOJIS.map(e => summaryMap.value.get(e) || { emoji: e, count: 0, mine: false });
  return props.mode === 'compact' ? list.filter(i => i.count > 0) : list;
});

async function toggle(emoji: string) {
  if (!isInteractive.value || busy.value) return;
  busy.value = true;
  // 乐观更新: 先 emit 新 summary 让父立刻 UI 反映, await API 失败时还原.
  const prev = props.summary;
  emit('update:summary', applyToggleLocally(prev, emoji));
  try {
    const { data } = await api.toggleNoteReaction(props.noteId, emoji);
    emit('update:summary', data.summary);
  } catch (e: any) {
    emit('update:summary', prev);
    console.error('[ReactionBar] toggle failed:', e);
  } finally {
    busy.value = false;
  }
}

function applyToggleLocally(summary: NoteReactionSummaryItem[], emoji: string): NoteReactionSummaryItem[] {
  // summary 可能不含某 emoji (后端固定 5 个会返全, 但本地兜底), 缺时按 mine=false count=0 起算
  const map = new Map<string, NoteReactionSummaryItem>();
  for (const s of summary) map.set(s.emoji, s);
  const cur = map.get(emoji) || { emoji, count: 0, mine: false };
  map.set(emoji, { emoji, mine: !cur.mine, count: cur.mine ? cur.count - 1 : cur.count + 1 });
  return ALLOWED_EMOJIS.map(e => map.get(e) || { emoji: e, count: 0, mine: false });
}
</script>

<template>
  <div v-if="displayed.length > 0" class="reaction-bar flex items-center flex-wrap" :class="mode === 'compact' ? 'gap-2' : 'gap-1.5'">
    <button
      v-for="item in displayed"
      :key="item.emoji"
      type="button"
      class="reaction-btn"
      :class="{ mine: item.mine, 'is-compact': mode === 'compact', 'is-static': !isInteractive }"
      :disabled="busy"
      :title="isInteractive ? (item.mine ? '取消' : '加') : ''"
      @click.stop="isInteractive ? toggle(item.emoji) : null"
    >
      <span class="emoji">{{ item.emoji }}</span>
      <span v-if="item.count > 0" class="count tabular-nums">{{ item.count }}</span>
    </button>
  </div>
</template>

<style scoped>
.reaction-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.8125rem;
  line-height: 1.25;
  background-color: rgb(243 244 246);
  color: rgb(75 85 99);
  border: 1px solid transparent;
  transition: background-color 0.15s, color 0.15s, transform 0.1s;
  user-select: none;
  white-space: nowrap;
}
.reaction-btn:hover {
  background-color: rgb(229 231 235);
}
.reaction-btn:active {
  transform: scale(0.95);
}
.reaction-btn.mine {
  background-color: rgb(var(--c-accent-light));
  color: rgb(var(--c-accent-dark));
  border-color: rgb(var(--c-accent) / 0.4);
}
.reaction-btn.mine:hover {
  background-color: rgb(var(--c-accent) / 0.25);
}
.reaction-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}
.reaction-btn.is-compact {
  padding: 0;
  background-color: transparent !important;
  border-color: transparent !important;
  font-size: 0.75rem;
  color: rgb(107 114 128);
}
.reaction-btn.is-compact:hover {
  background-color: transparent !important;
  color: rgb(75 85 99);
}
.reaction-btn.is-compact.mine {
  color: rgb(var(--c-accent-dark));
}
.reaction-btn.is-static {
  cursor: default;
}
.reaction-btn.is-static:active {
  transform: none;
}
.emoji {
  font-size: 1rem;
  line-height: 1;
  /* Segoe UI Emoji / Apple Color Emoji 的 glyph 在 em-box 内贴 baseline (偏底 ~1px),
     span box 在胶囊中心但 emoji 字符本身视觉偏下. translateY 视觉补偿不影响 layout */
  transform: translateY(-1px);
}
.is-compact .emoji {
  font-size: 0.9375rem;
}
.count {
  font-size: 0.75rem;
  font-weight: 500;
}

/* 暗色主题适配: 跟 style.css 项目约定 (bg-gray-100=0.05 / hover=0.14 / accent 高亮=0.22) 同档,
   原 0.06/0.12/0.25 在深色主背景 (#1e1e2a) 上对比度太弱, 胶囊框几乎隐形 */
[data-theme="dark"] .reaction-btn {
  background-color: rgb(255 255 255 / 0.10);
  color: rgb(255 255 255 / 0.8);
}
[data-theme="dark"] .reaction-btn:hover {
  background-color: rgb(255 255 255 / 0.18);
}
[data-theme="dark"] .reaction-btn.mine {
  background-color: rgb(var(--c-accent) / 0.35);
  color: rgb(var(--c-accent-light));
  border-color: rgb(var(--c-accent) / 0.55);
}
[data-theme="dark"] .reaction-btn.mine:hover {
  background-color: rgb(var(--c-accent) / 0.45);
}
[data-theme="dark"] .reaction-btn.is-compact {
  color: rgb(255 255 255 / 0.55);
}
[data-theme="dark"] .reaction-btn.is-compact:hover {
  color: rgb(255 255 255 / 0.75);
}
</style>
