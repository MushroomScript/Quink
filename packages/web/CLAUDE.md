# packages/web CLAUDE.md

Quink 前端专属指引（Vue 3 + Vite + TailwindCSS + Vditor + ECharts）。

## CSS zoom 显示比例（网页端独有坑，加 fixed/absolute popover 必读）

Quink 的"显示比例"功能两条实现路径：

- **Electron 端**走 `webContents.setZoomFactor()` (Chromium 内置 page zoom, 跟用户按 Ctrl+滚轮一模一样)。全栈坐标系自动一致 —— rect / innerWidth / inline style px / 鼠标事件 / hit-test 都用同一 zoom 因子, 开发者完全感知不到 zoom 存在, 当 zoom=1 写代码即可。
- **网页/PWA 端**走 CSS `zoom: 1.x` 在 `<html>` 上 (`App.vue applyZoomLevel`). CSS zoom 是非标准属性, chrome 内部实现满是坑:
  - `getBoundingClientRect()` 返回 zoomed 坐标 (screen px)
  - `window.innerWidth/innerHeight` 返回 zoomed
  - **但 `inline style.top/left/right/bottom = 'Xpx'` 设到 fixed element 时, 渲染会被 zoom 再乘一次** ← 这是最大的坑
  - 鼠标 event clientX/Y 是 zoomed
  - `clientWidth/scrollLeft` 单位看 element 自己有没 zoom (body 上没 zoom 就是 unzoomed)

如果在 JS 里**用 rect 算位置 + 设 inline style px**（典型 popover/menu/tooltip 的 `Teleport to="body" + fixed + JS positioning` 模式）, 网页端 zoom=1.5 时 popover 会飞出视口 1.5x. Electron 端没事但是网页端必坏。

**必须用 `utils/zoom.ts` 的 helper**:

```ts
import { unzoomRect, unzoomViewport } from '@/utils/zoom';

function showMyPopover() {
  const r = unzoomRect(triggerEl.value);       // 把 zoomed rect 除以 zoom → unzoomed CSS px
  const { vw, vh } = unzoomViewport();         // 把 zoomed innerWidth/Height 除以 zoom
  popoverPos.value = {
    top: `${r.bottom + 4}px`,
    left: `${r.left}px`,
    right: `${vw - r.right}px`,
  };
}
```

helper 内部 Electron 端 zoom 返回 1, 行为不变 (跟直接用 r.bottom 一样). 网页端 zoom 因子非 1 时除掉. 设的 inline px 是 unzoomed CSS px, 浏览器渲染时 *zoom 自然回到目标视觉位置。

**已修的 11 处** (按 helper 重写过):
- `NoteCard.vue` toggleMenu (三点菜单)
- `NoteDetail.vue` toggleMenu (三点菜单)
- `VisibilityChip.vue` recalcPosition (编辑器底栏可见性 chip popover)
- `AudioPlayer.vue` 音量 popover
- `TopBar.vue` 5 处 (batchMove / batchType / batchTags / dateFilter / tagSuggest)
- `DatePicker.vue` positionPopup (日期/时间选择器)
- `Stats.vue` cell tooltip (热力图悬浮)
- `GlobalToast.vue` measureOffset (toast 顶部对齐)
- `RichEditor.vue` 工具栏 tooltip
- `useMasonry.ts` 列数自适应 fallback path

**仍可能踩坑的地方**（未来加 popover 前先检查）:
- 加新 popover/menu/tooltip 用 `<Teleport to="body">` + `position: fixed` + JS 算 top/left/right/bottom: **必须用 helper**
- 加新 dropdown trigger + inline positioning: **必须用 helper**
- 浮动菜单 / context menu / floating window: **必须用 helper**

**不需要 helper 的场景**:
- 算相对比例 (`(e.clientX - rect.left) / rect.width` 这类) — 单位相消, OK
- 用 CSS `position: absolute` + Tailwind class 定位 (`top-full left-0`) — 不走 JS, OK
- 用 `<Transition name="modal">` 全屏覆盖 (`fixed inset-0`) — 不算位置, OK

如果未来 CSS zoom 替换成 `transform: scale()` 实现"显示比例" (long-term plan), helper 可以一行改成 `getCssZoom() → 1` 全部回退. 当前架构兼容这条退路。

