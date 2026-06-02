# z-index 体系

> 全项目 z-index 统一走 CSS 变量(`packages/web/src/style.css` 顶部 `:root`)。新增层级先来这里登记,代码里只写变量名,**不要直接写数字**。

## scale 总表

| 变量 | 数值 | 用途 | 典型场景 |
|---|---|---|---|
| `--z-sticky` | 10 | sticky 工具栏 / 卡片 hover 浮起 | Resources/Settings/Trash/TopBar 顶部 sticky bar、Stats 顶卡 hover、NoteEditModal 内 confirm 子覆盖、Login 内容、Resources selectMode 复选标记 |
| `--z-drop-hint` | 30 | 拖入大边框提示 | Resources 拖入虚线大框 |
| `--z-sidebar-backdrop` | 40 | 侧边栏菜单的点空 backdrop | Sidebar 用户菜单背景层 |
| `--z-sidebar` | 50 | 侧边栏类容器 | Sidebar 用户菜单、移动端 sidebar/AI 抽屉、Capture 容器、RichEditor 工具栏、MobileInput toast |
| `--z-modal-edit` | 100 | 笔记编辑主 modal | NoteEditModal |
| `--z-modal-edit-inner` | 110 | 编辑 modal 内的子组件 | NoteEditModal 内 RichEditor、AttachmentDownloadDock |
| `--z-modal-preview` | 150 | 引用预览 modal(高于编辑 modal) | App.vue 引用预览 |
| `--z-modal` | 200 | 通用 modal | confirm 弹窗、Tags 编辑、RenameModal、ReminderPicker、RichEditor 全屏 |
| `--z-modal-media` | 300 | 媒体预览 / 日期选择 | DatePicker popup、ImagePreview、VideoPreview |
| `--z-datepicker-backdrop` | 299 | DatePicker 内 backdrop(跟 popup 紧耦合) | DatePicker `.qdp-backdrop` |
| `--z-context-menu` | 400 | 右键菜单 | MediaContextMenu |
| `--z-popup` | 1000 | 自定义 popup(高于 modal 低于 toast) | CustomSelect popup |
| `--z-overlay-backdrop` | 9998 | 临时悬浮 overlay 的点空 backdrop | NoteCard/NoteDetail menu backdrop、TopBar dropdown backdrop |
| `--z-overlay` | 9999 | 临时悬浮 overlay | NoteCard/NoteDetail menu、TopBar 各类 dropdown、GlobalToast、DragGhost、Stats tooltip、AudioPlayer 浮动菜单、Resources drag ghost |
| `--z-tooltip` | 10000 | tooltip(比 overlay 略高) | RichEditor 自定义 tooltip |
| `--z-caret` | 2147483646 | 自定义粗 caret 覆盖层 | useCustomCaret(必须比所有 OS 控件 + 编辑器内置 caret 都高) |

## 使用

**Tailwind 任意值语法**(全项目主用):

```vue
<div class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
```

**scoped style 内**:

```css
.my-popup {
  z-index: var(--z-popup);
}
```

## 设计原则

1. **数值不变** —— scale 数值是历史现状的归纳,不动叠加顺序。任何"层级看起来不对"的问题应该先确认是不是该项目层级本身错了,再决定改值还是改变量。
2. **stacking context 比 z-index 数值更重要** —— transform/opacity/filter 父元素会创建新 stacking context,子元素的 z-index 只在自己 context 内有效。模态层组件必须用 `position: fixed` 直接挂 body,绕开父级 stacking context。详见 `RENDERING-PITFALLS.md` 的 stacking context 段。
3. **新增层级先登记** —— 不要随便在代码里写 `z-[1234]` 数字。新场景找最接近的变量复用;实在没法复用,先来这个文档加新变量。
4. **同档不同实例** —— 多个相同档位的 overlay 同时显示靠 DOM 顺序(后定义的盖前面),不要靠加 1。

## 历史 / 现存 quirks

- **RichEditor.vue 内部 z-10/z-999** —— `position: relative` + `z-index: 10` 是工具栏内部局部叠加,`z-index: 999 !important` 是覆盖 Vditor 默认 dropdown,这些都是局部 stacking context 内的相对叠加,不进 scale。
- **cardLeave.ts 内 zIndex: '10'** —— 拖动时给单卡设的局部 z-index,卡之间相对叠加用,不进 scale。
- **NoteCard menu 用 `--z-overlay`(9999) 而不是 `--z-popup`(1000)** —— 历史决策。理论上 popup 档够用,但保留 9999 是因为 NoteCard menu 跟 TopBar dropdown 是同一类临时悬浮(`<click outside close>` + 一次性显示),改成 1000 视觉上无影响,但语义上"卡片浮动菜单"跟 "TopBar 下拉菜单"应该归一档。
- **useCustomCaret 用 `2147483646`** —— 必须高于 Vditor 内嵌 toolbar / OS 文本输入框的 native caret 层。这是浏览器实际允许的最大 z-index 附近的一个值,留 1 给真·最顶层。
