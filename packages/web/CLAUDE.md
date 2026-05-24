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

## Vditor 静态文件

静态文件从 `public/vditor/dist/`（从 node_modules 复制）提供。RichEditor.vue 的 CDN 配置指向 `/vditor`。`pnpm install` 后执行：

```bash
cp -r node_modules/vditor/dist packages/web/public/vditor/dist
```

## 移动端

- 通过 Tailwind `md:` 断点（768px）做响应式。
- 小屏：侧边栏改抽屉，搜索折叠成图标，`MobileInput`（textarea）替换 Vditor。
- `100dvh` + JS `--app-height` 处理 iOS Safari 视口。

## 文件 url helper（裸名约定）

DB `files.url` 字段 + 笔记 `content` 里 markdown link 的 url 都只存**裸文件名**（如 `xxx.png`），不带 `/api/uploads/` 前缀（后端约定，详见 `packages/server/CLAUDE.md`）。前端渲染层用 `src/utils/fileUrl.ts` 三个 helper 拼/剥前缀：

- **`resolveFileUrl(url)`** —— 直接拼路径，用于 `<img :src>` / `<a :href>` / `<audio :src>` 等元素属性
- **`resolveMarkdownFileUrls(md)`** —— markdown 字符串预处理（用于 `Vditor.md2html` 前）。把 `[xxx](裸名.ext)` 拼成 `[xxx](/api/uploads/裸名.ext)`。识别规则：括号内不含 URL 特殊字符（`/`/`?`/`#`/`:`）且含扩展名 `.ext` 才拼，不会误伤外链/引用链接 `(?ref=xxx)`/内部路由 `(/note/abc)`
- **`stripMarkdownFileUrls(md)`** —— 编辑器 `getValue` 后用，把 absolute path 剥回裸名

新增 markdown 渲染入口必须套这两个 helper，否则文件链接 404。当前渲染入口：`NoteCard.vue` / `NoteDetail.vue` / `Trash.vue` / `AI.vue` / `AiChat.vue` / `App.vue`（引用预览）/ `RichEditor.vue`。

### RichEditor 双向转换

Vditor IR 模式编辑器内部直接读 markdown href 给 `<img src>` / `<a href>`，不走 helper —— 如果裸名直接渲染浏览器会拼当前页 URL → 404 → 图片预览全裂图。**修法**：编辑器内 markdown 用 absolute path，保存出去剥前缀回裸名。RichEditor.vue 5 处包装：

| 位置 | 包装 |
|---|---|
| `value: props.initialContent` | `resolveMarkdownFileUrls(...)` 拼前缀进编辑器 |
| `handleSubmit` getValue | `stripMarkdownFileUrls(...)` 剥前缀出 DB |
| `setValue(aiResult)` | 拼前缀（AI 输出可能含文件链接） |
| Vditor `succMap` | `resolveFileUrl(res.data.url)` 给 Vditor absolute url |
| `insertValue` 两处（文件链接 / 语音备忘） | `resolveFileUrl(res.data.url)` 拼前缀 |