**密码框光标偏移 corner case**: 跟 zoom 无关但同源 ("`mirror` 里字符宽度跟 input 视觉宽度不一致"). `useCustomCaret.ts` 已用 `-webkit-text-security: disc` + `CSS.supports` fallback `'•'.repeat(n)` 跨浏览器修. 详见该文件注释.

## 主题系统

`src/style.css` 中的 CSS 变量定义了 7 套主题（blueberry、lavender、mint、peach、lemon、cloud、dark）。通过 `<html>` 上的 `data-theme` 属性切换。Tailwind 颜色引用这些变量：

- `primary` / `primary-light` / `primary-dark` → `--c-accent*`
- `sidebar` / `sidebar-light` → `--c-sidebar*`
- 侧边栏文字色 → `--sb-text`、`--sb-dim`、`--sb-hover` 等
- 暗色主题需为每个使用硬编码颜色的地方加 `[data-theme="dark"]` 覆盖

## 笔记类型（type 字段）→ view 映射

schema 定义 4 个值：`note / todo / snippet / link`（看 `packages/server/src/db/schema.ts`）。前端 sidebar 主导航只有 3 个对应 view，**type 到 view 的映射不直观**：

| 路由 | view | filterType |
|---|---|---|
| `/` 灵感 | `Inspiration.vue` | `note` |
| `/notes` 笔记 | `Notes.vue` | **`snippet`**（不是 `note`） |
| `/todos` 待办 | `Todos.vue` | `todo` |
| 无 | （`type='link'` 没有专属 view 入口） | `link` |

`type='link'` 是设计 quirk —— 创建后只能通过搜索或 AI 工具调用查到。未来补 `/links` 路由 + filterType='link' 才能用。

这个映射也写在 `src/utils/cardLeave.ts` 的 `TYPE_TO_NAV_PATH`（控制回收站恢复时卡片飞向哪个 sidebar 菜单项）。改 type 枚举或加 view 时记得两边都改。

### 编辑器 type 策略

3 个主 view 的编辑器（`NoteInput` / `MobileInput`）**不显示类型选择器**，type 强制走 view 对应的 `default-type` prop（Inspiration→note / Notes→snippet / Todos→todo）。这是 D1 错配 bug 的根除方案：之前用户在 /notes 编辑器选"灵感"保存 → 卡片 type=note 但列表过滤 type=snippet → 卡片不出现在保存当下的列表里，体验错乱。

**跨类型快速记录**走 Capture 快捷弹窗，Capture 直接用 RichEditor 保留类型选择器（默认 `showTypeSelector=true`）。如果未来想给主 view 编辑器加回类型 selector，请先想清楚 D1 错配会回来。

## 3 主 view 数据独立（view-local viewState）

`stores/notes.ts` 内部按 ViewKey (`inspiration / notes / todos`) 拆 3 套独立的 `ViewState { notes, total, currentPage, scrollTop, lastExtra }`，全部存在 `_viewState` reactive map 里。`activeView` ref 标记当前激活 view (其他路由如 Trash/Resources 等 activeView=`''`，store action 走 no-op)。

**view 端用 `store.getViewState(myKey)` 拿专属 vs，不要通过 `store.notes` 共享 computed**。理由: store.notes 是 computed 反映 activeView，切 view 时 inner array 引用变化会让所有 KeepAlive 缓存的 view 内的 `useMasonry watch(() => store.notes)` 被误触发 → columns 错位 rebuild → 切回时看到错位数据。走 vs.notes 引用稳定，只有本 view 数据变化时触发。

**外部组件 (Sidebar / NoteDetail / TopBar) 可以继续用 `store.notes`**（反映 activeView 的 notes，符合"当前看到的那批"语义）。

### 加新 view 类型时的必做清单 (以未来加 `/links` 为例)

