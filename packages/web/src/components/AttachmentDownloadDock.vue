<script setup lang="ts">
import { computed } from 'vue';
import { PhX, PhCheck, PhWarning, PhArrowDown, PhArrowUp, PhBroom, PhFolderOpen } from '@phosphor-icons/vue';
import {
  tasks,
  dockVisible,
  cancelTask,
  dismissTask,
  clearCompleted,
  closeDock,
  addDownloadTask,
  type AttachmentTask,
} from '@/composables/useAttachmentTasks';
import { useToast } from '@/composables/useToast';

const toast = useToast();

const completedCount = computed(() =>
  tasks.value.filter((t) => t.status !== 'downloading').length
);

const downloadingCount = computed(() =>
  tasks.value.filter((t) => t.status === 'downloading').length
);

function percent(t: AttachmentTask): number {
  if (t.status === 'success') return 100;
  if (t.status === 'failed') return 100;
  if (!t.total) return 0;
  return Math.min(100, Math.round((t.received / t.total) * 100));
}

function formatBytes(b: number): string {
  if (b <= 0) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

function sizeText(t: AttachmentTask): string {
  if (t.status === 'success') return t.kind === 'upload' ? '已上传' : '已完成';
  if (t.status === 'failed') return t.error || '失败';
  if (!t.total) return formatBytes(t.received);
  return `${formatBytes(t.received)} / ${formatBytes(t.total)}`;
}

function actionLabel(t: AttachmentTask): string {
  if (t.status !== 'downloading') return '移除';
  return t.kind === 'upload' ? '取消上传' : '取消下载';
}

function onTaskAction(t: AttachmentTask): void {
  if (t.status === 'downloading') cancelTask(t.id);
  else dismissTask(t.id);
}

// 已下载完成的 task 可点击再次打开. cache 命中(main 端 attachmentCache + temp 文件还在)秒开;
// miss(进程重启 attachmentCache 丢了 / OS 清了 temp) → 重新走完整下载流程, 进度条会再走一遍.
// addDownloadTask 复用同 URL 让 main store 重置状态, 跟着 open-attachment IPC 触发 main 端 fetch.
// main 端自己调 store.markSuccessByUrl / markFailedByUrl, 本地 sync 自动更新, 这里只管 toast.
function canReopen(t: AttachmentTask): boolean {
  return t.kind === 'download' && t.status === 'success';
}
// 防御性: 历史 task 的 filename 字段可能含 ?token=... query 后缀 (App.vue 老 bug 写入的). 渲染前剥掉
function cleanFilename(name: string): string {
  return name.split('?')[0];
}

// "打开所在文件夹" 按钮仅 Electron 端可用 (web 无 desk IPC)
const hasShowInFolder = !!(window as any).quinkDesktop?.showInFolder;
function onShowInFolder(t: AttachmentTask): void {
  const desk = (window as any).quinkDesktop;
  if (desk?.showInFolder) desk.showInFolder(t.url);
}

// PR fix: 截断 + 友好化错误 (原 raw e.message 含完整 URL+token / Node error stack 拼到 toast 整屏宽都不够显示)
function friendlyOpenError(err: string | undefined): string {
  if (!err) return '未知错误';
  if (/HTTP 404/i.test(err)) return '文件不存在';
  if (/HTTP 401|登录|无权/i.test(err)) return '无权访问';
  if (/abort|cancel/i.test(err)) return '已取消';
  if (/下载停滞/.test(err)) return err;
  // 截 60 字符防 stack trace / 完整 URL 撑爆 toast
  return err.length > 60 ? err.slice(0, 60) + '...' : err;
}
async function onReopenTask(t: AttachmentTask): Promise<void> {
  if (!canReopen(t)) return;
  const desk = (window as any).quinkDesktop;
  if (!desk?.openAttachment) {
    // Web 端没 Electron IPC, 用浏览器原生下载 fallback (同 origin <a download>)
    const a = document.createElement('a');
    a.href = t.url;
    a.download = t.filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 100);
    return;
  }
  // await: 等 main 端 store reset task 状态 (downloading) 再 invoke open-attachment, 否则 main 内部 markSuccessByUrl 可能比 add 先到 store 找不到 task
  await addDownloadTask(t.url, t.filename);
  try {
    const result = await desk.openAttachment(t.url);
    if (result?.success) {
      toast.show(`已打开 ${t.filename}`);
    } else if (!result?.cancelled) {
      toast.show(`打开失败: ${friendlyOpenError(result?.error)}`, 'error');
    }
  } catch (e: any) {
    toast.show(`打开失败: ${friendlyOpenError(e?.message)}`, 'error');
  }
}
</script>

