<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useGroupsStore } from '@/stores/groups';
import { useNotesStore } from '@/stores/notes';
import GroupDetail from '@/components/GroupDetail.vue';
import CreateGroupModal from '@/components/CreateGroupModal.vue';
import { resolveFileUrl, resolveFileThumbUrl, thumbErrorFallback } from '@/utils/fileUrl';
import {
  PhUsersThree, PhPlus, PhCaretLeft, PhCaretRight,
} from '@phosphor-icons/vue';

const route = useRoute();
const router = useRouter();
const store = useGroupsStore();
// notesStore.currentRefresh 是 TopBar 全局刷新按钮的注册点, 群组借用让 TopBar 刷新触发群组数据 reload
const notesStore = useNotesStore();

// 当前选中群 id (从 route.params 拿)
const selectedId = computed(() => String(route.params.id || ''));

// 左侧群列表折叠 (localStorage 持久化)
const COLLAPSED_KEY = 'quink_groups_sidebar_collapsed';
const collapsed = ref(localStorage.getItem(COLLAPSED_KEY) === '1');
watch(collapsed, (v) => { localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0'); });

// 上次打开的群 id (持久化, 进 /groups 时自动恢复)
const LAST_GROUP_KEY = 'quink_groups_last_id';

const showCreateGroup = ref(false);
// ready: loadGroups + maybeAutoSelect 完成后才决定显示什么 (避免 loading 中闪空状态)
const ready = ref(false);

// 自动跳: /groups (无 id) 时回上次的群; 上次 id 已失效或没记录就跳第一个
async function maybeAutoSelect() {
  if (selectedId.value) return; // 已经选中具体群, 不动
  if (store.groups.length === 0) return; // 没群, 留空状态显示"新建群组"提示
  const lastId = localStorage.getItem(LAST_GROUP_KEY);
  const target = (lastId && store.groups.find(g => g.id === lastId)) || store.groups[0];
  router.replace(`/groups/${target.id}`);
}

// view-level refresh: TopBar 顶部刷新按钮触发. 拉群列表 + 当前选中群的详情 + 待审申请
async function viewRefresh() {
  await store.loadGroups();
  if (selectedId.value) {
    try {
      await store.loadGroup(selectedId.value);
      if (store.currentDetail?.myRole === 'owner' || store.currentDetail?.myRole === 'admin') {
        await store.loadJoinRequests(selectedId.value);
      }
    } catch {} // 当前 id 已失效(如群被解散) 静默
  }
}

onMounted(async () => {
  // 进入 /groups 时如果群列表还空, 拉一次 (sidebar 已在 mount 时拉过, 这里幂等)
  if (store.groups.length === 0) await store.loadGroups();
  await maybeAutoSelect();
  ready.value = true;
  notesStore.currentRefresh = viewRefresh;
});

onUnmounted(() => {
  // 防竞争: 切走时新 view 已注册 currentRefresh, 只清自己的
  if (notesStore.currentRefresh === viewRefresh) notesStore.currentRefresh = null;
});

// route 切回 /groups (无 id) 时也跳 (e.g. 解散群跳回 /groups, 自动选下一个)
watch(selectedId, async (id) => {
  if (id) {
    localStorage.setItem(LAST_GROUP_KEY, id);
  } else {
    await maybeAutoSelect();
  }
});

function selectGroup(id: string) {
  router.push(`/groups/${id}`);
}
</script>

<template>
  <!-- 占满 main viewport. absolute 跟 AI.vue 同模式, 防 batch-bar-portal content-based 高度 race -->
  <div class="absolute inset-0 flex overflow-hidden">
    <!-- 左侧群列表 (桌面端). collapsed 56px 容纳 32px 头像 + 群项 padding + 红点不裁切; 展开 224px -->
    <div class="shrink-0 border-r border-gray-100 flex flex-col bg-gray-50/50 hidden md:flex transition-all duration-200"
      :class="collapsed ? 'w-14' : 'w-56'">
      <!-- 顶部: 新建按钮 + 折叠切换 -->
      <div class="p-3 space-y-2">
        <div class="flex items-center gap-1">
          <button v-if="!collapsed" @click="showCreateGroup = true"
            class="flex-1 px-3 py-2 text-xs font-medium rounded-lg transition-colors text-white inline-flex items-center justify-center gap-1"
            style="background: rgb(var(--c-accent))">
            <PhPlus size="0.75rem" weight="bold" /> 新建群组
          </button>
          <!-- 折叠后只有 + 按钮和展开按钮 (vertical stack) -->
          <button v-else @click="showCreateGroup = true"
            class="w-full p-2 text-white rounded-lg flex items-center justify-center"
            style="background: rgb(var(--c-accent))" title="新建群组">
            <PhPlus size="0.875rem" weight="bold" />
          </button>
        </div>
        <button @click="collapsed = !collapsed"
          class="w-full p-1.5 text-xs text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors inline-flex items-center justify-center gap-1"
          :title="collapsed ? '展开' : '收起'">
          <PhCaretLeft v-if="!collapsed" size="0.75rem" weight="bold" />
          <PhCaretRight v-else size="0.75rem" weight="bold" />
          <span v-if="!collapsed">收起</span>
        </button>
      </div>

      <!-- 群列表 -->
      <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        <div v-if="store.groups.length === 0" class="text-center py-8 text-xs text-gray-400" :class="collapsed ? 'px-0' : 'px-2'">
          <span v-if="!collapsed">暂无群组</span>
          <PhUsersThree v-else size="1rem" weight="fill" class="mx-auto opacity-50" />
        </div>
        <div v-else class="space-y-0.5">
          <div v-for="g in store.groups" :key="g.id"
            @click="selectGroup(g.id)"
            class="group relative flex items-center gap-2 rounded-lg cursor-pointer text-xs transition-colors"
            :class="[
              collapsed ? 'p-1 justify-center' : 'px-3 py-2',
              selectedId === g.id ? 'bg-white shadow-sm font-medium text-gray-800' : 'text-gray-500 hover:bg-white/60',
            ]"
            :title="collapsed ? g.name : ''">
            <!-- 折叠态用 32x32 头像 (更醒目 + 容纳红点不裁切); 展开态用 24x24 (列表里挤多了) -->
            <div class="relative shrink-0" :class="collapsed ? 'w-8 h-8' : 'w-6 h-6'">
              <img v-if="g.avatar" :src="resolveFileThumbUrl(g.avatar)"
                @error="thumbErrorFallback($event, resolveFileUrl(g.avatar))"
                class="w-full h-full rounded-lg object-cover" alt="" />
              <div v-else class="w-full h-full rounded-lg bg-primary/15 text-primary-dark flex items-center justify-center">
                <PhUsersThree :size="collapsed ? '1rem' : '0.75rem'" weight="fill" />
              </div>
              <!-- 折叠态红点: 不用负偏移避免裁切, 紧贴头像右上角 (top/right 0) -->
              <span v-if="collapsed && store.pendingCount[g.id]"
                class="absolute top-0 right-0 w-2.5 h-2.5 bg-red-400/90 rounded-full ring-2 ring-gray-50" />
            </div>
            <span v-if="!collapsed" class="flex-1 truncate">{{ g.name }}</span>
            <!-- 展开态: 行尾角标显示具体数字 -->
            <span v-if="!collapsed && store.pendingCount[g.id]"
              class="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 bg-red-400/80 text-white text-[10px] leading-none font-semibold tabular-nums rounded-full">
              {{ store.pendingCount[g.id] > 99 ? '99+' : store.pendingCount[g.id] }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 右侧详情区 -->
    <div class="flex-1 min-w-0 relative">
      <!-- 选中群: 渲染 GroupDetail. key=selectedId 让切群时 mount 新组件 (避开 watch 时机 race) -->
      <GroupDetail v-if="selectedId" :group-id="selectedId" :key="selectedId" />

      <!-- 空状态: 只在 ready (loadGroups + autoSelect 完成) 后仍无群组时显示, 避免 loading 闪 -->
      <div v-else-if="ready && store.groups.length === 0" class="h-full flex items-center justify-center text-center px-4">
        <div>
          <div class="w-16 h-16 mx-auto mb-3 rounded-2xl bg-primary/10 text-primary-dark flex items-center justify-center">
            <PhUsersThree size="2rem" weight="fill" />
          </div>
          <p class="text-sm text-gray-500 mb-1">还没有群组</p>
          <p class="text-xs text-gray-400">点左侧 "+ 新建群组" 开始</p>
        </div>
      </div>

      <!-- 手机端: 群列表显示为顶部下拉 (PR #1 暂不做, 桌面端为主) -->
    </div>

    <!-- 建群弹窗: 移到 Groups.vue 集中管理 -->
    <CreateGroupModal v-if="showCreateGroup" @close="showCreateGroup = false" />
  </div>
</template>
