// 打包纯服务端 binary 时, 把 web 的 vite build 产物 (packages/web/dist) 复制到
// packages/server/web-dist, 让 pkg 的 assets ('web-dist/**/*') 能把前端打进单文件 exe.
// 运行时 server (config/paths.ts resolveWebDist) 再把它从 snapshot 释放到磁盘 serve.
//
// 不依赖 cwd (用 import.meta.url 定位自身), 跨平台 (Win/mac/Linux 都用 node fs).
import { rmSync, cpSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', 'web', 'dist');
// 拷到项目根 node_modules/quink-web-dist: pkg 的 assets 只可靠打包 node_modules 下用 '../..' 跳出的路径
// (普通 '../../web-dist' 目录 pkg 直接忽略不打, 实测无任何警告也没进 snapshot). 借 node_modules 路径
// 复用 native 模块同款机制. 跟 pkg assets '../../node_modules/quink-web-dist/**/*' 对应
const dest = join(here, '..', '..', '..', 'node_modules', 'quink-web-dist');

if (!existsSync(join(src, 'index.html'))) {
  console.error(`[copy-web-dist] 前端没 build: ${src}\n先跑 pnpm --filter @quink/web build`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-web-dist] ${src} -> ${dest}`);
