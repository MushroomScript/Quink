import { contextBridge, ipcRenderer } from 'electron';

// 主窗口 preload — 用于同步 token 和快捷键
contextBridge.exposeInMainWorld('quinkDesktop', {
  syncToken: (token: string | null) => ipcRenderer.send('sync-token', token),
  reloadShortcuts: () => ipcRenderer.send('reload-shortcuts'),
  syncTheme: (theme: string) => ipcRenderer.send('sync-theme', theme),
  syncFontSize: (size: number) => ipcRenderer.send('sync-font-size', size),
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
  // 用系统默认应用打开附件 URL(fetch 到临时目录 → shell.openPath)
  openAttachment: (url: string) => ipcRenderer.invoke('open-attachment', url),
  // 订阅附件下载进度: main 流式 fetch 时每 100ms 推一次 { url, received, total }
  // removeAllListeners 防止 HMR 重 mount 时累积 listener
  onAttachmentProgress: (cb: (data: { url: string; received: number; total: number }) => void) => {
    ipcRenderer.removeAllListeners('attachment-progress');
    ipcRenderer.on('attachment-progress', (_e, data) => cb(data));
  },
  isElectron: true,
});
