# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库工作时提供指引。

## CLAUDE.md 维护规则

仓库里有多个分层文件，按以下规则维护，避免根目录膨胀：

- **根 `CLAUDE.md`**：跨包通用、全局约定、多文件共享的高频经验（命名规范、UI 交互、跨 view 的动画通用知识、渲染坑等）。Claude Code 启动时自动加载
- **子目录 `CLAUDE.md`**：只该目录或少数关联文件用到的专属内容。Claude 在该目录工作时自动加载
- **同一主题规则数量大、自成体系** → 拆到独立 `CLAUDE.md`（推荐放对应代码目录），根目录留一行指针
- **使用频率低的规则**（如图标系统：写完后改动少）→ 拆到根目录普通 `.md` 文件（**不带 CLAUDE 前缀**），不自动加载，根 `CLAUDE.md` 留指针让 Claude 在需要时主动读。代价是 Claude 需要根 `CLAUDE.md` 的提示才知道去读 → 好处是启动时不占 context

**当前文件清单：**
- 根 `CLAUDE.md`（本文件）— 全局指引、高频规则
- 根 `ICONS.md` — 图标系统约定（不自动加载，改图标时来读）
- `packages/desktop/CLAUDE.md` — Electron 主进程坑（OS 窗口动画、快捷窗口防闪烁、IPC 契约等）
- `packages/web/src/utils/CLAUDE.md` — 卡片列表 leave 动画体系（`cardLeave.ts` + TransitionGroup 多个坑）
- `packages/web/src/composables/CLAUDE.md` — 瀑布流 + 无限滚动体系（`useMasonry` + `useInfiniteScroll`），含 column-count / computed-vs-ref / v-if-loading-unmount / scrollTop 调试 等坑

**新增规则时的判断流程：**
1. **多文件高频用** → 根 `CLAUDE.md`
2. **少数文件专属** → 对应子目录 `CLAUDE.md`
3. **同一主题积累 ~10 行以上** → 考虑独立成 `CLAUDE.md`
4. **写完后改动少 / 低频** → 根目录普通 `.md` 文件，根 `CLAUDE.md` 留指针

## 项目概览

Quink（一念）是一款带 AI 自动打标签、自动分类、写作辅助的个人笔记应用。pnpm monorepo，三个 package：

- **packages/server** — Hono + SQLite（better-sqlite3）+ Drizzle ORM 后端 API
- **packages/web** — Vue 3 + Vite + TailwindCSS + Vditor（Markdown 编辑器）前端
- **packages/desktop** — Electron 桌面壳（主窗口加载 web，全局快捷键弹快速记录窗口）

## 开发命令

```bash
# 启动后端（端口 38999，tsx watch，改代码自动重启）
pnpm run dev:server

# 启动前端（端口 24888）
pnpm run dev:web

# 启动桌面端（编译 desktop ts + 起 electron；走 pnpm filter 才能正确解析根目录的 electron）
pnpm run dev:desktop
```

**Windows 一键启动（推荐）：**
- 双击 `start-server.bat` — 起后端，单独窗口可见日志
- 双击 `start-desktop.bat` — 检查后端 → 起 Vite（24888，最小化窗口） → 编译 desktop → 启 Electron

**坑提醒**：不要写 `cd packages/desktop && npx electron .` —— `electron` 被 pnpm hoist 到根 `node_modules`，npx 在子包目录找不到会触发**现下载**（慢/卡）。永远用 `pnpm --filter @quink/desktop` 或根 `pnpm run dev:desktop`。

前端通过 Vite 配置将 `/api` 请求代理到后端。Electron 主窗口加载 `http://localhost:24888`。

## 架构

### 数据流
```
用户 → Vditor（Markdown）→ API（Hono）→ SQLite
                                      → AI（异步：自动标签/分类/摘要）
```

笔记以 **Markdown** 存储（非 HTML）。Vditor 编辑器原生支持 Markdown。NoteCard 通过 `Vditor.md2html()` 渲染 Markdown → HTML。

### 认证
- JWT token（长期有效，无过期时间）。Token 存在 `localStorage` 的 `quink_token` 字段。
- `server/src/auth.ts` 的 `authMiddleware` 校验所有受保护路由的 Bearer token。
- `/api/auth/*` 登录/注册接口无需认证。
- 用户名不区分大小写（存储为小写）。

