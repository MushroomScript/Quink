# packages/web CLAUDE.md

Quink 前端专属指引（Vue 3 + Vite + TailwindCSS + Vditor + ECharts）。

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

## 卡片拖放（pointer events，非 HTML5 DnD）

NoteCard 拖到 sidebar（改 type / 改 category / 删除 / 加进 AI）走自定义 `utils/cardDnd.ts`，**不用 HTML5 DnD**。

**为什么不用 HTML5 DnD**：Chromium 在 DnD 期间彻底拦截 wheel 事件（即使 capture phase + preventDefault 也拿不到），导致拖动卡片到 sidebar 时**无法用滚轮滚到更多目标**。换 pointer events 之后 wheel 正常派发。

**dropzone 协议**：drop 目标 DOM 元素加 `data-drop-target="xxx"`，值约定：

| 值 | 含义 |
|---|---|
| `type:note` / `type:snippet` / `type:todo` | 改卡片 type |
| `cat:<分类名>` | 改 category |
| `action:trash` | 软删除（cardDnd 派 `quink-drop-trash` 事件让 Sidebar 弹确认 modal） |
| `action:ai` | 拖到 sidebar AI 项 — 直接松手 = 跳 /ai 新对话；停留 400ms 自动 navigate /ai（拖动不释放，鼠标继续拖到 conv） |
| `conv:<convId>` | /ai 页面内拖到指定对话 |
| `ai-page` | /ai 页面兜底（chat area / 输入框区域） |

**触发**：NoteCard `@pointerdown` 调 `startCardDrag(e, { ids, type, category, text })`。selectMode + 当前卡片在选中集 + size≥2 → ids 是整批；否则单条。type chip 在非 selectMode 充当 drag handle（让正文 select-text 不被 DnD 抢）。

**视觉**：`dragState.hoverTarget` 给 dropzone 加 `drop-target-active` class；`<DragGhost />`（App.vue 全局挂载）fixed 跟随鼠标。

**same-type / same-cat 跳过**：单条且 from === to 时 hoverTarget=null（视觉/语义都拒绝）；多条混合 type 时 fromType=null 始终接受。

**AI 拖入兜底**：cardDnd 同时派 window 事件 + sessionStorage 中转（`quink_ai_pending_drop`）。AI mount 前丢失的事件由 onMounted/onActivated 读 sessionStorage 兜底；listener 收到也 removeItem 避免 onActivated 切回重复消费（已踩坑）。

**胶囊 audio anchor 例外**：NoteCard `onPointerDown` 内检查 e.target 是不是 audio anchor，是 → return 让 `audio.ts` 的 pointer 监听接管 seek 拖动。

实现文件：`utils/cardDnd.ts` / `components/DragGhost.vue` / `NoteCard.vue` / `Sidebar.vue` / `AI.vue`。

## 跨视图筛选跳转

view A 触发跳转 → view B 落地并自动应用筛选 chip 的模式。当前 2 条线（Stats 热力图 → 灵感页按日期；Inspiration tag → 灵感页按标签），都走同一套：

1. **触发方**：`router.push({ path: 目标 view, query: { 筛选键: 值 } })`
2. **目标 view 的 `onActivated`**：读 `route.query.筛选键`，命中则**只设 `store.filterType = ''` + 派事件**（`dispatchEvent('quink-filter-XXX', { detail: 值 })`），**不要自己 `fetchNotes`**
3. **TopBar `onMounted`** 监听 `quink-filter-XXX`：设对应筛选状态（chip / 日期 / types 全选）+ `showFilters = true` + `doSearch(true)` 统一拉数据

**关键约定**：onActivated 不主动 fetchNotes，让 TopBar 统一负责。否则会"onActivated 拉一次 + TopBar doSearch 又拉一次"= 后端 2 倍请求 + UI 数据填充 2 次闪烁 + TransitionGroup 动画打断。

**注意顺序**：TopBar 的 `watch(route.path)` 会先清空旧筛选，目标 view 的 `onActivated` 必须**在路由切完后**派事件才能盖回。当前两条线都走 onActivated 这条路径，顺序天然对。

**mount 顺序依赖（⚠️ 改 App.vue 布局时注意）**：派事件模式要求 TopBar 比 RouterView 先 mount，否则 onMounted 注册监听器之前事件就派完了，监听器收不到 → 跨视图跳转**静默失效**（无报错，但 chip 不显示、数据不刷新，看到的是旧内容）。当前 `App.vue` 里 `<TopBar />` 写在 `<RouterView />` 前（line ~437/439），顺序天然对。如果挪布局把 TopBar 挪到 RouterView 后面，D2 / tag query 都会裂。