1. `stores/notes.ts` 加 ViewKey: `'inspiration' | 'notes' | 'todos' | 'links'`
2. `_viewState` 初始化加 `links: createInitState()`
3. `typeToView` 映射加 `link: 'links'` (让 `createNote` 跨 view 同步生效)
4. view 文件 onActivated 设 `store.activeView = 'links'` + `store.currentRefresh = viewRefresh`
5. view 用 `const vs = store.getViewState('links')`,模板里 `store.notes/total` 改 `vs.notes/total`
6. onActivated nextTick 恢复 `main.scrollTop = vs.scrollTop`,onDeactivated 记 `vs.scrollTop = main.scrollTop`
7. `viewRefresh = () => store.fetchNotes(undefined, { keepCount: true })`,onDeactivated 引用相等检查清 currentRefresh (防多 view 切换 race)
8. 模板 editor-area-wrap 用 **v-show** 不要 v-if (NoteInput 内 Vditor 异步初始化, v-if 重 mount 会让 wrapper 高度为 0 → main scrollHeight 缩水 → scrollTop 被浏览器归零, 退多选/退筛选时编辑区不出现 bug 同根因)
9. onActivated 加 `else if (vs.dirty) { viewRefresh() }` 分支 (跨 view 改 type 进来的新条目走这里同步, 详见下面"跨 view 同步")

跨 view 同步: `updateNote / deleteNote / pollNoteAiResult / refreshSingleNote` 遍历所有 viewState 同步本地副本 (灵感页删一张笔记,笔记页本地也同步移除)。`createNote` 按 `res.data.type` 决定写到哪个 viewState (不绑 activeView,这样 Capture 跨类型创建后切到目标 view 立刻看到)。

**后台 view 任何 vs.notes mutation 都必须避开 (deleteNote / pollNoteAiResult / refreshSingleNote 全走对称化)**: 这些遍历 viewState 同步的函数全部按 "k === activeView" 分支处理:

| 函数 | 前台 view | 后台 view |
|---|---|---|
| `updateNote` | Object.assign + 可能 splice / sortBy 重排 | 跨 view 搬走 → 标 dirty; 否则 Object.assign |
| `deleteNote` | splice 移除 + total-- | 标 dirty (不 splice) |
| `pollNoteAiResult` / `refreshSingleNote` (共用 `syncFreshToViewStates`) | Object.assign 更新字段 | 标 dirty |

**根因相同**: 后台 view 的 vs.notes 任何 mutation (Object.assign 改字段 / splice 删元素) 都让 view 内 filter-based computed (Todos 的 `pendingTodos = vs.notes.filter(type==='todo')`) 重算返回新数组 → useMasonry watch `newItems !== oldItems` → rebuild → KeepAlive 后台 DOM detached → `measureCardHeights` 通过 `rootRef.querySelectorAll('[data-note-id]')` 拿空 → 全 estimateHeight 偏低 → `pickShortestCol` 塞同一列 (实测 12 张 pending 分布变 1/11/0)。**前台 view 安全**因 DOM attached，rebuild 用真实高度 pickShortest 正常分列。**Inspiration / Notes 直接传 `() => vs.notes`** (同数组引用) 不走 filter computed → 后台 deep mutation 时 `newItems === oldItems` 不 rebuild → 这俩 view 后台理论上 mutate 也安全，但为了一致性 + 防御未来 view 也加 filter computed, 所有"跨 view 同步"函数统一走 dirty 策略。

**新增'遍历所有 viewState 改字段'的函数必须走对称化**: 优先复用 `syncFreshToViewStates(id, fresh)`，或自己实现"前台 mutate / 后台 dirty"分支。**不要再写裸的 `for k in viewState; mutate`**。

**底层兜底: useMasonry detached-aware**: 即使 store 函数偶尔后台 mutate vs.notes 漏防御 (e.g. 新加遍历 viewState 的函数忘了对称化), useMasonry `rebuild()` 自身检测 `root.isConnected`, detached 时标 deferred return 不动 columns; view 端 `onActivated` 调 `flushDeferredRebuild()` 补做 rebuild (此时 DOM 已 attach 真实高度可用). 双层防御保证 detached DOM 上不会算出"塞同列"的坏分配. 详见 `packages/web/src/composables/CLAUDE.md` 坑 8.

**跨 view 改 type 4 case 对称化 (源 / 目标 × 当前 / 后台)**: `updateNote` 按 `activeView` 跟 `targetViewKey` 关系走不同路径:

| 角色 | 是当前 view | 是后台 view |
|---|---|---|
| **源 view** (持有原副本) | Object.assign + 可能 splice 过滤 / sortBy 重排 | **不动数据 + 标 dirty** (跨 view 搬走时) / Object.assign (字段改但仍归属此 view 时) |
| **目标 view** (按新 type 归属) | **reassign 直接插入"置顶之后第一位"** (仿 createNote) | 标 dirty |

