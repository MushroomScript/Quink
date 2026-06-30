<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useGroupsStore } from '@/stores/groups';
import { unzoomRect, unzoomViewport } from '@/utils/zoom';
import { PhListChecks, PhCaretDown, PhCheck } from '@phosphor-icons/vue';
import DatePicker from '@/components/DatePicker.vue';
import CustomSelect from '@/components/CustomSelect.vue';

// 群组待办类型 chip (仅 type=todo + shared 时由 RichEditor 渲染, 见 GROUP-TODO-DESIGN.md)
// modelValue.rosterDueAt 存 DatePicker 的本地 datetime 格式 (YYYY-MM-DDTHH:mm); RichEditor submit 时转 ISO.
const props = defineProps<{
  modelValue: { todoGroupMode: 'group' | 'everyone'; rosterDueAt: string | null; rosterVisibility: 'count' | 'full' | 'none' };
  sharedGroupIds: string[];
  compact?: boolean;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: { todoGroupMode: 'group' | 'everyone'; rosterDueAt: string | null; rosterVisibility: 'count' | 'full' | 'none' }): void }>();

const groupsStore = useGroupsStore();

// 每人完成只能: 单群 + 我是该群 owner/admin (后端 isAdminOfGroups 二次校验)
const canEveryone = computed(() => {
  if (props.sharedGroupIds.length !== 1) return false;
  const role = groupsStore.groups.find(g => g.id === props.sharedGroupIds[0])?.myRole;
  return role === 'owner' || role === 'admin';
});

const isEveryone = computed(() => props.modelValue.todoGroupMode === 'everyone');
const chipLabel = computed(() => isEveryone.value ? '每人完成' : '群级待办');

function setMode(mode: 'group' | 'everyone') {
  if (mode === 'everyone' && !canEveryone.value) return;
  emit('update:modelValue', { ...props.modelValue, todoGroupMode: mode });
}
function setDue(v: string | null) { emit('update:modelValue', { ...props.modelValue, rosterDueAt: v }); }
function setVisibility(v: string | number | null) { emit('update:modelValue', { ...props.modelValue, rosterVisibility: v as 'count' | 'full' | 'none' }); }

// 分享群变化导致不再满足"每人完成"条件 (改多群/换成非管理员群) → 自动降级 group
watch(() => props.sharedGroupIds, () => {
  if (isEveryone.value && !canEveryone.value) emit('update:modelValue', { ...props.modelValue, todoGroupMode: 'group' });
});

const visibilityOptions = [
  { value: 'count', label: '仅完成人数' },
  { value: 'full', label: '完整名单' },
  { value: 'none', label: '不显示进度' },
];

// ── popover 定位 (照 VisibilityChip, CSS zoom 用 unzoomRect/unzoomViewport) ──
const open = ref(false);
const chipEl = ref<HTMLElement | null>(null);
const popoverEl = ref<HTMLElement | null>(null);
const popoverTop = ref('');
const popoverLeft = ref('');

function recalcPosition() {
  if (!open.value || !chipEl.value || !popoverEl.value) return;
  const chip = unzoomRect(chipEl.value);
  const pop = unzoomRect(popoverEl.value);
  const popW = 240;
  const popH = pop.height;
  const { vw, vh } = unzoomViewport();
  const M = 8;
  let top = chip.top - popH - 6;
  if (top < M) {
    top = chip.bottom + 6;
    if (top + popH > vh - M) top = M;
  }
  let left = chip.left;
  if (left + popW > vw - M) left = vw - popW - M;
  if (left < M) left = M;
  const topStr = `${top}px`, leftStr = `${left}px`;
  if (popoverTop.value !== topStr) popoverTop.value = topStr;
  if (popoverLeft.value !== leftStr) popoverLeft.value = leftStr;
}
watch(open, async (v) => { if (v) { await nextTick(); recalcPosition(); } });
// 选"每人完成"后 popover 展开截止+可见性变高, 重算位置防向下溢出盖住 chip (origin-bottom 向上弹)
watch(isEveryone, async () => { if (open.value) { await nextTick(); recalcPosition(); } });
function toggleOpen() { open.value = !open.value; }
function onDocClick(e: MouseEvent) {
  if (!open.value) return;
  const t = e.target as HTMLElement;
  if (chipEl.value?.contains(t)) return;
  if (popoverEl.value?.contains(t)) return;
  // 嵌套的 DatePicker (.qdp-popup/.qdp-backdrop) / CustomSelect (.qsel-popup) Teleport 到 body, 不在 popoverEl 内.
  // 点它们 (选截止/可见性) 不该关本 popover, 否则整个 TodoModeChip popover 连同子组件一起卸载, 点了像没反应
  if (t.closest('.qdp-popup, .qdp-backdrop, .qsel-popup')) return;
  open.value = false;
}
function onResize() { if (open.value) recalcPosition(); }
onMounted(() => {
  if (groupsStore.groups.length === 0) groupsStore.loadGroups().catch(() => {});
  document.addEventListener('click', onDocClick, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onResize, true);
});
onUnmounted(() => {
  document.removeEventListener('click', onDocClick, true);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('scroll', onResize, true);
});
</script>

