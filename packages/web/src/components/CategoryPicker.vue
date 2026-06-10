<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { api, type Category } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useSseSync } from '@/utils/sseSync';
import { unzoomRect, unzoomViewport } from '@/utils/zoom';
import { PhFolderOpen, PhFolder, PhCaretDown, PhCheck } from '@phosphor-icons/vue';

// 编辑器底栏分类 chip. modelValue: string | null
//   null = 走默认 (AI 自动分类开 → 显示"自动", 关 → 显示"未分类"). category 字段为空, 后端 autoClassify 会回填
//   "工作" 等具体字符串 = 用户已选, 后端 autoClassify 只在 category 为 null 时回填 → 用户选过不会被覆盖
// 跟 VisibilityChip 同款 Teleport popover + unzoomRect 定位 (CSS zoom 兼容)
const props = defineProps<{
  modelValue: string | null;
  compact?: boolean;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string | null): void }>();

const auth = useAuthStore();
// AI 自动分类开关 → 决定 null 状态显示文案. 未读到用户偏好时默认 true (跟后端 prefs.autoCategorize !== false 同语义)
const autoCategorizeEnabled = computed(() => auth.user?.preferences?.autoCategorize !== false);

// 自己 load + SSE 同步, 跟 Sidebar 同款模式. picker 弹出前已有数据 (mount 时拉)
const categories = ref<Category[]>([]);
async function loadCategories() {
  try {
    const res = await api.getCategories();
    categories.value = res.data;
  } catch {}
}
useSseSync('categories', loadCategories);

const isAuto = computed(() => props.modelValue === null);

// chip 文案: null + 开 = "自动" / null + 关 = "未分类" / 具体值 = 直接显示
const chipLabel = computed(() => {
  if (props.modelValue) return props.modelValue;
  return autoCategorizeEnabled.value ? '自动' : '未分类';
});

function pickAuto() {
  emit('update:modelValue', null);
  open.value = false;
}

function pickCategory(name: string) {
  // 同一项再点 = 切回自动 (顶部"恢复默认"语义统一)
  if (props.modelValue === name) {
    emit('update:modelValue', null);
  } else {
    emit('update:modelValue', name);
  }
  open.value = false;
}

// ── popover 定位 (跟 VisibilityChip 同款) ──
const open = ref(false);
const chipEl = ref<HTMLElement | null>(null);
const popoverEl = ref<HTMLElement | null>(null);
const popoverTop = ref('');
const popoverLeft = ref('');

function recalcPosition() {
  if (!open.value || !chipEl.value || !popoverEl.value) return;
  const chip = unzoomRect(chipEl.value);
  const pop = unzoomRect(popoverEl.value);
  // 跟 VisibilityChip 同款: w-64 hardcode 256 (Vue Transition enter 早期 scale-95 状态测量不准)
  const popW = 256;
  const popH = pop.height;
  const { vw, vh } = unzoomViewport();
  const M = 8;
  // 默认 chip 上方弹 (编辑器底栏 chip 在底, 上展开露更多分类)
  let top = chip.top - popH - 6;
  if (top < M) {
    top = chip.bottom + 6;
    if (top + popH > vh - M) top = M;
  }
  let left = chip.left;
  if (left + popW > vw - M) left = vw - popW - M;
  if (left < M) left = M;
  const topStr = `${top}px`;
  const leftStr = `${left}px`;
  if (popoverTop.value !== topStr) popoverTop.value = topStr;
  if (popoverLeft.value !== leftStr) popoverLeft.value = leftStr;
}

watch(open, async (v) => {
  if (v) {
    await nextTick();
    recalcPosition();
  }
});

function toggleOpen() {
  // 打开 popover 时主动 reload: sidebar 拖动排序是同设备操作, SSE 会 isMyEvent 跳过本机, 这里补一次拿最新顺序
  // 关闭不 reload (省请求)
  if (!open.value) loadCategories();
  open.value = !open.value;
}

function onDocClick(e: MouseEvent) {
  if (!open.value) return;
  const t = e.target as HTMLElement;
  if (chipEl.value?.contains(t)) return;
  if (popoverEl.value?.contains(t)) return;
  open.value = false;
}

function onResize() { if (open.value) recalcPosition(); }

onMounted(() => {
  loadCategories();
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
      isAuto ? 'bg-gray-100 text-gray-500 hover:bg-gray-200' : 'bg-primary-light text-primary-dark hover:bg-primary/15',
    ]"
    :title="isAuto ? (autoCategorizeEnabled ? '由 AI 自动分类, 点击手动选择' : '未设置分类, 点击选择') : `分类: ${modelValue}, 点击修改`">
    <PhFolder v-if="isAuto" :size="compact ? '0.625rem' : '0.75rem'" weight="fill" />
    <PhFolderOpen v-else :size="compact ? '0.625rem' : '0.75rem'" weight="fill" />
    <span>{{ chipLabel }}</span>
    <PhCaretDown :size="compact ? '0.5rem' : '0.625rem'" weight="bold" class="opacity-60 transition-transform" :class="{ 'rotate-180': open }" />
  </button>

  <Teleport to="body">
    <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95"
      leave-active-class="transition duration-75 ease-in" leave-to-class="opacity-0 scale-95">
      <div v-if="open" ref="popoverEl"
        class="fixed z-[var(--z-overlay)] w-64 bg-white rounded-xl shadow-xl py-2 origin-bottom flex flex-col"
        :style="{ border: '1px solid var(--sb-border)', top: popoverTop, left: popoverLeft, maxHeight: '90vh' }">
        <!-- 兜底项: 开关开 → "自动", 关 → "未分类". 都对应 category = null -->
        <button type="button" @click="pickAuto"
          class="w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-gray-50 shrink-0"
          :class="isAuto ? 'bg-primary/5' : ''">
          <PhFolder size="0.875rem" weight="fill" class="text-gray-500" />
          <span class="flex-1">{{ autoCategorizeEnabled ? '自动 (由 AI 分类)' : '未分类' }}</span>
          <PhCheck v-if="isAuto" size="0.75rem" weight="bold" class="text-primary" />
        </button>
        <div class="shrink-0" style="border-top: 1px solid var(--sb-border); margin: 4px 0" />
        <div class="px-3 py-1 text-[10px] font-medium text-gray-400 shrink-0">选择分类</div>
        <div v-if="categories.length === 0" class="px-3 py-3 text-xs text-gray-400 text-center shrink-0">
          还没分类, 去左侧"分类"建一个
        </div>
        <!-- 列表: flex-1 min-h-0 让它占满 popover 剩余空间, 内容多于剩余空间时内部滚动. Capture 小窗口下整体被 max-h-[90vh] 兜住 -->
        <div v-else class="flex-1 min-h-0 overflow-y-auto">
          <!-- 一级分类 (root): 系统只支持一级, child 已废弃, 不渲染 -->
          <button v-for="cat in categories" :key="cat.id" type="button" @click="pickCategory(cat.name)"
            class="w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-gray-50"
            :class="modelValue === cat.name ? 'bg-primary/5' : ''">
            <PhFolderOpen size="0.875rem" weight="fill" class="text-gray-500" />
            <span class="flex-1 truncate">{{ cat.name }}</span>
            <PhCheck v-if="modelValue === cat.name" size="0.75rem" weight="bold" class="text-primary" />
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
