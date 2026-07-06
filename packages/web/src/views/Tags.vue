<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, provide, watch } from 'vue';
import { sharedPageCount } from '@/composables/usePageCount';
import { api, isLoggedIn } from '@/api';
import { useNotesStore } from '@/stores/notes';
import { useRouter } from 'vue-router';
import { PhTag, PhPencilSimple, PhXCircle } from '@phosphor-icons/vue';
import { fadeOutLeave, snapshotCards } from '@/utils/cardLeave';
import { pinyinMatch } from '@/utils/pinyin';
import { useEscToClose } from '@/composables/useEscToClose';

const store = useNotesStore();
const router = useRouter();
const allTags = ref<string[]>([]);
// TopBar 搜索框的 store.searchQuery 在标签页用作标签名过滤
// pinyinMatch 支持拼音搜索: 输入 zb/zhoubao 都能命中"周报"
const visibleTags = computed(() => {
  const q = store.searchQuery?.trim();
  if (!q) return allTags.value;
  return allTags.value.filter(t => pinyinMatch(t, q));
});
const pageCount = computed(() => visibleTags.value.length);
onMounted(() => {
  sharedPageCount.value = pageCount.value;
  watch(pageCount, (v) => { sharedPageCount.value = v; });
});
onUnmounted(() => { sharedPageCount.value = -1; });
const loading = ref(true);
const editingTag = ref('');
const newName = ref('');
const confirmDeleteTag = ref('');
useEscToClose(editingTag, '');
useEscToClose(confirmDeleteTag, '');

async function load() {
  if (!isLoggedIn()) return;
  loading.value = true;
  try { allTags.value = (await api.getTags()).data; } catch {}
  loading.value = false;
}

function filterByTag(tag: string) {
  // 走 store 一次性传递, 不带 url query (标签不进网址, 清筛选后刷新不会重现)
  store.pendingTagFilter = tag;
  router.push('/quink');
}

async function renameTag() {
  if (!editingTag.value || !newName.value.trim()) return;
  const old = editingTag.value;
  const renamed = newName.value.trim();
  try {
    const res = await api.getNotes({ tag: old, limit: '1000' });
    for (const note of res.data) {
      const tags = (note.tags as string[]).map(t => t === old ? renamed : t);
      await api.updateNote(note.id, { tags } as any);
    }
    editingTag.value = '';
    newName.value = '';
    await load();
  } catch {}
}

async function doDeleteTag() {
  const tag = confirmDeleteTag.value;
  confirmDeleteTag.value = '';
  if (!tag) return;
  // 乐观更新：立即从 UI 移除，触发淡出动画，API 后台跑
  allTags.value = allTags.value.filter(t => t !== tag);
  try {
    const res = await api.getNotes({ tag, limit: '1000' });
    for (const note of res.data) {
      const tags = (note.tags as string[]).filter(t => t !== tag);
      await api.updateNote(note.id, { tags } as any);
    }
  } catch (err) {
    console.error('[Tags] 删除标签失败', err);
    await load();
  }
}

onMounted(() => {
  load();
  window.addEventListener('quink-refresh', load);
});
onUnmounted(() => {
  window.removeEventListener('quink-refresh', load);
});

// 数据变更前主动 snapshot 所有卡片位置，避免 onLeave 钩子里拿到的是 v-if 切换后的错位坐标
// 用 visibleTags(不是 allTags) — 搜索过滤时标签数变化也要触发 fadeOutLeave 动画
watch(() => visibleTags.value.length, () => snapshotCards(), { flush: 'sync' });
</script>

