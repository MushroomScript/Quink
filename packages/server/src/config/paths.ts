// 集中管理 server 端数据 / 文件路径. 三种部署形态共用同一套 helper:
//   1. dev / 开发: 不设任何 env, DATA_DIR = process.cwd() (即 packages/server/), DB/uploads 跟在源码旁
//   2. Docker: docker-compose 设 QUINK_DATA_DIR=/data, volume 挂出去
//   3. Electron 本地 spawn: 主进程设 QUINK_DATA_DIR=app.getPath('userData'), 重装不丢
//
// 路径覆盖优先级:
//   DB: QUINK_DB_PATH > path.join(DATA_DIR, 'quink.db')
//   uploads / avatars 没单独 env (用户没需求把附件跟 DB 分盘), 永远跟 DATA_DIR 走
//
// 启动时确保所有目录存在 (mkdir recursive 幂等, 已存在 no-op)

import { resolve, join, dirname } from 'path';
import { mkdirSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

export const DATA_DIR = resolve(process.env.QUINK_DATA_DIR || process.cwd());
export const DB_PATH = process.env.QUINK_DB_PATH || join(DATA_DIR, 'quink.db');
export const UPLOAD_DIR = join(DATA_DIR, 'uploads');
export const AVATARS_DIR = join(UPLOAD_DIR, 'avatars');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(UPLOAD_DIR, { recursive: true });
mkdirSync(AVATARS_DIR, { recursive: true });

// QUINK_WEB_DIST: web 静态文件目录 (vite build 输出). 不设 = dev 模式 (vite dev server 自己 serve 跟代理 /api)
// 设了 = prod 模式, server 同时 serve web 静态文件让用户浏览器直接打 http://server:38999 同源访问 /api/*
// Docker 镜像内典型设 `/app/web-dist` (build stage 产物)
//
// pkg 单文件 exe (process.pkg): web-dist 打进了 binary 的 snapshot 虚拟文件系统. serveStatic 走真实
// fs createReadStream, 对 pkg 虚拟 fs 支持不全 (容易 404), 所以启动时把 snapshot 里的 web-dist 整个
// 复制 (释放) 到真实磁盘 DATA_DIR/web-dist 再 serve. 每次启动覆盖, 保证跟当前 binary 版本一致.
function resolveWebDist(): string | null {
  if (process.env.QUINK_WEB_DIST) return resolve(process.env.QUINK_WEB_DIST);
  if (!(process as any).pkg) return null;
  // pkg snapshot 的虚拟 fs 只支持"文件" stat/read (serveStatic 拼具体文件路径读 + readFileSync index.html
  // 都是文件级), 不支持"目录" lstat/readdir —— cpSync 整目录释放必 ENOENT (文件在 snapshot 但目录 inode 不存在).
  // 所以直接把 snapshot 内的前端目录当 WEB_DIST 交给 serveStatic 按需读单文件, 不往磁盘释放.
  // 入口 bundle 在 .../packages/server/dist-bundle/index.cjs (argv[1], import.meta.url 经 esbuild→cjs 后失效),
  // 上三级是 snapshot 项目根; web-dist 打进 node_modules/quink-web-dist (pkg 只可靠打 node_modules 下的 '../..' assets)
  const here = dirname(process.argv[1] || process.execPath);
  const root = join(here, '..', '..', '..');
  const candidates = [
    join(root, 'node_modules', 'quink-web-dist'),
    join(root, 'web-dist'),
  ];
  const src = candidates.find((p) => existsSync(join(p, 'index.html')));
  if (!src) {
    console.warn('[web] snapshot 内未找到 web-dist (前端不可用)');
    return null;
  }
  console.log('[web] 前端从 binary snapshot serve: ' + src);
  return src;
}
export const WEB_DIST = resolveWebDist();

// 从 package.json 读 version. ESM 不支持稳定的 JSON import, 走 fs + import.meta.url.
// build 后 __dirname = dist/config, package.json 在 dist/../../package.json. dev 走 tsx, __dirname = src/config, 同样 ../../package.json
// 用 try/catch 兜底, 读不到回退 'unknown' 让 server 还能起 (不应该影响业务).
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}
export const VERSION = readVersion();
