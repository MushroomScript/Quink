import { ref } from 'vue';

// 附件下载任务的全局状态(module-level ref, 跨组件共享)
// 用法: App.vue 在点击附件时 addTask/updateProgress/markSuccess/markFailed/markCancelled,
// AttachmentDownloadDock 组件读 tasks/dockVisible 渲染列表 + 翻页

export type AttachmentStatus = 'downloading' | 'success' | 'failed' | 'cancelled';

export interface AttachmentTask {
  id: string;
  url: string;        // fullUrl(含 origin), 跟 main 进程 attachment-progress 推送的 url 字段一致
  filename: string;
  received: number;   // 已接收字节
  total: number;      // 总字节(0 表示后端没给 content-length)
  status: AttachmentStatus;
  error?: string;     // 失败时的错误文案
}

export const tasks = ref<AttachmentTask[]>([]);
export const dockVisible = ref(false);

// 整窗 fade out 倒计时. 触发条件: 没有 downloading 且最近一次状态变化是 success/cancelled
// (markFailed 不调度倒计时, 让失败状态留着, 见 useAttachmentTasks.ts 设计文档 / 蘑菇需求)
let closeTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_CLOSE_MS = 3000;
// 鼠标 hover 时暂停关窗倒计时, 离开时重新调度. 让用户能从容查看完成/失败的条目
let hovering = false;

function clearCloseTimer(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

function maybeScheduleClose(): void {
  // 还在跑 / 用户正在 hover 就不关
  if (tasks.value.some((t) => t.status === 'downloading')) return;
  if (hovering) return;
  clearCloseTimer();
  closeTimer = setTimeout(() => {
    tasks.value = [];
    dockVisible.value = false;
    closeTimer = null;
  }, AUTO_CLOSE_MS);
}

export function pauseAutoClose(): void {
  hovering = true;
  clearCloseTimer();
}

export function resumeAutoClose(): void {
  hovering = false;
  maybeScheduleClose();
}

export function addTask(url: string, filename: string): string {
  // 同 URL 还在下载就不重复 add(main 端 inflight 也去重), 复用现有 task id 让进度持续更新
  const existing = tasks.value.find((t) => t.url === url && t.status === 'downloading');
  if (existing) {
    dockVisible.value = true;
    clearCloseTimer();
    return existing.id;
  }
  const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  tasks.value.push({ id, url, filename, received: 0, total: 0, status: 'downloading' });
  dockVisible.value = true;
  clearCloseTimer();
  return id;
}

export function updateProgress(url: string, received: number, total: number): void {
  const t = tasks.value.find((x) => x.url === url && x.status === 'downloading');
  if (!t) return;
  t.received = received;
  t.total = total;
}

export function markSuccess(url: string): void {
  const t = tasks.value.find((x) => x.url === url && x.status === 'downloading');
  if (!t) return;
  t.status = 'success';
  // 进度条强制 100%(可能 cache 命中 received=0)
  if (t.total === 0) t.total = 1;
  t.received = t.total;
  maybeScheduleClose();
}

export function markFailed(url: string, error: string): void {
  const t = tasks.value.find((x) => x.url === url && x.status === 'downloading');
  if (!t) return;
  t.status = 'failed';
  t.error = error;
  // 失败不调度关窗: 让用户看到失败状态留在列表里, 等下次 success/cancelled 才触发 3s 关窗
}

export function markCancelled(url: string): void {
  // 立即从列表移除(蘑菇要求"取消立刻消失")
  const idx = tasks.value.findIndex((x) => x.url === url && x.status === 'downloading');
  if (idx < 0) return;
  tasks.value.splice(idx, 1);
  maybeScheduleClose();
}

export async function cancelTask(url: string): Promise<void> {
  const desk = (window as any).quinkDesktop;
  try {
    await desk?.cancelAttachment?.(url);
  } catch {}
  // main 端 abort 后, open-attachment Promise 会以 { cancelled: true } resolve, 那时 App.vue
  // 会调 markCancelled 移除条目. 这里不直接 splice, 避免出现"UI 已移除但 main 还没结束"的竞态
}

// 用户手动 dismiss 已完成 task(失败 / 已打开). 立刻从列表移除 + 触发 3s 关窗判断.
// 跟 cancelTask 的区别: 这是给已结束的 task 用的, 不需要通知 main
export function dismissTask(url: string): void {
  const idx = tasks.value.findIndex((x) => x.url === url && x.status !== 'downloading');
  if (idx < 0) return;
  tasks.value.splice(idx, 1);
  maybeScheduleClose();
}