<template>
  <Transition name="dock-fade">
    <div
      v-if="dockVisible"
      class="fixed left-1/2 -translate-x-1/2 z-[var(--z-modal-edit-inner)] w-[380px] bg-white rounded-xl shadow-xl border border-gray-200 overflow-hidden"
      style="bottom: 24px"
    >
      <!-- 顶部 bar: 任务统计 + 清空已完成 + 关闭 -->
      <div class="flex items-center justify-between px-3 py-1.5 bg-gray-50 border-b border-gray-100 text-xs text-gray-500">
        <span>
          传输列表
          <span v-if="downloadingCount > 0" class="text-primary-dark">· 进行中 {{ downloadingCount }}</span>
          <span v-if="completedCount > 0" class="text-gray-400">· 已完成 {{ completedCount }}</span>
        </span>
        <div class="flex items-center gap-1">
          <button
            v-if="completedCount > 0"
            @click="clearCompleted"
            class="px-2 py-0.5 rounded hover:bg-gray-200 text-gray-500 hover:text-gray-700 inline-flex items-center gap-1"
            title="清空已完成"
          >
            <PhBroom size="0.75rem" weight="bold" />
            <span>清空已完成</span>
          </button>
          <!-- 关闭整个 dock: 进行中的任务会被一并取消 (closeDock 内部 abort) -->
          <button
            @click="closeDock"
            class="p-1 rounded hover:bg-gray-200 text-gray-500 hover:text-gray-700"
            title="关闭传输列表 (会取消进行中)"
          >
            <PhX size="0.75rem" weight="bold" />
          </button>
        </div>
      </div>

      <!-- 空状态: 用户从 sidebar 头像菜单主动打开但当前无任务 (自动弹出场景一定有 task, 走不到这里) -->
      <div v-if="tasks.length === 0" class="px-3 py-6 text-center text-xs text-gray-400">
        暂无传输任务
      </div>
      <!-- 滚动列表: max-height 3 条高度. 一 li 约 60.5px(首个) / 61.5px(divide-y border-top),
           3 行 = 60.5 + 61.5*2 = 183.5px. 超过 3 行触发滚动, 让 dock 高度稳定在 ~214px(含 top bar 30px) -->
      <ul v-else class="divide-y divide-gray-50 overflow-y-auto" style="max-height: 184px">
        <!-- success 状态的 download task 整行可点击触发 onReopenTask, 其他状态不响应 li click -->
        <li
          v-for="t in tasks"
          :key="t.id"
          class="px-3 py-2 transition-colors"
          :class="canReopen(t) ? 'cursor-pointer hover:bg-gray-50' : ''"
          :title="canReopen(t) ? '再次打开' : ''"
          @click="canReopen(t) && onReopenTask(t)"
        >
          <!-- 上行: kind icon + 文件名 + 状态按钮 -->
          <div class="flex items-center justify-between gap-2 mb-1">
            <div class="flex-1 min-w-0 flex items-center gap-1.5">
              <PhArrowUp v-if="t.kind === 'upload'" size="0.75rem" weight="bold" class="text-blue-500 shrink-0" />
              <PhArrowDown v-else size="0.75rem" weight="bold" class="text-primary shrink-0" />
              <span class="text-sm text-gray-700 truncate" :title="cleanFilename(t.filename)">{{ cleanFilename(t.filename) }}</span>
            </div>
            <!-- 状态指示 + 操作按钮. 文件夹按钮放对勾左边 -->
            <button
              v-if="t.kind === 'download' && t.status === 'success' && t.savePath && hasShowInFolder"
              @click.stop="onShowInFolder(t)"
              class="shrink-0 p-1 rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              title="打开所在文件夹"
            >
              <PhFolderOpen size="0.875rem" weight="bold" />
            </button>
            <span v-if="t.status === 'success'" class="shrink-0 p-1 text-green-600" title="完成">
              <PhCheck size="0.875rem" weight="bold" />
            </span>
            <PhWarning v-else-if="t.status === 'failed'" size="0.875rem" weight="fill" class="shrink-0 text-red-500" title="失败" />
            <!-- @click.stop 防点 X 时冒泡触发 li 上的 onReopenTask -->
            <button
              @click.stop="onTaskAction(t)"
              class="shrink-0 p-1 rounded text-gray-400 hover:bg-red-50 hover:text-red-500"
              :title="actionLabel(t)"
            >
              <PhX size="0.875rem" weight="bold" />
            </button>
          </div>
          <!-- 下行: 进度条 + 百分比/大小 -->
          <div class="flex items-center gap-2">
            <div class="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-[width] duration-150 ease-out"
                :class="{
                  'bg-primary': t.status === 'downloading' && t.kind === 'download',
                  'bg-blue-500': t.status === 'downloading' && t.kind === 'upload',
                  'bg-green-500': t.status === 'success',
                  'bg-red-400': t.status === 'failed',
                }"
                :style="{ width: percent(t) + '%' }"
              />
            </div>
            <div class="shrink-0 text-[10px] tabular-nums text-gray-500 w-[120px] text-right truncate">
              <span v-if="t.status === 'downloading'">{{ percent(t) }}% · {{ sizeText(t) }}</span>
              <span v-else>{{ sizeText(t) }}</span>
            </div>
          </div>
        </li>
      </ul>
    </div>
  </Transition>
</template>

<style scoped>
.dock-fade-enter-active,
.dock-fade-leave-active {
  transition: opacity 200ms ease, transform 200ms ease;
}
.dock-fade-enter-from,
.dock-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(10px);
}
</style>
