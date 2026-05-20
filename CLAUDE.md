# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库工作时提供指引。

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

- **统一用 `@phosphor-icons/vue`**，禁止再用 emoji 当图标、禁止手写 inline SVG。极少数 v-html 字符串里嵌入图标的场景用 inline phosphor SVG path（见 `utils/refLink.ts`）。
- **`PhXCircle` vs `PhX` 用法**：所有"软关闭/删除"位置（搜索框清空、列表项删除、对话删除、弹窗关闭、查找栏关闭等）一律 `PhXCircle`（圆圈包 X，视觉柔和）。**`PhX` 只用于"窗口级关闭"**：Electron 标题栏 X、图片预览全屏 X（本身有圆形容器或系统级语义）。
- **weight 默认 `fill`**（实心）。两种例外允许局部用 `bold`：
  - 三点菜单（`PhDotsThreeVertical`）— fill 像红绿灯
  - Electron 标题栏 3 按钮（最小化/最大化/关闭）— fill 显得是黑块，bold 更像 Win11 线条按钮
- **size 用 rem 字符串**：`size="1rem"` / `size="0.875rem"`（=14px @ 16px html font-size）。**禁止用数字 px**（`:size="14"`），因为图标不会跟着用户的字体大小设置（设置 → 字体）缩放。
  - 数字 px 到 rem 的换算就是 N / 16
- **v-html 内嵌图标**：组件 `<PhXxx />` 不能用在 v-html 渲染的字符串里（Vue 不解析字符串里的组件标签）。必须直接写 inline SVG 字符串。SVG 必须加 `pointer-events: none`（否则会拦截父元素的 click 事件，导致 closest('.xxx') 失败）。`utils/refLink.ts` 是引用块的范例。
- **Phosphor 图标的视觉中心 ≠ 几何中心**：`flex items-center` 居中后某些图标看着"高 / 低"，文字 + 图标的同一行尤其明显。常见偏移：`PhBookOpen` 视觉重心偏下（书脊上窄、书页向下展开） / `PhPenNib` 重心偏上（笔尖突出右上） / `PhPencilSimple`、`PhTrash`、`PhCheck`、`PhArrowCounterClockwise` 都重心偏上 / `PhSparkle`、`PhPushPin`、`PhMapPin` 对称良好无需 nudge。修法：inline style `margin-top: ±1~2px` 单独微调，或用 Tailwind 任意选择器 `[&_svg]:mt-px` 给容器内所有 svg 统一加 nudge（再用 inline style 个别 override）。**字号越小、padding 越紧凑时偏移越显眼**（11px 小字下 1px 都明显）。范例：`NoteCard` 三点菜单（菜单内全员 `mt-px`，编辑/删除/标记完成 inline override 到 2px）、`RichEditor` AI 按钮组（润色/扩充/写文 各自 nudge）。

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
- **TransitionGroup + JS `@leave` 钩子做"飞行/淡出"卡片动画的多个坑**（`utils/cardLeave.ts` 是封装好的 helper，含 `fadeOutLeave` / `fadeInEnter` / `flyToNavLeave`；三个 view `Trash.vue` / `Inspiration.vue` / `Todos.vue` 都用它）：
  - **坑 1：leave 钩子拿到的是 v-if 切换后的错位坐标**。Vue 的 patch 顺序里，v-if 切换（顶部工具栏 `v-if="notes.length > 0"` 消失、空提示 `v-if="notes.length === 0"` 出现）会先于 TransitionGroup 的 leave 钩子执行。leave 钩子里 `getBoundingClientRect()` 拿到的是容器被推位移**后**的坐标，所有 leaving 元素"瞬移"。修法：view 里加 `watch(() => list.length, () => snapshotCards(), { flush: 'sync' })`，在 reactive 变化的**同一同步上下文**里主动 snapshot 所有卡片当前位置（DOM 还没 patch，位置准确），leave 钩子直接读 WeakMap 缓存。
  - **坑 2：onLeave 同步设 `transition: transform` 会被 Vue FLIP 清空 transitionDuration 导致瞬间到位**。Vue TransitionGroup 在 `onUpdated`（leave 钩子之后**同步**执行）里跑 FLIP move：`hasCSSTransform` 检查"元素有没有 transform transition"——它**克隆元素**并复制 inline style，看到我设的 `transition: transform 0.5s` 后返回 true → 给所有 leaving 元素加 `v-move` class **并清空 `style.transitionDuration = ''`** → RAF 后设的 transform 瞬间到位（典型症状："全没了 没动画"）。修法：**两层 RAF 推迟 inline transition 设置**到 onUpdated 之后。第一层 RAF 设 `transition`，第二层 RAF 设 `transform` 触发动画。这样 hasCSSTransform 检查 clone 时 inline 没有 transition: transform，返回 false → 跳过 FLIP → 不清空 duration。
  - **坑 3：staying 元素"平滑对齐"动画依赖 class 上的 `transition-transform`**。Vue FLIP 给 staying（没被删的）元素设 transform 做位置补偿，紧接着 `addTransitionClass(v-move)`——但 `v-move` CSS 没定义，所以 transform 变化没过渡，**剩余卡片瞬间补位**。`NoteCard.vue` 因为有 `transition-all duration-200`（本来给 hover 阴影用）顺带让 FLIP move 生效，所以待办/灵感页删除时剩余卡片有平滑对齐动画。新列表组件想要这个效果必须主动加 `transition-transform duration-300`。范例：`Trash.vue` 的卡片 div。
  - **坑 4：批量 leave 时不能在 onLeave 内部第一次遍历兄弟元素 snapshot**——浏览器会在第一次 `position:fixed` + 第二次读 BCR 之间 flush layout，剩余卡片被 column-count 重排到 column 1 顶部，所有后续 leave 钩子拿到的都是 column 1 顶部坐标 → 全 fixed 到一处重叠。所以 snapshot 必须在数据变更**前**完成（靠 watch flush:'sync'）。
  - `:css="false"` 只跳过 enter/leave 的 CSS class 操作，**不阻止 FLIP move**（FLIP 是 Vue 内部逻辑，照常跑）。要绕开 FLIP 要么用上面坑 2 的推迟方案，要么把 leaving 元素 detach 出 TransitionGroup 容器（更激进但 Vue removeChild 时会报错）。
