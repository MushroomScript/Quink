import { contextBridge, ipcRenderer } from 'electron';

// 主窗口 preload — 用于同步 token 和快捷键
contextBridge.exposeInMainWorld('quinkDesktop', {
  syncToken: (token: string | null) => ipcRenderer.send('sync-token', token),
  reloadShortcuts: () => ipcRenderer.send('reload-shortcuts'),
});