<template>
  <button ref="chipEl" type="button" @click.stop="toggleOpen"
    class="inline-flex items-center gap-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap shrink-0"
    :class="[
      compact ? 'px-2 py-0.5' : 'px-2.5 py-1',
      isEveryone ? 'bg-primary-light text-primary-dark hover:bg-primary/15' : 'bg-gray-100 text-gray-500 hover:bg-gray-200',
    ]"
    title="待办类型: 群级(管理员统一标记) / 每人完成(成员各自标记)">
    <PhListChecks :size="compact ? '0.625rem' : '0.75rem'" weight="fill" />
    <span>{{ chipLabel }}</span>
    <PhCaretDown :size="compact ? '0.5rem' : '0.625rem'" weight="bold" class="opacity-60 transition-transform" :class="{ 'rotate-180': open }" />
  </button>

  <Teleport to="body">
    <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95"
      leave-active-class="transition duration-75 ease-in" leave-to-class="opacity-0 scale-95">
      <!-- z 用 --z-modal(200) 而非 VisibilityChip 的 --z-overlay(9999): 内嵌 DatePicker(300)/CustomSelect(1000) 要能盖在本 popover 之上 -->
      <div v-if="open" ref="popoverEl"
        class="fixed z-[var(--z-modal)] w-60 bg-white rounded-xl shadow-xl py-2 origin-bottom"
        :style="{ border: '1px solid var(--sb-border)', top: popoverTop, left: popoverLeft }">
        <div class="px-3 py-1 text-[10px] font-medium text-gray-400">待办类型</div>
        <button type="button" @click="setMode('group')"
          class="w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-gray-50"
          :class="!isEveryone ? 'bg-primary/5' : ''">
          <span class="flex-1">群级待办 <span class="text-gray-400">(管理员统一标记完成)</span></span>
          <PhCheck v-if="!isEveryone" size="0.75rem" weight="bold" class="text-primary" />
        </button>
        <button type="button" @click="setMode('everyone')" :disabled="!canEveryone"
          class="w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors"
          :class="[isEveryone ? 'bg-primary/5' : '', canEveryone ? 'hover:bg-gray-50' : 'opacity-40 cursor-not-allowed']">
          <span class="flex-1">每人完成 <span class="text-gray-400">(成员各自标记)</span></span>
          <PhCheck v-if="isEveryone" size="0.75rem" weight="bold" class="text-primary" />
        </button>
        <p v-if="!canEveryone" class="px-3 pt-0.5 pb-1 text-[10px] text-gray-400 leading-snug">「每人完成」需分享到 1 个你管理的群</p>
        <template v-if="isEveryone">
          <div style="border-top: 1px solid var(--sb-border); margin: 4px 0" />
          <div class="px-3 py-1 space-y-2">
            <div>
              <div class="text-[10px] font-medium text-gray-400 mb-1">截止时间(超时自动完成)</div>
              <DatePicker :model-value="modelValue.rosterDueAt ?? ''" type="datetime" placeholder="不设截止" @update:model-value="setDue($event || null)" />
            </div>
            <div>
              <div class="text-[10px] font-medium text-gray-400 mb-1">成员可见范围</div>
              <CustomSelect :model-value="modelValue.rosterVisibility" size="sm" :options="visibilityOptions" @update:model-value="setVisibility" />
            </div>
          </div>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>