- **列表删除动画 helper 选型 cheat sheet**（`utils/cardLeave.ts`）—— 选哪个 leave 函数完全看**容器布局**：
  - **`column-count` masonry / CSS `grid` / `flex flex-wrap`** → `fadeOutLeave`：leaving 项 `position: fixed` 脱流，剩余项靠布局自然重排。范例：`Inspiration.vue` / `Notes.vue` / `Todos.vue` / `Resources.vue`（grid） / `Tags.vue`（flex-wrap）。
  - **垂直列表**（`space-y-*` / `flex flex-col`）→ `collapseLeave`：leaving 项 max-height 从当前高度渐变到 0 + opacity 0 + margin/padding 归零，**留在 flow 中"挤扁"**，外层容器高度跟着自然平滑减小。**用错 `fadeOutLeave` 会让外层容器瞬间塌缩**（leaving 项 position:fixed 一瞬间脱流，layout 立刻重计算）—— 典型症状："白底框收缩太快没动画"。范例：`Settings.vue` 的 AI 配置列表。
  - **回收站恢复** → `flyToNavLeave`：飞向 sidebar 上 type 对应的导航菜单项（内部已 lockToScreen，不论容器布局都能用）。
  - **staying 元素"对齐/补位"动画要在 v-for 子元素 class 上加 `transition-all duration-300`**（或 `transition-transform`），让 Vue FLIP 给 staying 元素设的 transform 变化能过渡。否则被删项淡出后剩余项瞬间补位（看着"砰一下"补上去）。`NoteCard` 因为本身有 `transition-all duration-200`（hover 阴影用）顺带让 FLIP 生效，其他列表组件必须主动加。
  - **`snapshotCards` 调用时机**：`fadeOutLeave` / `flyToNavLeave` 必须配合 `watch(() => list.length, () => snapshotCards(), { flush: 'sync' })`（在数据变更前 snapshot 位置，避免 onLeave 钩子拿到 v-if 切换后的错位坐标）；`collapseLeave` **不需要 snapshot**（不脱流，不锁位置）。
  - **批量操作要用乐观更新**：`恢复所有` / `清空回收站` / 批量删除 AI 配置等，必须先改 UI 触发动画再 await API（否则 Promise.all reject 会让 `notes.value = []` 不执行，动画不触发）。范例：`Trash.vue` 的 `doRestoreAll` / `Tags.vue` 的 `doDeleteTag` / `Settings.vue` 的 `deleteConfig`。
  - **容器要加 `data-animated-list` 属性**（grid / flex-wrap / 垂直列表的 TransitionGroup 容器都加），让 `snapshotCards()` 默认 selector 能匹配到。`.notes-masonry` 容器不用加（默认 selector 已包含）。
