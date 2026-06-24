// 桌面内嵌 server (方案 A: electron-as-node) 打包准备脚本.
//
// 产出 packages/desktop/server-runtime/, electron-builder extraResources 把它打进 app 的
// Resources/server/. 主进程 (main.ts startServer) 用 ELECTRON_RUN_AS_NODE=1 跑里面的 index.cjs.
//
// 为什么不用 pkg 单文件: better-sqlite3 ABI 错配 (pkg node22 vs 系统 node) + sharp native 塞不进
// 单文件 (缩略图残废). 改让 Electron 自带 node 跑 server bundle, native 从随包 node_modules 加载,
// better-sqlite3 编成 Electron ABI (electron 35 = ABI 133).
//
// 前置条件 (本脚本不负责, 调用方先做): server 已 tsc + esbuild bundle (dist-bundle/index.cjs),
// web 已 vite build (packages/web/dist).
//
// 隔离: 只复制 + rebuild 到 server-runtime/, 源 node_modules/better-sqlite3 (开发/部署用的 node ABI) 不动.
import { existsSync, readFileSync, rmSync, mkdirSync, cpSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..'); // scripts -> desktop -> packages -> repo root
const ROOT_NM = join(ROOT, 'node_modules');
const SERVER = join(ROOT, 'packages', 'server');
const WEB_DIST = join(ROOT, 'packages', 'web', 'dist');
const OUT = join(ROOT, 'packages', 'desktop', 'server-runtime');
const OUT_NM = join(OUT, 'node_modules');

const require = createRequire(join(ROOT, 'package.json'));
const ELECTRON_VERSION = JSON.parse(readFileSync(join(ROOT_NM, 'electron', 'package.json'), 'utf-8')).version;

// server bundle external 了这几个 native, 它们 + 运行时依赖闭包要随包带.
const ENTRY = ['better-sqlite3', 'sharp', 'libheif-js'];

// ── 1. 依赖闭包收集 (物理目录 BFS) ───────────────────────────────
// 不用 require.resolve(name+'/package.json'): @img/sharp-* 的 exports 不暴露 ./package.json, 必失败.
// 改读物理目录. .npmrc 是 node-linker=hoisted, 根 node_modules 扁平 (像 npm), 大多数包在根;
// 少数版本冲突的嵌套在 <parent>/node_modules/<name>, 故嵌套优先、根扁平兜底.
function findPkgDir(name, parentDir) {
  if (parentDir) {
    const nested = join(parentDir, 'node_modules', name);
    if (existsSync(join(nested, 'package.json'))) return nested;
  }
  const flat = join(ROOT_NM, name);
  if (existsSync(join(flat, 'package.json'))) return flat;
  return null;
}

const closure = new Map(); // name -> 真实目录
function collect(name, parentDir) {
  if (closure.has(name)) return;
  const dir = findPkgDir(name, parentDir);
  if (!dir) return; // optionalDependencies 里其他平台的 @img 包本机没装, 跳过 (CI 各平台装各自的)
  closure.set(name, dir);
  let pj;
  try { pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')); } catch { return; }
  // optionalDependencies 含 sharp 的 @img/sharp-<platform> 平台包, 必须递归 (装了的那个平台带 native)
  const deps = { ...(pj.dependencies || {}), ...(pj.optionalDependencies || {}) };
  for (const d of Object.keys(deps)) collect(d, dir);
}
for (const e of ENTRY) collect(e, null);
console.log(`[prepare] 闭包 ${closure.size} 个包, electron ${ELECTRON_VERSION} (ABI 目标 133)`);

// ── 2. 清理 + 扁平复制 ───────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT_NM, { recursive: true });
for (const [name, dir] of closure) {
  const dest = join(OUT_NM, name);
  mkdirSync(dirname(dest), { recursive: true });
  // 排除包内嵌套 node_modules (闭包已把所有依赖扁平收集, 嵌套复制会重复 + 撑大体积)
  cpSync(dir, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => !src.slice(dir.length).includes('node_modules'),
  });
}

// server bundle + 前端静态文件
cpSync(join(SERVER, 'dist-bundle', 'index.cjs'), join(OUT, 'index.cjs'));
if (!existsSync(WEB_DIST)) {
  console.error(`[prepare] 前端未 build: ${WEB_DIST}\n先跑 pnpm --filter @quink/web build`);
  process.exit(1);
}
cpSync(WEB_DIST, join(OUT, 'web-dist'), { recursive: true });

// @electron/rebuild 读 buildPath/package.json 找 native 模块, 写最小 manifest
const betterSqliteVer = JSON.parse(readFileSync(join(closure.get('better-sqlite3'), 'package.json'), 'utf-8')).version;
writeFileSync(join(OUT, 'package.json'), JSON.stringify({
  name: 'quink-server-runtime', version: '0.0.0', private: true,
  dependencies: { 'better-sqlite3': betterSqliteVer },
}, null, 2));
console.log(`[prepare] 复制完成 -> ${OUT}`);

// ── 3. electron-rebuild better-sqlite3 → Electron ABI ────────────
// sharp 是 N-API (ABI 稳定) 不用 rebuild. libheif-js 纯 wasm/js 不用. 只 better-sqlite3 要.
// 实测 @electron/rebuild 走 prebuild-install 下 prebuilt (不需本地 MSVC 编译), 失败才回退编译.
console.log('[prepare] electron-rebuild better-sqlite3 ...');
const { rebuild } = await import(pathToFileURL(require.resolve('@electron/rebuild')).href);
await rebuild({
  buildPath: OUT,
  electronVersion: ELECTRON_VERSION,
  onlyModules: ['better-sqlite3'],
  force: true,
});
console.log('[prepare] electron-rebuild 完成');

// ── 4. 自检: electron-as-node 实际加载 native (ABI 匹配 + sharp libvips) ──
// electron 二进制不可用时跳过 (CI 某些场景), 能跑就跑、跑挂就 exit (宁可打包失败也不出坏包).
let electronExe = null;
try { electronExe = require('electron'); } catch {}
if (electronExe && typeof electronExe === 'string' && existsSync(electronExe)) {
  // 探针写成 OUT 目录下的临时文件: require('better-sqlite3') 从文件位置向上找 -> OUT/node_modules
  // (ABI 133), 跟打包后 index.cjs 的真实解析路径一致. 不能用 electron -e: inline eval 按 cwd 解析
  // 模块, 在项目根会命中源 node_modules 的 ABI 127 -> 误报失败.
  const probeFile = join(OUT, '.selfcheck.cjs');
  writeFileSync(probeFile,
    "const D=require('better-sqlite3');const db=new D(':memory:');db.exec('create table t(x)');"
    + "db.prepare('insert into t values(?)').run(1);if(db.prepare('select count(*) c from t').get().c!==1)throw new Error('sqlite query fail');"
    + "const s=require('sharp');console.log('[selfcheck] ABI',process.versions.modules,'better-sqlite3 OK, sharp',s.versions.sharp);");
  const r = spawnSync(electronExe, [probeFile], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: OUT_NM },
    stdio: 'inherit',
  });
  rmSync(probeFile, { force: true });
  if (r.status !== 0) {
    console.error('[prepare] 自检失败: native 加载不通过, 产物不可用');
    process.exit(1);
  }
} else {
  console.warn('[prepare] electron 二进制不可用, 跳过 native 自检 (打包后由 electron-builder 验证)');
}
console.log('[prepare] server-runtime 就绪');