### AI 系统
- **多配置**：用户在 `ai_configs` 表创建命名的 AI 配置（provider/url/key/model）。
- **按功能绑定**：每个 AI 功能（auto_tag、auto_classify、polish、expand、write、chat）通过 `preferences.aiBindings` 绑定到具体配置。
- **提示词**：默认提示词在 `server/src/ai/prompts.ts`，用户自定义存在 `ai_prompts` 表。
- **AI 对话（v2）**：已重构为 Function Calling 模式。后端定义 10 个工具（`server/src/ai/tools.ts`），AI 自己决定调用哪个。支持原生 FC + 提示词降级两种模式。流式输出走 SSE。
- **思考模型**：支持 `<think>...</think>` 标签解析（DeepSeek-R1、QwQ 等），前端折叠展示。
- **自动处理**：创建笔记后异步触发 `processNoteWithAi()`（不阻塞）生成标签、分类、摘要。
- **AI 客户端**（`server/src/ai/client.ts`）：统一调用 OpenAI/Anthropic/Ollama，自动识别 URL 格式。
- **弱模型 / 量化模型适配**：本地 Ollama 上 qwen2.5-coder q4 这类小模型对 OpenAI Function Calling 协议支持差，第一轮 native FC 经常返回空 `tool_calls` + 直接编内容（"买菜/完成报告"这种训练样本）。`callAiWithToolLoop` 在 round 0 检测到 `toolCalls.length === 0 && !content.includes('<tool>')` 时强制降级到提示词模式重试，把 `TOOLS_PROMPT` 拼进 system 引导输出 `<tool>...</tool>`。
- **弱模型不会数数**：列表类工具（如 `get_todos`）必须在返回字符串开头直接拼好数量（"共 X 条（已完成 Y / 未完成 Z）："），不要指望 AI 自己 count。chat prompt 也明说"数量直接读开头那行，别重新数"。
- **chat prompt 三大块**：`prompts.ts` 的 chat 段定义了【强制规则】（询问待办/笔记/标签必须先调工具）、【工具返回的笔记数据格式】（ID/refId 不发给用户、引用 label 怎么读）、【汇总/分析处理方式】（置顶要标⭐、临近截止要提醒、末尾给观察）。改 chat 行为先动这里。
- **引用 label 透传给 AI**：`tools.ts` 的 `cleanContent` 把笔记里的引用块 `[label](?ref=xxx)` 转成 `「label」(refId:xxx)`，AI 直接看到被引笔记 ID，可调 `get_note(id=xxx)` 拿详情；prompt 里 refId 禁止发给用户。`search_notes` 同时 OR 搜 content + summary + tags，避免 label 只在 summary/tags 时漏检。

### 主题系统
`style.css` 中的 CSS 变量定义了 7 套主题（blueberry、lavender、mint、peach、lemon、cloud、dark）。通过 `<html>` 上的 `data-theme` 属性切换。Tailwind 颜色引用这些变量：
- `primary` / `primary-light` / `primary-dark` → `--c-accent*`
- `sidebar` / `sidebar-light` → `--c-sidebar*`
- 侧边栏文字色 → `--sb-text`、`--sb-dim`、`--sb-hover` 等
- 暗色主题需为每个使用硬编码颜色的地方加 `[data-theme="dark"]` 覆盖

### Electron
- **主窗口**：加载前端 URL，无菜单栏（`Menu.setApplicationMenu(null)`）。
- **快速记录窗**：加载 `/capture` 路由，无边框，置顶，Shift+Space 触发。
- **全局快捷键**：通过 `uiohook-napi`（低级键盘钩子，支持 Electron 的 `globalShortcut` 无法注册的 Shift+Space）。
- **Token 同步**：主窗口通过 `preload-main.ts` IPC 把 token 发给 Electron 主进程，供快速记录窗调用 API。

### 移动端
- 通过 Tailwind `md:` 断点（768px）做响应式。
- 小屏：侧边栏改抽屉，搜索折叠成图标，`MobileInput`（textarea）替换 Vditor。
- `100dvh` + JS `--app-height` 处理 iOS Safari 视口。