涉及文件：`Stats.vue`（cell click）/ `Inspiration.vue`（query 分支）/ `TopBar.vue`（事件监听）。加新跳转线时三处都要补。

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

## 文件 url helper（裸名约定）

DB `files.url` 字段 + 笔记 `content` 里 markdown link 的 url 都只存**裸文件名**（如 `xxx.png`），不带 `/api/uploads/` 前缀（后端约定，详见 `packages/server/CLAUDE.md`）。前端渲染层用 `src/utils/fileUrl.ts` 五个 helper 拼/剥前缀 + 缩略图：

- **`resolveFileUrl(url)`** —— 直接拼路径，用于 `<img :src>` / `<a :href>` / `<audio :src>` 等元素属性
- **`resolveMarkdownFileUrls(md)`** —— markdown 字符串预处理（用于 `Vditor.md2html` 前）。把 `[xxx](裸名.ext)` 拼成 `[xxx](/api/uploads/裸名.ext)`。识别规则：括号内不含 URL 特殊字符（`/`/`?`/`#`/`:`）且含扩展名 `.ext` 才拼，不会误伤外链/引用链接 `(?ref=xxx)`/内部路由 `(/note/abc)`
- **`stripMarkdownFileUrls(md)`** —— 编辑器 `getValue` 后用，把 absolute path 剥回裸名
- **`resolveFileThumbUrl(url)`** —— 拼缩略图路径 `/api/uploads/<裸名>.thumb.jpg`（后端 sharp 上传时生成，详见 `packages/server/CLAUDE.md`）
- **`thumbErrorFallback(e, originalUrl)`** —— `<img @error>` 一次性降级原图（dataset 标记防原图也 404 时无限循环）

新增 markdown 渲染入口必须套前 3 个 helper，否则文件链接 404。当前渲染入口：`NoteCard.vue` / `NoteDetail.vue` / `Trash.vue` / `AI.vue` / `AiChat.vue` / `App.vue`（引用预览）/ `RichEditor.vue`。

### 静态图片显示约定（头像 / 资源缩略图 / 笔记小图）

**显示 < 200px 的图片必须走 thumb URL + onError 降级**，否则浏览器对 4MB+ 原图一步 downsample 到 36/80/128 px 会显出明显锐化感（CSS `zoom != 100%` 时更严重）。模板范例：

```vue
<img :src="resolveFileThumbUrl(url)"
  @error="thumbErrorFallback($event, resolveFileUrl(url))"
  class="..." />
```

**别用 `background-image: url(...)`**：Chromium 对 background-image 的 downsample 路径质量比 `<img>` 差一档。头像如果非要圆形用 `<img class="rounded-full object-cover">`。

历史已上传图片没 thumb 文件 → 浏览器 404 → `thumbErrorFallback` 切回原图，**不裂图但也无改善**。蘑菇要全量 backfill 可以加 `backfillImageThumbs` server 启动时扫一遍，类似已有 `backfillHeicThumbs`。

当前调用点：`Settings.vue`（头像）/ `Sidebar.vue`（头像）/ `Resources.vue`（grid + list 缩略图）。新增图片显示位置（卡片小图预览、笔记 metadata 缩略图等）也按这套来。

### RichEditor 双向转换

Vditor IR 模式编辑器内部直接读 markdown href 给 `<img src>` / `<a href>`，不走 helper —— 如果裸名直接渲染浏览器会拼当前页 URL → 404 → 图片预览全裂图。**修法**：编辑器内 markdown 用 absolute path，保存出去剥前缀回裸名。RichEditor.vue 5 处包装：

| 位置 | 包装 |
|---|---|
| `value: props.initialContent` | `resolveMarkdownFileUrls(...)` 拼前缀进编辑器 |
| `handleSubmit` getValue | `stripMarkdownFileUrls(...)` 剥前缀出 DB |
| `setValue(aiResult)` | 拼前缀（AI 输出可能含文件链接） |
| Vditor `succMap` | `resolveFileUrl(res.data.url)` 给 Vditor absolute url |
| `insertValue` 两处（文件链接 / 语音备忘） | `resolveFileUrl(res.data.url)` 拼前缀 |
