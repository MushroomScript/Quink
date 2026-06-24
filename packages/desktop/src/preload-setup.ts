import { contextBridge, ipcRenderer } from 'electron';

// 引导页 (ui/setup.html) 专属 preload. 暴露 quinkSetup 命名空间.
// 不 import serverConfig (那里 import 了 app, preload 是 renderer 上下文 app 不可用), 类型 inline.

contextBridge.exposeInMainWorld('quinkSetup', {
  // 测试连接: main 端 fetch {url}/api/health (5s 超时), 返回是否通 + 失败原因
  testConnection: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('setup:test-connection', url),
  // 保存配置: main 写盘 + relaunch app 应用 (origin/host 变了必须重启)
  save: (cfg: { mode: string; remoteUrl: string; localExposeLan: boolean }) =>
    ipcRenderer.send('setup:save', cfg),
  // 取当前配置 (切换服务器时预填表单), 首次启动返回 null
  getCurrent: (): Promise<{ mode: string; remoteUrl: string; localExposeLan: boolean } | null> =>
    ipcRenderer.invoke('setup:get-current'),
});