**为啥后台 view 不能 Object.assign**: deep mutation 让 view 内 filter-based computed (如 `Todos.vue` 的 `pendingTodos = vs.notes.filter(type==='todo')`) 重算返回新数组 → useMasonry watch `newItems !== oldItems` → rebuild → KeepAlive 后台 DOM detached → `measureCardHeights` 通过 `rootRef.querySelectorAll('[data-note-id]')` 拿空 (detached element 的 querySelectorAll 返回空) → 全 estimateHeight 偏低 → `pickShortestCol` 塞同一列 (实测 12 张 pending 分布变 1/11/0). Inspiration / Notes 直接传 `() => vs.notes` (同数组引用) 不走 computed → 后台 deep mutation 时 `newItems === oldItems` 不 rebuild 安全, 只 Todos filter computed 在 hover navigate 把源 view 切到后台时触发。

**为啥目标 view 当前 view 时直接插入**: hover navigate (拖卡片到 sidebar 灵感/笔记/待办停留 400ms) 让目标 view 切到前台再落地, DOM attached 时 reassign 走 useMasonry rebuild 用真实高度 pickShortest 正常分列, 用户立刻看到新条目。跟旧版"目标 view 一律标 dirty"区别: 旧版假设目标 view 永远后台 (传统拖法 / 编辑器改 type), hover navigate 破坏假设。

**dirty 标记下次消费**: 后台 view 下次 `onActivated` 时 `else if (vs.dirty) { viewRefresh() }` → fetchNotes keepCount 拉权威数据, 此时 DOM 已 attach 真实高度可用, rebuild 正常。`fetchNotes` reset / keepCount 都清 `vs.dirty = false` 标记。

`fetchNotes` keepCount 模式两条路径: **无新增 id** → mutate (`Object.assign` 更新字段 + `splice` 删消失的), useMasonry 走 splice 优化卡片零移动 (顶部刷新按钮最常见路径); **有新增 id** → reassign `vs.notes = res.data` 按 server 顺序 (pinned DESC, createdAt DESC) 重排, useMasonry 走 rebuild 用真实高度 pickShortest, 代价是部分卡跨列移动 (实测 diff=89), trade-off: 比"新条目 push 到末尾脱离时间顺序"对用户更对。keepCount limit 加 `+20` buffer 避免 server 新增条目挤掉本地条目导致误删。

## 卡片拖放（pointer events，非 HTML5 DnD）

NoteCard 拖到 sidebar / AI 走自定义 `utils/cardDnd.ts`，不用 HTML5 DnD（Chromium DnD 期间拦截 wheel 拿不到滚轮）。dropzone 协议 + 触发 + 视觉 + AI 拖入兜底 + 胶囊 audio anchor 例外详见 **`CARDDND.md`**。改 `cardDnd.ts` / `DragGhost.vue` / `NoteCard.vue` 拖动 / `Sidebar.vue` drop target / `AI.vue` 拖入兜底前先读那里。

## 跨视图筛选跳转

view A 触发跳转 → view B 落地并自动应用筛选 chip 的模式。当前 2 条线（Stats 热力图 → 灵感页按日期；Inspiration tag → 灵感页按标签），都走同一套：触发方 `router.push({ query })` → 目标 view `onActivated` 派事件 → TopBar `onMounted` 监听 + 统一拉数据。**onActivated 不能自己 fetchNotes**（否则双拉双闪烁），**TopBar 必须比 RouterView 先 mount**（否则跨视图跳转静默失效）。详见 **`CROSS-VIEW-NAV.md`**。加新跳转线 / 改 App.vue 顶层布局前先读那里。

## Vditor 静态文件

静态文件从 `public/vditor/dist/`（从 node_modules 复制）提供。RichEditor.vue 的 CDN 配置指向 `/vditor`。`pnpm install` 后执行：

```bash
cp -r node_modules/vditor/dist packages/web/public/vditor/dist
```

## 创建笔记 + AI 异步回填

后端 `POST /api/notes` 立即返回（`aiProcessed=false`），同时后台异步跑 `processNoteWithAi`（自动标签 / 分类 / 摘要），完成后 SQL UPDATE 设 `aiProcessed=true`。AI 耗时取决于配置：云端 API 1-3s，本地 Ollama 3-30s。

