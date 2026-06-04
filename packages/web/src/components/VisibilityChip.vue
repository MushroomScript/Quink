<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useGroupsStore } from '@/stores/groups';
import { resolveFileUrl, resolveFileThumbUrl, thumbErrorFallback } from '@/utils/fileUrl';
import { PhLock, PhUsersThree, PhCaretDown, PhCheck, PhX } from '@phosphor-icons/vue';

// PR #2 编辑器底栏可见性 chip
// modelValue: { visibility: 'private' | 'shared', sharedGroupIds: string[] }
// 实时双向绑定 (单击群项即改, 不需要 "确定" 按钮). 点 chip 外关闭 popover
const props = defineProps<{
  modelValue: { visibility: 'private' | 'shared'; sharedGroupIds: string[] };
  // compact: true 时 chip 更小 (移动端 / Capture 紧凑场景)
  compact?: boolean;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: { visibility: 'private' | 'shared'; sharedGroupIds: string[] }): void }>();

const groupsStore = useGroupsStore();

// chip 文案: private="私密" / shared="已发到 N 群"
const chipLabel = computed(() => {
  if (props.modelValue.visibility === 'private') return '私密';
  const n = props.modelValue.sharedGroupIds.length;
  return n === 0 ? '已分享' : `已发到 ${n} 群`;
});

const isShared = computed(() => props.modelValue.visibility === 'shared');

// 切换 private / shared 大类: shared 自动选所有群? 不, 让用户主动勾, 切到 shared 时打开 popover 强引导
function setPrivate() {
  emit('update:modelValue', { visibility: 'private', sharedGroupIds: [] });
}

// 单击群项: toggle 选中. 至少 1 个时是 shared, 全清回 private
function toggleGroup(groupId: string) {
  const cur = props.modelValue.sharedGroupIds;
  const next = cur.includes(groupId)
    ? cur.filter(id => id !== groupId)
    : [...cur, groupId];
  if (next.length === 0) {
    emit('update:modelValue', { visibility: 'private', sharedGroupIds: [] });
  } else {
    emit('update:modelValue', { visibility: 'shared', sharedGroupIds: next });
  }
}

// ── popover 定位 ──
const open = ref(false);
const chipEl = ref<HTMLElement | null>(null);
const popoverEl = ref<HTMLElement | null>(null);
// popover 用 Teleport + fixed, 跟随 chip 位置. resize/scroll 时重算
const popoverStyle = ref<{ top?: string; left?: string; bottom?: string; right?: string }>({});

function recalcPosition() {
  if (!open.value || !chipEl.value || !popoverEl.value) return;
  const chip = chipEl.value.getBoundingClientRect();
  const pop = popoverEl.value.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const M = 8; // 视口边距
  // 默认 chip 上方弹 (编辑器底栏 chip 在底, popover 上展开看到更多群)
  let top = chip.top - pop.height - 6;
  let bottom: number | undefined;
  if (top < M) {
    // 上面空间不够 → 改下方弹
    top = chip.bottom + 6;
    if (top + pop.height > vh - M) {
      // 下面也不够 → 顶部贴齐 (popover 高 > 视口)
      top = M;
    }
  }
  // 左右: 跟 chip 左对齐, 右溢出则贴右边
  let left = chip.left;
  if (left + pop.width > vw - M) left = vw - pop.width - M;
  if (left < M) left = M;
  popoverStyle.value = { top: `${top}px`, left: `${left}px` };
  void bottom;
}

watch(open, async (v) => {
  if (v) {
    await nextTick();
    recalcPosition();
  }
});

function toggleOpen() { open.value = !open.value; }

// 点 popover 外关闭. capture 在 popover 内点不算 (target 链 closest)
function onDocClick(e: MouseEvent) {
  if (!open.value) return;
  const t = e.target as HTMLElement;
  if (chipEl.value?.contains(t)) return; // 点 chip 本身让 toggleOpen 处理
  if (popoverEl.value?.contains(t)) return;
  open.value = false;
}

function onResize() { if (open.value) recalcPosition(); }

onMounted(() => {
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
  <!-- Chip: private 灰色锁 / shared 蓝色多人 icon. 点击 toggle popover -->
  <button ref="chipEl" type="button" @click.stop="toggleOpen"
    class="inline-flex items-center gap-1 rounded-full text-xs font-medium transition-colors"
    :class="[
      compact ? 'px-2 py-0.5' : 'px-2.5 py-1',
      isShared ? 'bg-primary-light text-primary-dark hover:bg-primary/15' : 'bg-gray-100 text-gray-500 hover:bg-gray-200',
    ]"
    :title="isShared ? `已发到 ${modelValue.sharedGroupIds.length} 个群组, 点击调整` : '仅你可见, 点击分享到群组'">
    <PhLock v-if="!isShared" :size="compact ? '0.625rem' : '0.75rem'" weight="fill" />
    <PhUsersThree v-else :size="compact ? '0.625rem' : '0.75rem'" weight="fill" />
    <span>{{ chipLabel }}</span>
    <PhCaretDown :size="compact ? '0.5rem' : '0.625rem'" weight="bold" class="opacity-60 transition-transform" :class="{ 'rotate-180': open }" />
  </button>

  <!-- Popover: Teleport 到 body, fixed 定位, 实时 toggle 群 (无确定按钮) -->
  <Teleport to="body">
    <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100" leave-active-class="transition duration-75 ease-in"
      leave-from-class="opacity-100 scale-100" leave-to-class="opacity-0 scale-95">
      <div v-if="open" ref="popoverEl"
        class="fixed z-[var(--z-popover)] w-64 bg-white rounded-xl shadow-xl py-2 origin-bottom"
        style="border: 1px solid var(--sb-border)"
        :style="popoverStyle">
        <!-- 私密选项: 单独一行, 单击切到 private -->
        <button type="button" @click="setPrivate"
          class="w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-gray-50"
          :class="!isShared ? 'bg-primary/5' : ''">
          <PhLock size="0.875rem" weight="fill" class="text-gray-500" />
          <span class="flex-1">仅自己可见</span>
          <PhCheck v-if="!isShared" size="0.75rem" weight="bold" class="text-primary" />
        </button>
        <div style="border-top: 1px solid var(--sb-border); margin: 4px 0" />
        <!-- 群列表: 用户所在所有群, 单击 toggle -->
        <div class="px-3 py-1 text-[10px] font-medium text-gray-400">分享到群组</div>
        <div v-if="groupsStore.groups.length === 0" class="px-3 py-3 text-xs text-gray-400 text-center">
          还没群组, 去左侧"群组"建一个
        </div>
        <div v-else class="max-h-60 overflow-y-auto">
          <button v-for="g in groupsStore.groups" :key="g.id"
            type="button" @click="toggleGroup(g.id)"
            class="w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-gray-50"
            :class="modelValue.sharedGroupIds.includes(g.id) ? 'bg-primary/5' : ''">
            <img v-if="g.avatar" :src="resolveFileThumbUrl(g.avatar)"
              @error="thumbErrorFallback($event, resolveFileUrl(g.avatar))"
              class="w-5 h-5 rounded-md object-cover shrink-0" alt="" />
            <div v-else class="w-5 h-5 rounded-md bg-primary/15 text-primary-dark flex items-center justify-center shrink-0">
              <PhUsersThree size="0.625rem" weight="fill" />
            </div>
            <span class="flex-1 truncate">{{ g.name }}</span>
            <PhCheck v-if="modelValue.sharedGroupIds.includes(g.id)" size="0.75rem" weight="bold" class="text-primary" />
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
