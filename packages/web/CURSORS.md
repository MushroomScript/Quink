# 鼠标光标系统（Bibata × Quink 7 主题）

全套 cursor 跟随 `<html data-theme>` 主题色动态变化。每主题 15 种 cursor（default / pointer / text / grab / grabbing / not-allowed / move / crosshair / help / wait / progress / zoom-in / zoom-out / copy / row-resize）。

## 文件清单

| 文件 | 作用 |
|---|---|
| `packages/web/scripts/gen-cursors.mjs` | 生成脚本。SVG 模板 + 主题色 + hotspot 都写在这。改主题色 / 加新 cursor 时改这个 |
| `packages/web/src/styles/cursors-base.css` | 通用元素 → cursor 映射（main.ts 一直 import，~3KB）|
| `packages/web/src/styles/loadThemeCursors.ts` | 监听 `<html data-theme>` 动态换 `<link>` href |
| `packages/web/public/cursors/cursors-{theme}.css × 7` | 每主题 `:root { --cur-* }` 变量定义（~28KB / gzip ~7KB）|

启动时 `cursors-base.css` 静态 import，`loadThemeCursors.ts` 立即按当前 `data-theme` 注入 `<link>`。切主题靠 MutationObserver 监听 → 换 `link.href` → 浏览器自动重新加载新文件 → `:root` 变量值刷新 → 所有元素 cursor 跟着变。

## 改主题色 / 加新 cursor 的流程

**改主题色**：

1. 改 `packages/web/src/style.css` 的 `--c-accent` / `--c-accent-dark`（SSOT）
2. 改 `packages/web/scripts/gen-cursors.mjs` 头部的 `THEMES` 同步主题色（手动同步，没自动）
3. 重跑：`node packages/web/scripts/gen-cursors.mjs`
4. **浏览器 Ctrl+Shift+R hard reload**（vite 不 watch `public/`）

**加新 cursor 类型**（比如想要 `ew-resize`）：

1. 找 Bibata 仓库对应的 SVG（`https://github.com/ful1e5/Bibata_Cursor/tree/master/svg/groups/`）。常用名字：
   - `sb_v_double_arrow` ↔ ns-resize / row-resize（上下双箭头）
   - `sb_h_double_arrow` ↔ ew-resize / col-resize（左右双箭头）
   - X11 Cursor 命名约定，不是 CSS 名
2. SVG 占位色规则（Bibata 通用）：`#0000FF` = 深色描边/阴影 / `#00FF00` = 主色填充 / `#FF0000` 或 `#FE0000` = 真红色（保留）。脚本里替换 `$F$` = accent、`$S$` = accent-dark
3. 加 `SVGS['xxx']` + `HOTSPOTS['xxx']` 到 `gen-cursors.mjs`
4. 加 Tailwind 兼容类 `.cursor-xxx` 到 base.css 生成段
5. 重跑脚本 + hard reload

## 改不了的边界（CSS 限制）

| 场景 | 原因 |
|---|---|
| Electron OS 窗口边缘 resize | OS 框架画的，不属于 web 内容 |
| `<input type="date">` 展开的日历面板内部 | Chromium UA shadow DOM，CSS 选择器穿不进 |
| `<input type="file">` 的"选择文件"原生按钮内部 | 同上 |
| `::-webkit-scrollbar` 滚动条本体 | 浏览器原生组件 |
| Vditor 编辑器某些块内部 | Vditor 自己 CSS 优先级 |
| ECharts canvas hover | canvas 渲染，靠 ECharts JS API 不是 CSS |

要绕过只能换实现：自定义日期 picker / 自定义 file 上传组件 / 自定义滚动条 / 自定义编辑器。**通常不为光标这一件事做**。

## CSS specificity 战争（必读，否则 cursor 不接管）

按 specificity 升序：

1. **`html, body { cursor: var(--cur-default), default }`** ← 最弱，匹配所有
2. **`a, button, input...`** 元素语义规则 ← 中等
3. **`.cursor-pointer`** Tailwind 类 ← 同 (2) 但写在 div 上才赢 (2)
4. **`.active\:cursor-grabbing:active`** Tailwind 变体 ← 比 (3) 高一级
5. **`.specific-class { cursor: pointer }`** 项目手写 ← 跟 (3) 同级，靠加载顺序定胜负
6. **`element.style.cursor = ...`** inline / JS 设 ← 最强，CSS 永远赢不了

**实操规则**：
- 项目里所有自定义 class 写 `cursor: pointer` 时**必须**写成 `cursor: var(--cur-pointer), pointer`。不然 Bibata 接管不到。
- JS 设 `body.style.cursor` 时同样：`'var(--cur-row-resize), row-resize'`。Sidebar.vue 拖宽是范例。
- Tailwind 变体（`active:` / `disabled:` 等）要在 gen-cursors.mjs 里手动加对应 `.variant\:cursor-X:state` 覆盖规则。

新加自定义 cursor class 用法时如果发现没接管，第一反应：grep specificity 是不是输了。

## vite dev race + 浏览器 cache 防御

`gen-cursors.mjs` 一次性写 7 个 CSS 文件，vite chokidar 偶尔漏识别某 1-2 个 → 浏览器首次 fetch 拿到 SPA fallback 的 `index.html` → CSS 解析 0 条规则 → cursor 失效。

`loadThemeCursors.ts` 的防御：`link.onload` 检测 `link.sheet.cssRules.length === 0`，0 条规则就拼 `?retry=Date.now()` 重拉一次。重试 1 次后失败放弃（避免 CDN 真挂时死循环）。

**dev 期间另一个 cache 问题**：vite 不 watch `public/`，跑完脚本浏览器还指向同 URL → 命中浏览器/vite cache 拿旧 CSS。**人工 Ctrl+Shift+R**。生产构建（vite build）会给静态文件加 hash，没这问题。

## 项目内 cursor 接管点（grep 帮助理解）

通用元素映射在 `cursors-base.css` 末尾；项目内手写 cursor 的位置 grep:

```bash
# 手写 cursor 用 var() 包装的：
rg "cursor:\s*var\(--cur-" packages/web/src
# JS 设 cursor:
rg "\.style\.cursor\s*=" packages/web/src
```