**前端创建流程**（NoteInput / MobileInput / Capture 都走这条）：

1. `store.createNote(...)` —— POST 创建后**插入到 `notes.value` 中"所有置顶之后第一位"**（用 `findIndex(!pinned)`），reassign 整个数组让 useMasonry 走 rebuild。**不能 unshift 到 [0]**，否则新非置顶卡片会比置顶卡片还前，后续 AI 回填 / 任何 fetchNotes 重排都会跳到正确位置造成视觉跳变
2. `store.pollNoteAiResult(id)` —— 立即开始轮询单条 GET `/api/notes/:id`，退避 2/3/5/8/12s 累积 30s。命中 `aiProcessed=true` 时 `Object.assign(notes.value[idx], fresh)` mutate 字段（保引用），NoteCard props deep watch 自动重渲染 tags/category/summary。**不触发 useMasonry rebuild**，无重排闪烁

**不要** 用固定 `setTimeout(() => store.fetchNotes(), 4000)`：
- 时长 race（云模型够 4s，本地 Ollama 不够 → AI 标签永远拿不到）
- fetchNotes 全量拉取 + reassign 触发 useMasonry rebuild（30+ 卡片场景明显）

**Electron 多窗口路径**（Capture 快捷窗口 / capture.html 通过 `save-note` IPC）：通过 `quink-note-created` 事件让主窗口同步，事件 detail 必须带 `id`，主窗口 listener 收到 id 走 pollNoteAiResult，没 id 才回退 fetchNotes。具体 IPC 见 `packages/desktop/CLAUDE.md` 的 `note-saved` / `save-note` 通道。

## 移动端

- 通过 Tailwind `md:` 断点（768px）做响应式。
- 小屏：侧边栏改抽屉，搜索折叠成图标，`MobileInput`（textarea）替换 Vditor。
- `100dvh` + JS `--app-height` 处理 iOS Safari 视口。

## 长连接走 backendBaseUrl helper（绕 vite proxy）

`/api/sse` / AI Chat 流式 fetch / 未来要加的 WebSocket 等**长连接**, 必须通过 `utils/backendUrl.ts` 的 `backendBaseUrl()` helper 拼 URL, **不走 vite proxy**.

根因: vite 的 http-proxy 转发 SSE / 流式 fetch 时, 在重连 / 上游异常场景会泄漏 socket. 浏览器对 :24888 的 HTTP/1.1 池 (默认 6 个并发) 被 active 状态的"僵尸 socket"占满 → 新 fetch "Initial connection: Stalled" 排队几分钟后被 cancel. 用户感受到的就是"整页 API 全 pending 后被取消", Chromium `chrome://net-internals/#sockets` 的 `Flush Socket Pools` 只清 idle socket 救不回, **必须关掉所有同 origin 标签**让网络栈清空 (无痕 tab 都得关).

helper 行为:
- **dev**: 根据 `window.location.hostname` 推断 backend URL (`http://{hostname}:38999`). 同时兼容 PC localhost 跟手机连 PC 局域网 IP (vite host:true 模式). 前置: PC 防火墙放行 38999 入站
- **prod**: 返回空字符串, 调用方拼出来还是 `/api/xxx` 相对路径走同 origin (nginx 反代 / Docker 一体化容器 / K8s ingress 等). 同 origin 没 vite proxy 那种 bug

加新长连接 endpoint 时套这个 helper, 不要写死 `/api/xxx`. 普通短 fetch (GET 一次性响应) 不需要套, 仍走 vite proxy 没问题. 跨 origin fetch 触发 OPTIONS preflight 但 hono cors() 默认放行常用 header, 长流场景多 ~50ms 可忽略.

接入位置: `utils/sse.ts` (reminder SSE) / `views/AI.vue` (AI chat 流式) / `views/AiChat.vue` (快捷窗口 AI chat).

## 文件 url helper（裸名约定）

DB `files.url` 字段 + 笔记 `content` 里 markdown link 的 url 都只存**裸文件名**（如 `xxx.png`），不带 `/api/uploads/` 前缀（后端约定，详见 `packages/server/CLAUDE.md`）。前端渲染层用 `src/utils/fileUrl.ts` 的 helper 拼/剥前缀：

