# 图标系统

Quink 全软件图标约定。**改图标相关代码（新增图标、调整 size/weight/nudge）前先读本文件**。本文件不被 Claude Code 自动加载，根 `CLAUDE.md` 留指针；需要时主动来读。

## 图标库

**统一用 `@phosphor-icons/vue`**，禁止再用 emoji 当图标、禁止手写 inline SVG。极少数 v-html 字符串里嵌入图标的场景用 inline phosphor SVG path（见 `utils/refLink.ts`）。

## `PhXCircle` vs `PhX` 用法

所有"软关闭/删除"位置（搜索框清空、列表项删除、对话删除、弹窗关闭、查找栏关闭等）一律 `PhXCircle`（圆圈包 X，视觉柔和）。

**`PhX` 只用于"窗口级关闭"**：Electron 标题栏 X、图片预览全屏 X（本身有圆形容器或系统级语义）。

## weight

**默认 `fill`**（实心）。两种例外允许局部用 `bold`：
- 三点菜单（`PhDotsThreeVertical`）— fill 像红绿灯
- Electron 标题栏 3 按钮（最小化/最大化/关闭）— fill 显得是黑块，bold 更像 Win11 线条按钮

## size

**用 rem 字符串**：`size="1rem"` / `size="0.875rem"`（=14px @ 16px html font-size）。

**禁止用数字 px**（`:size="14"`），因为图标不会跟着用户的字体大小设置（设置 → 字体）缩放。

数字 px 到 rem 的换算就是 N / 16。

## v-html 内嵌图标

组件 `<PhXxx />` 不能用在 v-html 渲染的字符串里（Vue 不解析字符串里的组件标签）。必须直接写 inline SVG 字符串。

SVG 必须加 `pointer-events: none`（否则会拦截父元素的 click 事件，导致 `closest('.xxx')` 失败）。

`utils/refLink.ts` 是引用块的范例。

## 视觉中心 ≠ 几何中心

`flex items-center` 居中后某些图标看着"高 / 低"，文字 + 图标的同一行尤其明显。

**常见偏移**：
- `PhBookOpen` 视觉重心偏下（书脊上窄、书页向下展开）
- `PhPenNib` 重心偏上（笔尖突出右上）
- `PhPencilSimple`、`PhTrash`、`PhCheck`、`PhArrowCounterClockwise` 都重心偏上
- `PhSparkle`、`PhPushPin`、`PhMapPin` 对称良好无需 nudge

**修法**：inline style `margin-top: ±1~2px` 单独微调，或用 Tailwind 任意选择器 `[&_svg]:mt-px` 给容器内所有 svg 统一加 nudge（再用 inline style 个别 override）。

**字号越小、padding 越紧凑时偏移越显眼**（11px 小字下 1px 都明显）。

范例：`NoteCard` 三点菜单（菜单内全员 `mt-px`，编辑/删除/标记完成 inline override 到 2px）、`RichEditor` AI 按钮组（润色/扩充/写文 各自 nudge）。
