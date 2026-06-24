import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// 桌面端"连哪个 server"的持久化配置. 存 userData/server-config.json (主进程级, 在建任何窗口前读得到).
// 不能存 localStorage: 服务器地址决定前端从哪个 origin 加载, 而 localStorage 按 origin 隔离
// (本机 localhost vs 远程 Mac IP 不共享), 鸡生蛋. 便携模式下 userData 指到 exe 旁 quink-data, 配置跟着走.

export type ServerMode = 'local' | 'remote';

export interface ServerConfig {
  mode: ServerMode;
  remoteUrl: string; // remote 模式连的服务器地址, 如 http://192.168.0.153:38999 (末尾无斜杠)
  localExposeLan: boolean; // local 模式是否对局域网开放 (true=0.0.0.0 别的设备可连, false=127.0.0.1 锁本机)
}

const configPath = () => path.join(app.getPath('userData'), 'server-config.json');

// 返回 null = 从没配置过 (首次启动), 触发引导页. 字段非法时也当 null 让用户重新引导.
export function readServerConfig(): ServerConfig | null {
  try {
    const obj = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (obj && (obj.mode === 'local' || obj.mode === 'remote')) {
      return {
        mode: obj.mode,
        remoteUrl: typeof obj.remoteUrl === 'string' ? obj.remoteUrl : '',
        localExposeLan: !!obj.localExposeLan,
      };
    }
  } catch {}
  return null;
}

export function writeServerConfig(cfg: ServerConfig): void {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('[server-config] 写入失败', e);
  }
}
