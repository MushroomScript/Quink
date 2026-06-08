// 全局附件传输任务中心化 store. 跨 BrowserWindow 共享 (主 / Capture / AiChat 同步) + 跨 session 持久化到 userData.
// 任何窗口改 task 状态都走 IPC → 这里维护唯一来源 → broadcast 给所有 webContents.
// renderer 端 useAttachmentTasks 是 thin client, tasks ref 仅作 sync 接收方.

import * as fs from 'fs';
import * as path from 'path';
import { app, webContents } from 'electron';

export type TaskKind = 'download' | 'upload';
export type AttachmentStatus = 'downloading' | 'success' | 'failed' | 'cancelled';

export interface PersistedTask {
  id: string;
  kind: TaskKind;
  url: string;
  filename: string;
  received: number;
  total: number;
  status: AttachmentStatus;
  error?: string;
  // PR fix: 下载完成后保存到的本地绝对路径. 给 dock"打开所在文件夹"按钮用 (shell.showItemInFolder)
  savePath?: string;
}

// lazy getter: 不能在 module load 时调 app.getPath('userData'). ES module 的 import 是 hoisted,
// 本文件在 main.ts 顶部 import 时立即 evaluate, 那时 app.setName('Quink') 还没跑 → 路径用了
// package.json name `@quink/desktop`. 延到 load/persist 真正用时再算, app.setName 已生效
const MAX_HISTORY = 50;
let _storeFile: string | null = null;
function getStoreFile(): string {
  if (!_storeFile) _storeFile = path.join(app.getPath('userData'), 'attachment-tasks.json');
  return _storeFile;
}

let tasks: PersistedTask[] = [];

export function load(): void {
  try {
    const storeFile = getStoreFile();
    if (!fs.existsSync(storeFile)) return;
    const raw = fs.readFileSync(storeFile, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    tasks = arr.filter((x: any) =>
      x && typeof x.id === 'string' &&
      (x.kind === 'download' || x.kind === 'upload') &&
      typeof x.url === 'string' && typeof x.filename === 'string' &&
      x.status !== 'downloading' // 上次异常退出残留的进行中状态不恢复
    );
  } catch (e: any) {
    console.warn('[attachmentTasksStore] load failed:', e?.message);
    tasks = [];
  }
}

function persist(): void {
  try {
    // 仅持久化终态 task; downloading 不写盘避免下次启动"假装还在下"
    const finalized = tasks.filter((t) => t.status !== 'downloading').slice(-MAX_HISTORY);
    fs.writeFileSync(getStoreFile(), JSON.stringify(finalized));
  } catch (e: any) {
    console.warn('[attachmentTasksStore] persist failed:', e?.message);
  }
}

// 全量 sync 广播 (add / mark / remove / clear / close 用)
function broadcastSync(): void {
  const snapshot = tasks.map((t) => ({ ...t }));
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    try { wc.send('attachment-tasks:sync', snapshot); } catch {}
  }
}

// 进度更新单独广播 (高频, 不带全量, 避免每次广播 50 条 JSON)
function broadcastProgress(id: string, received: number, total: number): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    try { wc.send('attachment-tasks:progress', { id, received, total }); } catch {}
  }
}

export function getAll(): PersistedTask[] {
  return tasks.map((t) => ({ ...t }));
}

// 新增 task. 同 URL download 复用同条 (重置为 downloading), 返回实际使用的 id (可能跟入参不同).
// 调用方需要拿返回值作为后续 cancel / mark 的 id.
export function add(task: PersistedTask): string {
  if (task.kind === 'download') {
    const existing = tasks.find((t) => t.kind === 'download' && t.url === task.url);
    if (existing) {
      if (existing.status !== 'downloading') {
        existing.status = 'downloading';
        existing.received = 0;
        existing.error = undefined;
        // total / filename 保持原值, 避免进度条第一帧显示 0/0
      }
      persist();
      broadcastSync();
      return existing.id;
    }
  }
  tasks.push({ ...task });
  persist();
  broadcastSync();
  return task.id;
}

export function updateProgress(id: string, received: number, total: number): void {
  const t = tasks.find((x) => x.id === id && x.status === 'downloading');
  if (!t) return;
  t.received = received;
  t.total = total;
  // downloading 状态不 persist, 只单条 broadcast progress
  broadcastProgress(id, received, total);
}

export function updateProgressByUrl(url: string, received: number, total: number): void {
  const t = tasks.find((x) => x.url === url && x.status === 'downloading');
  if (!t) return;
  updateProgress(t.id, received, total);
}

export function markSuccessById(id: string): void {
  const t = tasks.find((x) => x.id === id && x.status === 'downloading');
  if (!t) return;
  t.status = 'success';
  if (t.total === 0) t.total = 1;
  t.received = t.total;
  persist();
  broadcastSync();
}

export function markSuccessByUrl(url: string): void {
  const t = tasks.find((x) => x.url === url && x.status === 'downloading');
  if (!t) return;
  markSuccessById(t.id);
}

// 标记 task 的本地 savePath (will-download item.setSavePath 后调). 不影响 status, 只补字段
export function markSavePathByUrl(url: string, savePath: string): void {
  const t = tasks.find((x) => x.url === url);
  if (!t) return;
  t.savePath = savePath;
  persist();
  broadcastSync();
}

// 查 task savePath 给 show-in-folder IPC 用
export function getSavePathByUrl(url: string): string | undefined {
  return tasks.find((x) => x.url === url)?.savePath;
}

export function markFailedById(id: string, error: string): void {
  const t = tasks.find((x) => x.id === id && x.status === 'downloading');
  if (!t) return;
  t.status = 'failed';
  t.error = error;
  persist();
  broadcastSync();
}

export function markFailedByUrl(url: string, error: string): void {
  const t = tasks.find((x) => x.url === url && x.status === 'downloading');
  if (!t) return;
  markFailedById(t.id, error);
}

// 从列表移除 (cancel / dismiss 共用)
export function removeById(id: string): void {
  const idx = tasks.findIndex((x) => x.id === id);
  if (idx < 0) return;
  tasks.splice(idx, 1);
  persist();
  broadcastSync();
}

export function removeByUrl(url: string): void {
  const t = tasks.find((x) => x.url === url);
  if (!t) return;
  removeById(t.id);
}

export function clearCompleted(): void {
  tasks = tasks.filter((t) => t.status === 'downloading');
  persist();
  broadcastSync();
}

// 清空所有 task. 调用方 (main.ts 的 IPC handler) 负责 abort inflight (download / upload 各自)
export function closeAll(): void {
  tasks = [];
  persist();
  broadcastSync();
}

// 给 closeAll 之前用: 拿到所有进行中 download task 的 url, main.ts 用 attachmentControllers map abort
export function getInflightDownloadUrls(): string[] {
  return tasks
    .filter((t) => t.status === 'downloading' && t.kind === 'download')
    .map((t) => t.url);
}

// 给 closeAll 之前用: 拿到所有进行中 upload task 的 id, main.ts broadcast 给 renderer 让本地 abort controller
export function getInflightUploadIds(): string[] {
  return tasks
    .filter((t) => t.status === 'downloading' && t.kind === 'upload')
    .map((t) => t.id);
}
