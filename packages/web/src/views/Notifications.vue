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

// 仅标已读不跳转, 区别于整条点击 (后者既已读又跳关联资源)
async function onMarkRead(id: string, e: MouseEvent) {
  e.stopPropagation();
  await store.markRead(id);
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
    <!-- sticky toolbar: tabs 左 + 操作右. 复用 Resources toolbar 同款 (高度统一 py-1), 未读数写到 TopBar 标题旁 (N) -->
    <div class="sticky top-0 z-[var(--z-sticky)] px-4 md:px-6 pt-2 pb-2 flex items-center justify-between gap-3 shrink-0"
      style="background: var(--c-body); box-shadow: 0 1px 0 var(--sb-border)">
      <!-- 左: 4 tab 切换 -->
      <div class="flex items-center gap-1 flex-wrap">
        <button
          v-for="t in tabs"
          :key="t.key"
          @click="store.setTab(t.key)"
          class="px-3 py-1 rounded-lg text-xs transition-colors flex items-center gap-1.5"
          :class="store.currentTab === t.key
            ? 'bg-primary-light text-primary-dark font-medium'
            : 'text-gray-500 hover:bg-gray-100'"
        >
        <span>{{ t.label }}</span>
        <!-- badge 蘑菇 2026-06-08 badge-test.html 定稿: 14.5 size, font 10, px-[4.5px], 红点 translate-y-[0.5px] 下移半步,
             字内 wrap span 加 transform translate(-0.25, -0.25) sub-pixel 微调 (1.5x zoom 下视觉居中) -->
        <span
          v-if="tabUnread(t.key) > 0"
          class="inline-flex items-center justify-center min-w-[14.5px] h-[14.5px] px-[4.5px] translate-y-[0.5px] bg-red-400/70 text-white text-[10px] leading-none font-semibold tabular-nums rounded-full"
        >
          <span class="inline-block" style="transform: translate(-0.25px, -0.25px)">{{ tabUnread(t.key) > 99 ? '99+' : tabUnread(t.key) }}</span>
        </span>
      </button>
      </div>
      <!-- 右: 操作按钮 (全标已读 + 清空当前). 高度统一 py-1 跟 tab 一致 -->
      <div class="flex items-center gap-2">
        <button
          @click="confirmReadAll = true"
          :disabled="store.unread.total === 0"
          class="px-3 py-1 rounded-lg text-xs bg-primary-light text-primary-dark hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity flex items-center gap-1"
        >
          <PhCheck size="0.85rem" weight="bold" />
          <span>全标已读</span>
        </button>
        <button
          @click="confirmClear = true"
          :disabled="store.items.length === 0"
          class="px-3 py-1 rounded-lg text-xs bg-red-50 text-red-500 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
        >
          <PhTrash size="0.85rem" weight="bold" />
          <span>清空当前</span>
        </button>
      </div>
    </div>

    <!-- 列表 -->
    <div class="flex-1 overflow-y-auto px-4 md:px-6 pb-4">
      <div
        v-if="store.loading && store.items.length === 0"
        class="py-12 text-center text-sm"
        style="color: var(--sb-dim)"
      >
        加载中…
      </div>
      <div
        v-else-if="store.items.length === 0"
        class="py-16 text-center text-sm"
        style="color: var(--sb-dim)"
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
          class="notif-item group p-3 rounded-lg cursor-pointer transition-all duration-150"
          :style="
            n.readAt
              ? 'background-color: var(--sb-hover); border-left: 3px solid var(--sb-dim)'
              : 'background-color: rgb(var(--c-accent) / 0.12); border-left: 3px solid rgb(var(--c-accent))'
          "
        >
          <!-- 第一行: icon + title + 未读小圆点 + 删除按钮. icon 跟 title 都用 items-center 单行天然居中 (复用 sidebar 待办 link 模式) -->
          <div class="flex items-center gap-3">
            <component
              :is="iconFor(n.category)"
              size="1.125rem"
              weight="fill"
              class="shrink-0"
              :style="n.readAt ? 'color: var(--sb-dim)' : 'color: rgb(var(--c-accent))'"
            />
            <div class="font-medium text-sm truncate flex-1" style="color: var(--sb-text)">
              {{ n.title }}
            </div>
            <!-- 标已读: 仅未读时显示, 只 markRead 不跳转 (整条 click 已包含跳转) -->
            <button
              v-if="!n.readAt"
              @click="onMarkRead(n.id, $event)"
              class="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-primary-light"
              style="color: var(--sb-dim)"
              title="标已读"
            >
              <PhCheck size="1rem" weight="bold" />
            </button>
            <button
              @click="onDelete(n.id, $event)"
              class="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-red-100 hover:text-red-500"
              style="color: var(--sb-dim)"
              title="删除"
            >
              <PhTrash size="1rem" weight="bold" />
            </button>
          </div>
          <!-- 第二行: body + time, 缩进 icon (1.125rem = 18px) + gap (gap-3 = 12px) = 30px 跟 title 起点对齐 -->
          <div class="mt-1 space-y-0.5" style="padding-left: 30px">
            <div v-if="n.body" class="text-xs truncate" style="color: var(--sb-dim)">
              {{ n.body }}
            </div>
            <div class="text-[11px] tabular-nums" style="color: var(--sb-dim)">
              {{ timeAgo(n.createdAt) }}
            </div>
          </div>
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
        <div class="rounded-2xl p-5 max-w-sm w-full mx-4 shadow-xl" style="background: rgb(var(--c-sidebar-light))">
          <div class="text-base font-medium mb-2" style="color: var(--sb-text)">
            全部标为已读？
          </div>
          <div class="text-sm mb-4" style="color: var(--sb-dim)">
            {{ store.currentTab === '' ? '将清除所有 tab 的未读标记' : '将清除当前 tab 的未读标记' }}
          </div>
          <div class="flex justify-end gap-2">
            <button
              @click="confirmReadAll = false"
              class="px-3 py-1.5 rounded-lg text-sm transition-colors"
              style="background: var(--sb-hover); color: var(--sb-text)"
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
        <div class="rounded-2xl p-5 max-w-sm w-full mx-4 shadow-xl" style="background: rgb(var(--c-sidebar-light))">
          <div class="text-base font-medium mb-2" style="color: var(--sb-text)">
            清空通知？
          </div>
          <div class="text-sm mb-4" style="color: var(--sb-dim)">
            {{ store.currentTab === '' ? '将清空所有通知, 不可恢复' : '将清空当前 tab 通知, 不可恢复' }}
          </div>
          <div class="flex justify-end gap-2">
            <button
              @click="confirmClear = false"
              class="px-3 py-1.5 rounded-lg text-sm transition-colors"
              style="background: var(--sb-hover); color: var(--sb-text)"
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

<style scoped>
/* hover 整行被选取的感觉 (蘑菇报告: 之前 brightness + 1px ring 太弱). 用 3 层叠加:
   1. background-image linear-gradient 叠一层半透明 primary 紫色覆盖 (整行被"染色"感)
   2. box-shadow inset 1.5px primary ring (边框感)
   3. brightness 1.1 微提亮 (避免太重)
   background-color 仍由 inline style 控制 (已读灰 / 未读紫底), background-image 跟它叠加不冲突 */
.notif-item:hover {
  /* hover 整行淡紫色背景 (蘑菇要求: 不要框 / 只要 bg 跟主题色呼应).
     用 background-image linear-gradient 叠一层半透明 primary 跟 inline style 的 background-color 共存.
     Quink --c-accent 是 "116 143 252" 空格 channel 格式, 必须用 rgb(var() / alpha) 现代语法 (rgba 不支持空格 channel) */
  background-image: linear-gradient(rgb(var(--c-accent) / 0.12), rgb(var(--c-accent) / 0.12));
}
</style>
