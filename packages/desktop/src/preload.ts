import { contextBridge, ipcRenderer } from 'electron';

// 快捷窗口 (Capture / AiChat / Float) 的 preload. 跟主窗口 preload-main.ts 不同 — 暴露窗口专属的 quink
// 命名空间 + 一个简化版 quinkDesktop.
//
// quinkDesktop 暴露最小化接口让 web 端代码识别"我在 Electron 环境": isElectron=true + 3 个 no-op 方法
// (syncToken/syncZoom/reloadShortcuts). 这些动作在快捷窗口里本来就该交给主窗口/主进程处理 (token 一次注入
// 全进程共享, zoom 由 main 端 setZoomFactor 控制, shortcut 由主窗口 reloadShortcuts 触发), 快捷窗口里
// 调到这些不该有副作用, no-op 即可.
//
// why minimal stubs not "不暴露 quinkDesktop": 历史上完全不暴露过, 但 auth.ts 的 syncTokenToDesktop
// 用 `window.quinkDesktop?.syncToken(t)` (`?.` 只 chain 到 quinkDesktop, syncToken 是 undefined 仍会
// 触发 undefined() 抛 TypeError → fetchMe catch 把 user 设 null → 快捷窗口显示"请先在主窗口登录").
// 当时改成不暴露 quinkDesktop 让 `?.` 在第一级断掉. 但留下 footgun: App.vue applyZoomLevel 用
// `quinkDesktop?.isElectron` 判断走 syncZoom IPC, 否则 fallback CSS zoom — 快捷窗口走 CSS zoom 跟 main
// 端 setZoomFactor 叠加变双重缩放 (实测: capture 80% 多空白, 125% 显示不完整). 改成暴露 isElectron=true +
// 关键方法 no-op stubs 一次性根治: applyZoomLevel 走 syncZoom no-op 路径不再 CSS zoom, syncTokenToDesktop
// 调 syncToken no-op 也不抛错.
contextBridge.exposeInMainWorld('quinkDesktop', {
  isElectron: true,
  // 快捷窗口里的 renderer 状态不影响其他窗口, 这些 main 端 IPC 触发动作在快捷窗口 mount 期间被调用是
  // 多余的 (主窗口已经做过), no-op 即可
  syncToken: (_token: string | null) => {},
  syncZoom: (_level: number) => {},
  reloadShortcuts: () => {},
});

contextBridge.exposeInMainWorld('quink', {
  saveNote: (content: string, type: string) => ipcRenderer.invoke('save-note', content, type),
  hideWindow: () => ipcRenderer.send('hide-window'),
  noteSaved: (noteId?: string) => ipcRenderer.send('note-saved', noteId),
  // Vditor 等异步组件加载完后调用，让主进程延迟到此刻才 show 窗口，避免布局跳变
  notifyContentReady: () => ipcRenderer.send('content-ready'),
  onWindowShown: (callback: () => void) => {
    ipcRenderer.on('window-shown', () => callback());
  },
  onWindowHidden: (callback: () => void) => {
    ipcRenderer.on('window-hidden', () => callback());
  },
  attachmentTasks: {
    get: () => ipcRenderer.invoke('attachment-tasks:get'),
    add: (task: any) => ipcRenderer.invoke('attachment-tasks:add', task),
    updateProgress: (id: string, received: number, total: number) =>
      ipcRenderer.send('attachment-tasks:update-progress', { id, received, total }),
    markSuccess: (id: string) => ipcRenderer.send('attachment-tasks:mark-success', id),
    markFailed: (id: string, error: string) =>
      ipcRenderer.send('attachment-tasks:mark-failed', { id, error }),
    remove: (id: string) => ipcRenderer.send('attachment-tasks:remove', id),
    cancel: (id: string) => ipcRenderer.send('attachment-tasks:cancel', id),
    clearCompleted: () => ipcRenderer.send('attachment-tasks:clear-completed'),
    close: () => ipcRenderer.send('attachment-tasks:close'),
    onSync: (cb: (tasks: any[]) => void) => {
      ipcRenderer.removeAllListeners('attachment-tasks:sync');
      ipcRenderer.on('attachment-tasks:sync', (_e, tasks) => cb(tasks));
    },
    onProgress: (cb: (p: { id: string; received: number; total: number }) => void) => {
      ipcRenderer.removeAllListeners('attachment-tasks:progress');
      ipcRenderer.on('attachment-tasks:progress', (_e, p) => cb(p));
    },
    onAbortUploads: (cb: (ids: string[]) => void) => {
      ipcRenderer.removeAllListeners('attachment-tasks:abort-uploads');
      ipcRenderer.on('attachment-tasks:abort-uploads', (_e, ids) => cb(ids));
    },
  },
});
