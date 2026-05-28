import { ref } from 'vue';

// 传输任务全局状态(module-level ref, 跨组件 + 跨路由共享)
// 用法:
//   下载: App.vue 点击附件链接时 addDownloadTask → main 端 progress 推 updateProgress
//         → result 决定 markSuccess / markFailed / markCancelled
//   上传: Resources / 编辑器 上传文件时 addUploadTask → XHR onprogress 推 updateProgress
//         → 上传 result 同样 markSuccess / markFailed / markCancelled
//   dock 组件读 tasks/dockVisible 渲染, 用户可清空已完成 / 单条 dismiss / 取消进行中

export type TaskKind = 'download' | 'upload';
export type AttachmentStatus = 'downloading' | 'success' | 'failed' | 'cancelled';

export interface AttachmentTask {
  id: string;
  kind: TaskKind;
  url: string;          // download: fullUrl; upload: 用作唯一键(可填 file://filename + timestamp)
  filename: string;
  received: number;
  total: number;
  status: AttachmentStatus;
  error?: string;
  // upload 任务的 abort controller, 取消时调 abort(). download 走 main 端 IPC, 不用这个
  abortController?: AbortController;
}

export const tasks = ref<AttachmentTask[]>([]);
export const dockVisible = ref(false);

function genId(): string {
  return (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ===== Download 任务 =====

export function addDownloadTask(url: string, filename: string): string {
  // 同 URL 还在下载就复用现有 task (main 端 inflight 也去重)
  const existing = tasks.value.find((t) => t.kind === 'download' && t.url === url && t.status === 'downloading');
  if (existing) {
    dockVisible.value = true;
    return existing.id;
  }
  const id = genId();
  tasks.value.push({ id, kind: 'download', url, filename, received: 0, total: 0, status: 'downloading' });
  dockVisible.value = true;
  return id;
}

// 保留旧函数名兼容 App.vue 现有调用 (内部直接转发到 addDownloadTask)
export const addTask = addDownloadTask;

// ===== Upload 任务 =====

export function addUploadTask(filename: string, total: number, abortController?: AbortController): string {
  // upload 用 file://filename-timestamp 作为唯一 url 键, 避免同名文件冲突
  const url = `file://${filename}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const id = genId();
  tasks.value.push({ id, kind: 'upload', url, filename, received: 0, total, status: 'downloading', abortController });
  dockVisible.value = true;
  return id;
}

// ===== 通用更新 =====

export function updateProgress(url: string, received: number, total: number): void {
  const t = tasks.value.find((x) => x.url === url && x.status === 'downloading');
  if (!t) return;
  t.received = received;
  t.total = total;
}

// upload 任务用 task id 找(因为 url 由 addUploadTask 生成, 调用方不一定记得住)
export function updateProgressById(id: string, received: number, total: number): void {
  const t = tasks.value.find((x) => x.id === id && x.status === 'downloading');
  if (!t) return;
  t.received = received;
  t.total = total;
}

export function markSuccess(url: string): void {
  const t = tasks.value.find((x) => x.url === url && x.status === 'downloading');
  if (!t) return;
  t.status = 'success';
  if (t.total === 0) t.total = 1;
  t.received = t.total;
}

export function markSuccessById(id: string): void {
  const t = tasks.value.find((x) => x.id === id && x.status === 'downloading');
  if (!t) return;
  t.status = 'success';
  if (t.total === 0) t.total = 1;
  t.received = t.total;
}

export function markFailed(url: string, error: string): void {
  const t = tasks.value.find((x) => x.url === url && x.status === 'downloading');
  if (!t) return;
  t.status = 'failed';
  t.error = error;
}

export function markFailedById(id: string, error: string): void {
  const t = tasks.value.find((x) => x.id === id && x.status === 'downloading');
  if (!t) return;
  t.status = 'failed';
  t.error = error;
}

export function markCancelled(url: string): void {
  const idx = tasks.value.findIndex((x) => x.url === url && x.status === 'downloading');
  if (idx < 0) return;
  tasks.value.splice(idx, 1);
}

export function markCancelledById(id: string): void {
  const idx = tasks.value.findIndex((x) => x.id === id && x.status === 'downloading');
  if (idx < 0) return;
  tasks.value.splice(idx, 1);
}

// ===== 用户操作 =====

// 取消下载: 调 main 端 cancel-attachment IPC, 等 main 端 abort 后 result 走 cancelled 分支
// 取消上传: 直接 abort 本地 XHR/fetch, 立即 markCancelledById
export async function cancelTask(id: string): Promise<void> {
  const t = tasks.value.find((x) => x.id === id && x.status === 'downloading');
  if (!t) return;
  if (t.kind === 'download') {
    const desk = (window as any).quinkDesktop;
    try { await desk?.cancelAttachment?.(t.url); } catch {}
  } else {
    try { t.abortController?.abort(); } catch {}
    // upload 走本地 abort, 立即从列表移除
    markCancelledById(id);
  }
}

// 手动 dismiss 已完成 (success/failed) 任务. downloading 状态不允许 dismiss (要先 cancel)
export function dismissTask(id: string): void {
  const idx = tasks.value.findIndex((x) => x.id === id && x.status !== 'downloading');
  if (idx < 0) return;
  tasks.value.splice(idx, 1);
  if (tasks.value.length === 0) dockVisible.value = false;
}

// 清空所有已完成 (success/failed/cancelled). 进行中的不动
export function clearCompleted(): void {
  tasks.value = tasks.value.filter((t) => t.status === 'downloading');
  if (tasks.value.length === 0) dockVisible.value = false;
}

// 手动关闭整个 dock (清空全部, 含进行中). 一般用户不用, 但保留 API
export function closeDock(): void {
  // 取消所有进行中的
  tasks.value.forEach((t) => {
    if (t.status === 'downloading') {
      if (t.kind === 'upload') {
        try { t.abortController?.abort(); } catch {}
      } else {
        const desk = (window as any).quinkDesktop;
        try { desk?.cancelAttachment?.(t.url); } catch {}
      }
    }
  });
  tasks.value = [];
  dockVisible.value = false;
}