### 数据库
SQLite + 启动时自动迁移（`db/index.ts` 中 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` 包 try-catch）。Schema 在 `db/schema.ts`（Drizzle ORM）。核心表：`users`、`notes`（含软删除 `deleted_at`）、`categories`、`files`、`ai_configs`、`ai_prompts`、`ai_conversations`、`ai_messages`、`voice_transcriptions`。

### 笔记类型（type 字段）
- schema 定义 4 个值：`note / todo / snippet / link`（看 `db/schema.ts`）
- 前端 sidebar 主导航只有 3 个对应 view，**type 到 view 的映射不直观**：
  - `/` 灵感（`Inspiration.vue`）→ `filterType='note'`
  - `/notes` 笔记（`Notes.vue`）→ `filterType='snippet'`（**不是 `note`**）
  - `/todos` 待办（`Todos.vue`）→ `filterType='todo'`
  - `type='link'` **无专属 view 入口**，创建后只能通过搜索或 AI 工具调用查到（设计 quirk，未来补 `/links` 路由 + filterType='link' 才能用）
- 这个映射也写在 `utils/cardLeave.ts` 的 `TYPE_TO_NAV_PATH`（控制回收站恢复时卡片飞向哪个 sidebar 菜单项）。改 type 枚举或加 view 时记得两边都改。

### Vditor
静态文件从 `packages/web/public/vditor/dist/`（从 node_modules 复制）提供。RichEditor.vue 的 CDN 配置指向 `/vditor`。`pnpm install` 后执行：`cp -r node_modules/vditor/dist packages/web/public/vditor/dist`

## 核心约定

- 所有 UI 文案使用中文。
- 全局 `<body>` 加 `spellcheck="false"`，杜绝任何红色波浪线。
- 所有输入框颜色用 CSS 主题变量，禁止硬编码 hex（使用 `rgb(var(--c-accent))` 模式）。
- 笔记内容是 Markdown。AI 返回 Markdown。无需 HTML↔MD 转换。
- 笔记软删除（`deleted_at` 字段），30 天后自动彻底清除。
- 端口：后端 38999，前端 24888。配置在 `vite.config.ts` 和 `server/src/index.ts`。

## UI 交互约定

- **危险操作必须弹窗确认**（删除/清空/永久删除等），禁止在按钮原地切换文字。使用 `confirmXxxId` ref + Teleport 居中弹窗 + 取消/确认双按钮。
- **按钮要有背景色**：主要操作 `bg-primary-light text-primary-dark`，危险操作 `bg-red-50 text-red-500`，hover 加深。
- **数字显示用 `tabular-nums`** 等宽字体类，避免切换页面时数字跳动。
- **暗色主题全适配**：所有硬编码颜色必须在 style.css 加 `[data-theme="dark"]` 覆盖。
- **搜索高亮**统一用全局琥珀色（`#fbbf24` / `#d97706`），柠檬主题例外用紫色（避免黄底黄字）。
- **批量操作用乐观更新**：`恢复所有` / `清空回收站` 等批量 API 调用，**必须先改 UI 触发动画再 await API**。否则若 `Promise.all` 中任一 reject，整个 Promise.all reject → 空 catch 吞掉 → 数据变更（如 `notes.value = []`）不执行 → **动画不触发**。乐观更新代价是 API 失败时 server 数据不一致（UI 已清空 server 还有），下次刷新会自动同步；用 `console.error` 留痕。范例：`Trash.vue` 的 `doRestoreAll` / `doEmptyAll`。

## 图标系统

全软件图标约定（统一用 `@phosphor-icons/vue`、PhXCircle vs PhX、weight/size 规则、v-html 内嵌、视觉中心偏移 nudge 等）—— 详见根目录 **`ICONS.md`**。改图标相关代码（新增图标、调整 size/weight、加 nudge）前先读那里。

## 渲染坑