- **`prompts.ts` 模板字符串里别嵌反引号写示例**：在 `` `...` `` 模板字符串内再写 `` ` `` 会让 tsx 解析器把模板字符串提前闭合 → server 起不来 → 没有红色编辑器警告，只有运行时崩溃。**用 「」 或 '...' 包代码/字段示例**。范例：`prompts.ts` chat prompt 里 `「label」(refId:xxx)` 写法（不要再变成 `` `「label」(refId:xxx)` ``）。

## Electron 快捷窗口（Capture / AiChat）

### Win11 OS 窗口动画的触发条件
默认所有标准 `BrowserWindow` 在 Win11 上有 fade in/out + 微缩放的窗口动画（OS 级别免费送）。两种情况 OS 会**跳过整个生命周期的动画**（包括关闭）：
- 调用过 `setOpacity()`：OS 判定 opacity 由应用自管，不再做动画
- `backgroundColor: '#00000000'`（alpha=0）：OS 视为非常规窗口

**结论**：要 OS 自带动画就**不要调用 `setOpacity()`**，背景色用纯色（推荐跟主题走，见下文）。

### 快捷窗口主题闪烁的 4 层防御
打开快捷窗口时的"白闪 / 旧主题色闪"有 4 个独立来源，每层都要做防御：

1. **Electron 窗口 `backgroundColor`**（OS 显示窗口边缘的填充色，在 webContents paint 之前可见几帧）
   - `THEME_BG[currentTheme]` 映射（main.ts，跟 style.css 的 `--c-body` 一致）
   - `sync-theme` IPC 时调 `setBackgroundColor(...)` 更新已存在窗口（影响下次 paint）

2. **HTML body 背景**（CSS 加载之前浏览器用默认白色 paint）
   - `index.html` 第一个 inline script 同步设 `<html>` 的 inline `background`，不依赖 CSS 加载

3. **webContents GPU paint cache**（hidden 窗口 Chromium 不 repaint，切主题后 cache 仍是旧主题）
   - `sync-theme` IPC 时**销毁** captureWindow/aiChatWindow，下次按快捷键重建。新窗口直接用新主题色创建，无 cache 残留
   - 同主题下仍是持久窗口（hide/show），保留响应速度

4. **Vditor 等异步组件加载导致的布局跳变**（`after` callback 触发前 `.vditor-wrapper` 是空 div，下面工具栏贴顶部）
   - `RichEditor` 暴露 `@ready` 事件（Vditor `after` callback 内 emit）
   - Capture.vue 收到 ready → 调 `quink.notifyContentReady()` (preload) → IPC `'content-ready'`
   - 主进程 `ipcMain.once('content-ready', show)` 之前不 show 窗口（带 3 秒超时兜底）
   - 代价：首次按快捷键等 ~300ms（Vditor 加载），但出现时整个界面已完整布局
   - 另外给 `.vditor-wrapper` 设 `min-height: (minHeight + 36) + 'px'` 兜底占位（万一 ready 信号没发，至少占位不塌缩）

### 启动时机：不要在 `app.whenReady` 预创建快捷窗口
**坑**：`app.whenReady` 里立即 `createCaptureWindow()`（为了加快首次响应）→ 但那时主窗口还没 fetchMe，`currentTheme` 还是默认 `'blueberry'` → captureWindow 用错误主题色创建 → 首次按快捷键时背景闪 "blueberry 色"几帧。

**正解**：**懒加载**。`toggleCaptureWindow` 在 `captureWindow` 不存在时才创建。那时主窗口已经 sync-theme IPC 把 `currentTheme` 设到用户实际主题，新窗口直接用对的颜色。代价：首次按快捷键多等 ~300ms，跟切换主题后第一次打开体验一致。

### `currentTheme` 主进程缓存机制（3 个同步源）
- `let currentTheme = 'blueberry'` 默认值
- `loadUserShortcuts`：启动时从 server preferences 同步（异步，可能晚）
- `sync-theme` IPC：用户切主题时 web 端调 `quinkDesktop.syncTheme()` → 更新 `currentTheme` + `setBackgroundColor` + destroy 快捷窗口
- `ensureCurrentTheme()`：创建快捷窗口前从主窗口 localStorage **主动**读最新值（防 race，确保 backgroundColor 不会用过期值）

### 持久窗口 vs 销毁重建的混合策略
- **同主题下**：持久窗口 `hide()` / `show()` 切换，响应 < 10ms
- **切换主题时**：sync-theme IPC 触发 `destroy()` 销毁快捷窗口；下次按快捷键走完整 create → ensureCurrentTheme → 等 content-ready → show 路径 (~300ms)，用新主题完整渲染
- 平衡了**速度**（同主题下快）和**正确性**（切换后不闪）

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
