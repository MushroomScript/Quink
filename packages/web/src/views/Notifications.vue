<script setup lang="ts">
import { onMounted, onActivated, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useNotificationsStore, type TabKey } from '@/stores/notifications';
import { useEscToClose } from '@/composables/useEscToClose';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import relativeTime from 'dayjs/plugin/relativeTime';
import {
  PhBell,
  PhUsersThree,
  PhFileText,
  PhTrash,
  PhCheck,
  PhBellRinging,
} from '@phosphor-icons/vue';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const router = useRouter();
const store = useNotificationsStore();

const tabs: { key: TabKey; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'content', label: '内容' },
  { key: 'reminder', label: '提醒' },
  { key: 'group', label: '群组' },
];

const confirmReadAll = ref(false);
const confirmClear = ref(false);
useEscToClose(confirmReadAll);
useEscToClose(confirmClear);

// onMounted 首次进入 (router 默认不带 KeepAlive 时 onActivated 不触发) + onActivated 从 KeepAlive 切回时
function refresh() {
  store.loadList().catch(() => {});
  store.loadUnreadCount().catch(() => {});
}
onMounted(refresh);
onActivated(refresh);

function tabUnread(key: TabKey): number {
  if (key === '') return store.unread.total;
  return (store.unread as any)[key] ?? 0;
}

function iconFor(cat: string) {
  if (cat === 'content') return PhFileText;
  if (cat === 'reminder') return PhBellRinging;
  return PhUsersThree;
}

function timeAgo(iso: string): string {
  const d = dayjs(iso);
  // 7 天内相对时间, 之后绝对时间
  const diff = dayjs().diff(d, 'day');
  if (diff < 7) return d.fromNow();
  return d.format('YYYY-MM-DD HH:mm');
}

async function onItemClick(id: string) {
  const n = store.items.find((x) => x.id === id);
  if (!n) return;
  await store.markRead(id);
  // 跳关联资源 (按 payload.noteId / groupId). 后续接入点 PR #10c 改造时可扩更多字段
  const p = n.payload || {};
  if (p.noteId) router.push(`/note/${p.noteId}`);
  else if (p.groupId) router.push(`/groups/${p.groupId}`);
}

async function onDelete(id: string, e: MouseEvent) {
  e.stopPropagation();
  await store.deleteOne(id);
}

async function doReadAll() {
  confirmReadAll.value = false;
  await store.markReadAll();
}

