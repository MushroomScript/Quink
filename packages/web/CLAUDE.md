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

## 文件 url helper（裸名约定）

DB `files.url` 字段 + 笔记 `content` 里 markdown link 的 url 都只存**裸文件名**（如 `xxx.png`），不带 `/api/uploads/` 前缀（后端约定，详见 `packages/server/CLAUDE.md`）。前端渲染层用 `src/utils/fileUrl.ts` 的 helper 拼/剥前缀：

- **`resolveFileUrl(url)`** —— 直接拼路径，用于 `<img :src>` / `<a :href>` / `<audio :src>` 等元素属性
- **`resolveMarkdownFileUrls(md)`** —— markdown 字符串预处理（用于 `Vditor.md2html` 前）。把 `[xxx](裸名.ext)` 拼成 `[xxx](/api/uploads/裸名.ext)`。识别规则：括号内不含 URL 特殊字符（`/`/`?`/`#`/`:`）且含扩展名 `.ext` 才拼，不会误伤外链/引用链接 `(?ref=xxx)`/内部路由 `(/note/abc)`
- **`stripMarkdownFileUrls(md)`** —— 编辑器 `getValue` 后用，把 absolute path 剥回裸名
- **`resolveFileThumbUrl(url)` + `thumbErrorFallback(e, originalUrl)`** —— 静态图片缩略图 URL + `<img @error>` 一次性降级原图。详见根 **`THUMBNAILS.md`**

新增 markdown 渲染入口必须套前 3 个 helper，否则文件链接 404。当前渲染入口：`NoteCard.vue` / `NoteDetail.vue` / `Trash.vue` / `AI.vue` / `AiChat.vue` / `App.vue`（引用预览）/ `RichEditor.vue`。

新增静态图片显示场景（头像 / 缩略图 / 卡片小图预览）必须用后 2 个 helper + `<img>`（**不要用 background-image**），详见根 **`THUMBNAILS.md`**。

### RichEditor 双向转换

Vditor IR 模式编辑器内部直接读 markdown href 给 `<img src>` / `<a href>`，不走 helper —— 如果裸名直接渲染浏览器会拼当前页 URL → 404 → 图片预览全裂图。**修法**：编辑器内 markdown 用 absolute path，保存出去剥前缀回裸名。RichEditor.vue 5 处包装：

| 位置 | 包装 |
|---|---|
| `value: props.initialContent` | `resolveMarkdownFileUrls(...)` 拼前缀进编辑器 |
| `handleSubmit` getValue | `stripMarkdownFileUrls(...)` 剥前缀出 DB |
| `setValue(aiResult)` | 拼前缀（AI 输出可能含文件链接） |
| Vditor `succMap` | `resolveFileUrl(res.data.url)` 给 Vditor absolute url |
| `insertValue` 两处（文件链接 / 语音备忘） | `resolveFileUrl(res.data.url)` 拼前缀 |