<template>
  <div class="px-4 md:px-8 py-6">
    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <template v-else>
      <div v-if="allTags.length === 0" class="empty-state-center">
        <div class="mb-3 flex justify-center text-gray-300">
          <PhTag size="3rem" weight="fill" />
        </div>
        <p class="text-gray-500 text-sm">还没有标签</p>
        <p class="text-gray-400 text-xs mt-1">笔记保存后 AI 会自动生成标签</p>
      </div>

      <!-- Tag chip 交互 (蘑菇 2026-07-06 统一 NoteDetail): 桌面 hover 时 overlay 覆盖 tag 名 (编辑 + 叉号);
           移动端 tag 名 + 常驻按钮串排 (无 hover 事件, 隐藏 = 找不到入口). tag 名 span 单独点也触发筛选跳转 -->
      <!-- Tag chip 交互 (蘑菇 2026-07-06 改回 overlay 靠右方案): 桌面 hover 时右侧图标 absolute 浮动覆盖 chip 尾部,
           chip 宽度不变不推挤后面 (Tags 页 363 个 tag flex-wrap 重排会卡). 图标区加自身底色 + shadow 分层, 视觉上像"chip 尾巴变操作按钮".
           移动端 tag 名 + 常驻按钮串排. tag 名点击触发筛选跳转. -->
      <TransitionGroup tag="div" data-animated-list class="flex flex-wrap gap-2" :css="false" @leave="fadeOutLeave">
        <div v-for="tag in visibleTags" :key="tag"
          class="group/tag relative inline-flex items-center gap-1.5 pl-3 pr-3 py-1.5 rounded-full hover:shadow-md cursor-pointer"
          style="background: rgb(var(--c-accent-light)); color: rgb(var(--c-accent-dark))">
          <span class="text-sm cursor-pointer hover:opacity-70" @click="filterByTag(tag)">#{{ tag }}</span>
          <!-- 桌面 hover 时右侧 overlay: absolute right-0 靠右浮动, chip 宽度不变.
               自身 bg + 左侧 box-shadow fade 让 overlay 跟 chip 底色融合边界柔和 (视觉像"tag 尾巴长出操作区"). -->
          <span
            class="hidden md:group-hover/tag:inline-flex absolute right-0 top-0 bottom-0 items-center gap-0.5 pl-3 pr-2 rounded-r-full"
            style="background: rgb(var(--c-accent-light)); box-shadow: -10px 0 8px -4px rgb(var(--c-accent-light))">
            <button @click.stop="editingTag = tag; newName = tag" class="p-1 rounded-full hover:bg-white/50" title="重命名">
              <PhPencilSimple size="0.75rem" weight="fill" />
            </button>
            <button @click.stop="confirmDeleteTag = tag" class="p-1 rounded-full hover:bg-red-100 hover:text-red-500" title="删除">
              <PhXCircle size="0.75rem" weight="fill" />
            </button>
          </span>
          <!-- 移动端常驻按钮 (md: 断点上隐藏). p-2 让触摸区 ~32px 更好点 (蘑菇 2026-07-06) -->
          <span class="md:hidden inline-flex items-center gap-0.5">
            <button @click.stop="editingTag = tag; newName = tag" class="p-2 rounded-full hover:bg-white/50" title="重命名">
              <PhPencilSimple size="0.75rem" weight="fill" />
            </button>
            <button @click.stop="confirmDeleteTag = tag" class="p-2 rounded-full hover:bg-red-100 hover:text-red-500" title="删除">
              <PhXCircle size="0.75rem" weight="fill" />
            </button>
          </span>
        </div>
      </TransitionGroup>
    </template>

    <!-- 重命名弹窗 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="editingTag" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
          <div class="absolute inset-0 bg-black/30" @click="editingTag = ''" />
          <div class="relative bg-white rounded-xl shadow-xl p-6 w-80 space-y-4">
            <h3 class="text-sm font-medium text-gray-800">重命名标签</h3>
            <p class="text-xs text-gray-400">将 #{{ editingTag }} 重命名为：</p>
            <input v-model="newName" @keydown.enter="renameTag" autofocus class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary" />
            <div class="flex gap-2 justify-end">
              <button @click="editingTag = ''" class="px-4 py-1.5 text-xs text-gray-500 rounded-lg border border-gray-200 hover:bg-gray-50">取消</button>
              <button @click="renameTag" class="px-4 py-1.5 text-white text-xs font-medium rounded-lg" style="background: rgb(var(--c-accent))">确定</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 删除确认弹窗 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="confirmDeleteTag" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
          <div class="absolute inset-0 bg-black/30" @click="confirmDeleteTag = ''" />
          <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
            <p class="text-sm text-gray-700 mb-1">删除标签 #{{ confirmDeleteTag }}</p>
            <p class="text-xs text-gray-400 mb-4">将从所有内容中移除此标签</p>
            <div class="flex gap-2 justify-center">
              <button @click="confirmDeleteTag = ''" class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
              <button @click="doDeleteTag" class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