- **`html.replace(regex, '<mark>$1</mark>')` 这种字符串级别的搜索高亮会破坏 HTML 属性**（比如 `<a href="x.mp3">` 里的 mp3 被替换 → CSS 选择器 `a[href$=".mp3"]` 不匹配 → 音频胶囊样式失效）。正确做法：用 `(<[^>]+>)|([^<]+)` regex 拆"标签 vs 文本"，只在文本上替换。范例：`NoteCard.vue` 的搜索高亮。AI.vue 用 TreeWalker + range.surroundContents，天然安全。
- **下拉/popover 在编辑器旁边总被盖住**：编辑器（Vditor 等）经常创建 stacking context，子组件的 z-[9999] 不起作用。解决方案：**默认走 `<Teleport to="body">` + `position: fixed` + 动态算位置**。范例：TopBar 的标签建议下拉、batchMove 下拉。
- **"下拉 + 遮罩"成对组件不能"半个 Teleport"**：典型是"点外面关菜单"模式——菜单 `absolute z-50` + 全屏透明遮罩 `fixed z-40`。如果只 Teleport 其中一个，遇到祖先有 stacking context（`opacity != 1` / `transform` / `filter` / `will-change` 等）时本地那个 z-index 会被困在局部 context、对外失效（等同 z-auto），Teleport 出去的反而盖住它，**点击全落到遮罩上、菜单按钮看着在那但全部失效**。修法：要么都 Teleport，要么都不。范例：NoteCard 三点菜单+关闭遮罩 在 Todos 已完成区 `.notes-masonry opacity-60` 内被坑过（编辑/置顶/撤销完成/删除全点不动）。
- **圆角裁切 + absolute 定位锚点不要混在同一个 div 上**：父级 `overflow-hidden` 会裁掉绝对定位的子下拉。修法：外层套一个仅做 `relative` 的容器，内层做 `overflow-hidden` 圆角裁切。
- **"拖动 + 单击关闭"并存要防"拖完误关"**：`mousedown → 拖 → mouseup` 后浏览器自然会再触发一次 `click`，如果这个元素的 click 绑了关闭/导航，手刚松开就误触发。修法：`mousemove` 时记录 `dragMoved = true`（带 ~3px 阈值避免抖动误判），`click` handler 检测 `dragMoved` 真就 `return`、否则关闭。同时 `mousemove` / `mouseup` 监听必须挂 `window`（不是元素本身），否则鼠标快速移出元素时拖动状态会卡住；`<img>` 加 `draggable="false"` 防止 HTML5 原生拖图弹出半透明鬼影。范例：`Resources` 图片预览（放大后可拖、单击关闭，两者共存）。
- **markdown 内嵌 emoji + 渲染端 regex 自动加 emoji = 双图标 bug**：写入端就别塞 emoji，渲染端用 `replace(/^📌\s*/, '')` 剥老数据的前缀。范例：`utils/refLink.ts`。
- **Windows bat 文件编码**：永远用 PowerShell `[System.IO.File]::WriteAllBytes` 写 **GBK + CRLF** 的 bat 文件，**不要**用 Write 工具（UTF-8 + LF），cmd 默认 cp936 会把 UTF-8 中文字节当命令分隔符乱读。`chcp 65001` 救不了，因为 cmd 逐行读，那一行本身就被拆了。
- **Vditor (lute) 解析器会破坏 markdown 内嵌的 inline `<svg>` / HTML span**：把 SVG 字符串拼进 markdown 字符串里 → `md2html` 后 span 的 class/data-* 一并被剥掉，全局 click 监听找不到锚点（典型症状：引用预览不弹了）。**分两步**：markdown 阶段只生成不带 SVG 的纯 span，md2html 之后再用 `injectXxxIcons(html)` 用 string.replace 把 SVG 注入进去。范例：`utils/refLink.ts` 的 `renderRefLink` + `injectRefLinkIcons` 双阶段。三个调用点 `NoteCard.vue` / `App.vue` / `NoteDetail.vue` 都要走这个流程。
- **`onMounted` 给 `document`/`window` 挂全局副作用 HMR 不友好**：开发期 HMR 重 mount 后旧 handler 还在 document 上，capture 阶段先于新 handler 触发并 `stopImmediatePropagation`，调用旧闭包里的函数（操作旧响应式状态，新 UI 完全没反应；典型症状："改完代码 X 功能失效，F5 就好"）。**`onBeforeUnmount` 不够用**——HMR 卸载顺序不可靠。修法：组件文件顶部用模块级 `let prevXxxHandler = null` 缓存上次挂的对象，下次 `onMounted` 入口先 `removeEventListener` / 还原原函数再挂新的。范例：`App.vue` 顶部 `prevRefClickHandler` + `prevWindowOpen` 的模块级清理逻辑。
- **流式 markdown 渲染用"单调递增版本号 + GT 比较"**：每个 SSE delta 都触发一次 `Vditor.md2html(snapshot)`（异步、多个 in-flight、完成顺序乱）。错误做法是给每个 delta 分 `myVer` 然后完成时检查 `myVer === currentVer`（"还是最新版才覆盖"），结果连续 delta 时 myVer 永远被超越 → 永远不更新 → 看着"全部出完才渲染"。**正解**：维护 `lastRenderVer`，完成时 `myVer > lastRender` 才覆盖（内容单调向新）。范例：`AI.vue` 的 `streamingVersion` + `streamingLastRenderVer`。
- **TransitionGroup 列表删除"左飞 + 高度收缩"动画**：用 `<TransitionGroup name="xxx" tag="div">` 包 v-for；CSS `.leave-active` **必须** `overflow: hidden`，否则 max-height 不生效；`.leave-to` 同时设 `max-height: 0`、`opacity: 0`、`transform: translateX(-110%)`，并把 `margin/padding-y` 都 `!important` 归零（否则空间不收缩、相邻项不会自然上移）；`.leave-from` 显式给个 max-height（如 5rem）作为起点。范例：`AI.vue` 末尾的 `.conv-list-leave-*`。
- **笔记卡片列表 leave 动画体系**（`utils/cardLeave.ts` 含 `fadeOutLeave` / `collapseLeave` / `flyToNavLeave` / `fadeInEnter`）—— 涉及 TransitionGroup + Vue FLIP 干扰、`watch flush:'sync'` snapshot、helper 按容器布局选型、staying 对齐动画依赖等多个坑，详见 **`packages/web/src/utils/CLAUDE.md`**。改这些 helper 或在 view 里用它们前先读那里。
- **`prompts.ts` 模板字符串里别嵌反引号写示例**：在 `` `...` `` 模板字符串内再写 `` ` `` 会让 tsx 解析器把模板字符串提前闭合 → server 起不来 → 没有红色编辑器警告，只有运行时崩溃。**用 「」 或 '...' 包代码/字段示例**。范例：`prompts.ts` chat prompt 里 `「label」(refId:xxx)` 写法（不要再变成 `` `「label」(refId:xxx)` ``）。
- **`Vditor.insertValue` 在异步回调里必须先 `focus()`**：`insertValue` 内部走 `range.insertNode`，插入位置是浏览器**全局 selection**，不是 editor 内位置。异步等待期间（上传 / 引用搜索 / AI 应用 / 录音上传）用户可能点了别处，selection 跑到 TopBar / Sidebar / 任意 DOM 节点 → markdown 文本作为纯 text node 插到那里，**切换路由不消失**（被插的节点不在 router-view 子树），F5 才能刷掉。偶发，看用户点击时机。**统一 pattern**：`vditor?.focus(); setTimeout(() => vditor?.insertValue(...), 80);`，给浏览器 ~80ms commit focus。范例：`RichEditor.vue` 全部 4 处 insertValue（upload format / insertRef / applyAiResult / uploadPendingVoice）都走这个。
- **Vditor 工具栏 upload 项是 `<div>` 不是 `<button>`**：源码硬编码 `s = "upload" === t.name ? "div" : "button"`，整个工具栏唯一例外。任何 `.vditor-toolbar__item button` 的样式（尺寸 / color / hover 灰底圆角 / 子 SVG width/height）对 upload **全失效**，要把 `[data-type="upload"]` 接进同一组 selector。另外 div 默认不居中，要单独给 upload 加 `display: inline-flex + align-items: center + justify-content: center + cursor: pointer`，否则 SVG 贴左上角且鼠标不变手。范例：`RichEditor.vue` toolbar 样式块（`.vditor-wrapper .vditor-toolbar__item ...` 那一段）。
- **Vditor mount 会覆盖 wrapper inline style 的 minHeight**：源码 `e.element.style.minHeight = options.minHeight + 'px'` 直接写到 wrapper 上。如果 Vue 端 `:style` 设的 minHeight 跟传给 Vditor 的 `options.minHeight` 不一致，会出现"加载前高 / 加载后矮 / 用户首次 reactive 交互后再变高"的三段抖动 —— 因为 Vue 每次 patchStyle 会把 :style object 里的 minHeight 重写回 element.style，盖掉 Vditor 设的。**修法**：让 Vue 端 inline minHeight 精确等于传给 Vditor 的 `options.minHeight`（不要自己加 toolbar 占位高度），三个时刻就一致。范例：`RichEditor.vue` 的 `<div ref="editorRef" class="vditor-wrapper" :style="{ minHeight: minHeight + 'px' }">` 跟 Vditor config `minHeight: props.minHeight` 完全对齐。
- **Vditor IR 模式 heading 的 H1/H2/H3 标记会"半个数字"溢出编辑区左边**：Vditor 给 heading 加 `:before` 伪元素显示 "H1" / "H2" 标记，定位用 `margin-left: -29px` 飞到编辑区外。我们 `.vditor-reset` 的 `padding-left: 16px` 不够容纳 29px 偏移 → 标记左半被裁。**修法**：直接 `display: none !important` 隐藏标记，IR 已经把 heading 渲染成大字粗体，语义足够明显，不需要额外标记提示。范例：`RichEditor.vue` 的 `.vditor-ir .vditor-reset > h1..h6:before` 隐藏。
- **Vditor toolbar tooltip 默认伪元素会被 `main` 的 `overflow-y-auto` 裁切**：App.vue 的 `<main class="flex-1 overflow-y-auto">` 让 tooltip 飞出 main 上边界（朝向 TopBar 方向）时被 overflow 裁掉一半。这跟 z-index / stacking context 无关 —— overflow 裁切是另一回事。**修法**：CSS 隐藏 Vditor 默认 tooltip 伪元素，用 `<Teleport to="body">` 实现自定义 tooltip：mouseover 事件委托到 vditor-wrapper → closest `.vditor-tooltipped` 找按钮 → 读 `aria-label` → `getBoundingClientRect` 算位置 → fixed 定位 + `z-[10000]` 永远顶层。**边界处理**：`r.top < 32` 时自动翻转到按钮下方（应对 Capture 等顶部贴边场景）；tooltip center 用 `clamp(HALF+MARGIN, vw-HALF-MARGIN)` 防止最左/最右按钮 tooltip 超出窗口边界。范例：`RichEditor.vue` 的 `customTooltip` + `onToolbarMouseOver`。
- **markdown 编辑器按 Enter vs 粘贴文本行间距差异**：Markdown 语法里"换行"是个语义陷阱 —— 按 Enter 一次生成段落分隔（`<p>...</p><p>...</p>`，间距 = `p` 的 `margin-bottom` 默认 16px）；粘贴含 `\n` 的多行文本生成同段落硬换行（`<br>`，间距 = `line-height` 大约 21px）。视觉上"两行文字"但 DOM 结构完全不同。Vditor 默认 `.vditor-reset p { margin-bottom: 16px }` 让段落间距偏大。**修法**：全局 CSS 把 `.vditor-reset p` 和 `.note-content p` 的 `margin` 缩小到 `0.4em`（用 em 跟字体缩放）。**保留 markdown 段落语义**（导出 / 搜索 / AI 处理都正确），只调视觉。范例：`style.css` 的 `.note-content p, .vditor-reset p { margin: 0 0 0.4em !important }`。

## Electron 快捷窗口（Capture / AiChat）

涉及 Win11 OS 窗口动画、主题闪烁 4 层防御、`currentTheme` 缓存同步、持久窗口 vs 销毁重建策略、IPC 契约等坑——这些只有 `packages/desktop/` 主进程 + 少数 web 端文件（`Capture.vue` / `AiChat.vue` / `RichEditor.vue` / `index.html`）会涉及，详见 **`packages/desktop/CLAUDE.md`**。改 desktop 主进程或动这几个 web 文件前先读那里。

## 编码规范

### 命名规范
| 场景 | 规范 | 示例 |
|------|------|------|
| 数据库列名 | snake_case | `user_id`、`created_at`、`todo_status` |
| TypeScript 变量/函数 | camelCase | `userId`、`sendMessage`、`currentConvId` |
| TypeScript 类型/接口 | PascalCase | `Note`、`AiConfig`、`ChatMessage` |
| Vue 组件文件 | PascalCase | `NoteCard.vue`、`TopBar.vue` |
| CSS 类名 | kebab-case | `note-content`、`voice-bubble` |
| 常量 | UPPER_SNAKE_CASE | `DEFAULT_PROMPTS`、`TOOL_DEFINITIONS` |
| API JSON 响应字段 | camelCase | `{ userId, createdAt, todoStatus }` |

### 数据库查询
- **必须使用 Drizzle ORM 查询**，禁止使用 `db.all(sql\`...\`)` 等原始 SQL 返回数据给客户端（ORM 自动处理 snake_case → camelCase 映射）。
- 原始 SQL 仅限内部统计/迁移等不直接返回给前端的场景。如必须使用，需给列加 `AS camelCase` 别名。

## 文件上传
上传接口 `/api/upload/file`，静态服务 `/api/uploads/*`。文件存在 `packages/server/uploads/` 并在 `files` 表登记。最大 20MB。头像上传接口 `/api/upload/avatar`（2MB 限制）。