- **`resolveFileUrl(url)`** —— 直接拼路径，用于 `<img :src>` / `<a :href>` / `<audio :src>` 等元素属性
- **`resolveMarkdownFileUrls(md)`** —— markdown 字符串预处理（用于 `Vditor.md2html` 前）。把 `[xxx](裸名.ext)` 拼成 `[xxx](/api/uploads/裸名.ext)`。识别规则：括号内不含 URL 特殊字符（`/`/`?`/`#`/`:`）且含扩展名 `.ext` 才拼，不会误伤外链/引用链接 `(?ref=xxx)`/内部路由 `(/note/abc)`
- **`stripMarkdownFileUrls(md)`** —— 编辑器 `getValue` 后用，把 absolute path 剥回裸名
- **`resolveFileThumbUrl(url)` + `thumbErrorFallback(e, originalUrl)`** —— 静态图片缩略图 URL + `<img @error>` 一次性降级原图。详见根 **`THUMBNAILS.md`**

新增 markdown 渲染入口必须套前 3 个 helper，否则文件链接 404。当前渲染入口：`NoteCard.vue` / `NoteDetail.vue` / `Trash.vue` / `AI.vue` / `AiChat.vue` / `App.vue`（引用预览）/ `RichEditor.vue`。

新增静态图片显示场景（头像 / 缩略图 / 卡片小图预览）必须用后 2 个 helper + `<img>`（**不要用 background-image**），详见根 **`THUMBNAILS.md`**。

### 文件不存在的兜底（用户从 Resources 删了原文件后）

3 类资源各有兜底，**全部集中在 App.vue 全局 listener / utils/audio.ts**，加新 markdown 渲染入口**不需要**再套额外 helper：

| 资源 | 失败提示 | 实现位置 |
|---|---|---|
| 图片 `<img>` | 红色 `⚠ 文件不存在：alt` 占位 span（视觉常驻） | App.vue capture-phase `error` listener 拦截 `<img src="/api/uploads/*">` 加载失败 → `replaceWith` span |
| 音频胶囊 `<audio>` | toast `录音文件不存在` | utils/audio.ts 的 `audio.error` handler |
| 普通文件 `<a>` | toast `文件不存在: xxx`（**不进传输 dock**） | App.vue click handler 先 HEAD 预检，404 直接 toast return；只有 HEAD 通过才走 `addAttachmentTask` + `desk.openAttachment` |

**关键点**：

- `error` 事件**不冒泡**（只在 target 触发），全局拦截必须 `capture: true` 才收得到
- inline `onerror="..."` 字符串注入在严格 CSP（`script-src 'self'`）下被拦，全局 listener 是 CSP 友好替代
- `<a>` 元素没有 `onerror`（HTML 标准只对加载资源的元素生效），普通文件兜底必须主动 HEAD 检查
- 桌面端的 `desk.openAttachment` IPC 即使 404 也会让 main 端 `markFailedByUrl` 把这条标 failed → 为避免 dock 里出现失败垃圾记录，renderer 端必须**先 HEAD 拦截**才决定是否走 dock 流程
- App.vue 的 missing img listener 跟 `prevImgClickHandler` 同套 HMR 缓存模式（`prevMissingImgErrHandler` 模块级 let + onMounted 时清旧的）

### RichEditor 双向转换

Vditor IR 模式编辑器内部直接读 markdown href 给 `<img src>` / `<a href>`，不走 helper —— 如果裸名直接渲染浏览器会拼当前页 URL → 404 → 图片预览全裂图。**修法**：编辑器内 markdown 用 absolute path，保存出去剥前缀回裸名。RichEditor.vue 5 处包装：

| 位置 | 包装 |
|---|---|
| `value: props.initialContent` | `resolveMarkdownFileUrls(...)` 拼前缀进编辑器 |
| `handleSubmit` getValue | `stripMarkdownFileUrls(...)` 剥前缀出 DB |
| `setValue(aiResult)` | 拼前缀（AI 输出可能含文件链接） |
| Vditor `succMap` | `resolveFileUrl(res.data.url)` 给 Vditor absolute url |
| `insertValue` 两处（文件链接 / 语音备忘） | `resolveFileUrl(res.data.url)` 拼前缀 |
