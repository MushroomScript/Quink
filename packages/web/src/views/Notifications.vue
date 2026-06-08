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

    <!-- 4 tab 切换: 复用 Resources 全部那一行风格 (px-3 py-1 + bg-primary-light 选中态 / text-gray-500 默认态) -->
    <div class="px-4 md:px-6 pb-2 flex items-center gap-1 shrink-0">
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
        <!-- badge 比 sidebar 小一号: 16x16 / text-[10px] / 全 px-1 偶数, 取消多位/单位动态 (蘑菇要求"都弄成偶数").
             pb 去掉 (10px 字在 16px badge 内 items-center 自然居中, 不需要 top-heavy 补偿) -->
        <span
          v-if="tabUnread(t.key) > 0"
          class="inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 pb-[0.5px] bg-red-400/70 text-white text-[10px] leading-none font-semibold tabular-nums rounded-full"
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
          class="notif-item group p-3 rounded-lg cursor-pointer transition-all duration-150"
          :style="
            n.readAt
              ? 'background-color: var(--bg-secondary); border-left: 3px solid transparent'
              : 'background-color: var(--bg-primary-light); border-left: 3px solid rgb(var(--c-accent))'
          "
        >
          <!-- 第一行: icon + title + 未读小圆点 + 删除按钮. icon 跟 title 都用 items-center 单行天然居中 (复用 sidebar 待办 link 模式) -->
          <div class="flex items-center gap-3">
            <component
              :is="iconFor(n.category)"
              size="1.125rem"
              weight="fill"
              class="shrink-0"
              :style="n.readAt ? 'color: var(--text-muted)' : 'color: rgb(var(--c-accent))'"
            />
            <div class="font-medium text-sm truncate flex-1" style="color: var(--text-primary)">
              {{ n.title }}
            </div>
            <!-- 标已读: 仅未读时显示, 只 markRead 不跳转 (整条 click 已包含跳转) -->
            <button
              v-if="!n.readAt"
              @click="onMarkRead(n.id, $event)"
              class="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-primary-light"
              style="color: var(--text-muted)"
              title="标已读"
            >
              <PhCheck size="1rem" weight="bold" />
            </button>
            <button
              @click="onDelete(n.id, $event)"
              class="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-red-100 hover:text-red-500"
              style="color: var(--text-muted)"
              title="删除"
            >
              <PhTrash size="1rem" weight="bold" />
            </button>
          </div>
          <!-- 第二行: body + time, 缩进 icon (1.125rem = 18px) + gap (gap-3 = 12px) = 30px 跟 title 起点对齐 -->
          <div class="mt-1 space-y-0.5" style="padding-left: 30px">
            <div v-if="n.body" class="text-xs truncate" style="color: var(--text-secondary)">
              {{ n.body }}
            </div>
            <div class="text-[11px] tabular-nums" style="color: var(--text-muted)">
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