async function doClear() {
  confirmClear.value = false;
  await store.clearAll();
}
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <!-- 顶部: 标题 + 未读 chip + 操作 -->
    <div class="px-4 md:px-6 pt-3 pb-2 flex items-center gap-3 shrink-0">
      <div class="text-base font-medium" style="color: var(--text-primary)">
        消息通知
        <span v-if="store.unread.total > 0" class="ml-2 text-xs text-red-500 tabular-nums">
          {{ store.unread.total > 99 ? '99+' : store.unread.total }} 未读
        </span>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <button
          @click="confirmReadAll = true"
          :disabled="store.unread.total === 0"
          class="px-3 py-1.5 rounded-lg text-xs bg-primary-light text-primary-dark hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity flex items-center gap-1"
        >
          <PhCheck size="0.9rem" weight="bold" />
          <span>全标已读</span>
        </button>
        <button
          @click="confirmClear = true"
          :disabled="store.items.length === 0"
          class="px-3 py-1.5 rounded-lg text-xs bg-red-50 text-red-500 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
        >
          <PhTrash size="0.9rem" weight="bold" />
          <span>清空当前</span>
        </button>
      </div>
    </div>

    <!-- 4 tab 切换 -->
    <div class="px-4 md:px-6 pb-2 flex items-center gap-1 shrink-0">
      <button
        v-for="t in tabs"
        :key="t.key"
        @click="store.setTab(t.key)"
        class="relative px-3 py-1.5 rounded-lg text-xs transition-colors flex items-center gap-1.5"
        :class="store.currentTab === t.key
          ? 'bg-primary text-white'
          : 'bg-transparent hover:bg-primary-light'"
        :style="store.currentTab === t.key ? '' : 'color: var(--text-primary)'"
      >
        <span>{{ t.label }}</span>
        <span
          v-if="tabUnread(t.key) > 0"
          class="text-[10px] tabular-nums px-1 rounded-full min-w-[16px] text-center"
          :class="store.currentTab === t.key ? 'bg-white/30' : 'bg-red-500 text-white'"
        >
          {{ tabUnread(t.key) > 99 ? '99+' : tabUnread(t.key) }}
        </span>
      </button>
    </div>

    <!-- 列表 -->
    <div class="flex-1 overflow-y-auto px-4 md:px-6 pb-4">
      <div
        v-if="store.loading && store.items.length === 0"
        class="py-12 text-center text-sm"
        style="color: var(--text-muted)"
      >
        加载中…
      </div>
      <div
        v-else-if="store.items.length === 0"
        class="py-16 text-center text-sm"
        style="color: var(--text-muted)"
      >
        <div class="mb-2">
          <PhBell size="2rem" weight="duotone" class="inline-block opacity-50" />
        </div>
        <div>没有通知</div>
      </div>
      <div v-else class="space-y-2">
        <div
          v-for="n in store.items"
          :key="n.id"
          @click="onItemClick(n.id)"
          class="group p-3 rounded-lg cursor-pointer transition-colors flex items-start gap-3"
          :style="
            n.readAt
              ? 'background: var(--bg-secondary)'
              : 'background: var(--bg-primary-light); border-left: 3px solid rgb(var(--c-accent))'
          "
        >
          <!-- icon -->
          <div
            class="shrink-0 mt-0.5"
            :style="n.readAt ? 'color: var(--text-muted)' : 'color: rgb(var(--c-accent))'"
          >
            <component :is="iconFor(n.category)" size="1.25rem" weight="fill" />
          </div>
          <!-- title + body + time -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <div class="font-medium text-sm truncate" style="color: var(--text-primary)">
                {{ n.title }}
              </div>
              <span v-if="!n.readAt" class="shrink-0 w-2 h-2 rounded-full bg-red-500"></span>
            </div>
            <div v-if="n.body" class="text-xs mt-1 line-clamp-2" style="color: var(--text-secondary)">
              {{ n.body }}
            </div>
            <div class="text-[11px] mt-1 tabular-nums" style="color: var(--text-muted)">
              {{ timeAgo(n.createdAt) }}
            </div>
          </div>
          <!-- 删除按钮 (hover 显示) -->
          <button
            @click="onDelete(n.id, $event)"
            class="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-red-100 hover:text-red-500"
            style="color: var(--text-muted)"
            title="删除"
          >
            <PhTrash size="1rem" weight="bold" />
          </button>
        </div>
        <div v-if="store.hasMore" class="text-center py-4">
          <button
            @click="store.loadList({ append: true })"
            :disabled="store.loading"
            class="px-3 py-1.5 rounded-lg text-xs bg-primary-light text-primary-dark hover:opacity-80 disabled:opacity-40 transition-opacity"
          >
            {{ store.loading ? '加载中…' : '加载更多' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 全标已读确认 -->
    <Teleport to="body">
      <div
        v-if="confirmReadAll"
        class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center"
        style="background: rgba(0, 0, 0, 0.4)"
        @click.self="confirmReadAll = false"
      >
        <div class="rounded-2xl p-5 max-w-sm w-full mx-4 shadow-xl" style="background: var(--bg-primary)">
          <div class="text-base font-medium mb-2" style="color: var(--text-primary)">
            全部标为已读？
          </div>
          <div class="text-sm mb-4" style="color: var(--text-secondary)">
            {{ store.currentTab === '' ? '将清除所有 tab 的未读标记' : '将清除当前 tab 的未读标记' }}
          </div>
          <div class="flex justify-end gap-2">
            <button
              @click="confirmReadAll = false"
              class="px-3 py-1.5 rounded-lg text-sm transition-colors"
              style="background: var(--bg-secondary); color: var(--text-primary)"
            >
              取消
            </button>
            <button
              @click="doReadAll"
              class="px-3 py-1.5 rounded-lg text-sm bg-primary-light text-primary-dark hover:opacity-80 transition-opacity"
            >
              确认
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 清空当前 tab 确认 -->
    <Teleport to="body">
      <div
        v-if="confirmClear"
        class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center"
        style="background: rgba(0, 0, 0, 0.4)"
        @click.self="confirmClear = false"
      >
        <div class="rounded-2xl p-5 max-w-sm w-full mx-4 shadow-xl" style="background: var(--bg-primary)">
          <div class="text-base font-medium mb-2" style="color: var(--text-primary)">
            清空通知？
          </div>
          <div class="text-sm mb-4" style="color: var(--text-secondary)">
            {{ store.currentTab === '' ? '将清空所有通知, 不可恢复' : '将清空当前 tab 通知, 不可恢复' }}
          </div>
          <div class="flex justify-end gap-2">
            <button
              @click="confirmClear = false"
              class="px-3 py-1.5 rounded-lg text-sm transition-colors"
              style="background: var(--bg-secondary); color: var(--text-primary)"
            >
              取消
            </button>
            <button
              @click="doClear"
              class="px-3 py-1.5 rounded-lg text-sm bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
            >
              确认清空
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
