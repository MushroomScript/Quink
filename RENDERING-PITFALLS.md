# RENDERING-PITFALLS.md

Quink web 端渲染相关坑：DOM 操作 / CSS 布局 / Vue 模板 / HMR / markdown 渲染 / Vditor 编辑器 / 动画 / 鼠标事件。

**改 UI、markdown 渲染、编辑器、列表动画相关代码前先来这里查一下**，避免踩重复的坑。本文件不自动加载，由根 `CLAUDE.md` 指针引导按需阅读。

新增渲染坑时也加到这里（不要再加回根 `CLAUDE.md`）。

## CSS / 布局

- **`overflow-x: auto` 会被浏览器隐式提升另一轴到 `overflow-y: auto`(W3C 规范)**：写 `<div class="overflow-x-auto">` 看似只想要横向滚动,实际 computed style 是 `overflow-x: auto + overflow-y: auto`(浏览器规则:一轴非 visible 时另一轴会从 visible 被强制提升到 auto,防止内容无法滚动)。**症状**:子元素 `transform: scale(1.x)` 的 visual box 即使只溢出 ~1px,这层容器也会跳出纵向滚动条。**修法**:确认容器是否真需要横向滚动 → 不需要就**整个容器删掉**(grid `minmax(0, 1fr)` 永远不溢出场景);需要就用 `overflow-x: clip`(Chrome 111+ 支持,clip 不会触发 overflow-y 自动提升)。范例:`Stats.vue` 热力图原 `<div class="overflow-x-auto">` 包裹层是死代码 + 让 cell hover scale(1.25) 触发滚动条,删了就好。

- **CSS container query 单位 `cqw` 让子元素跟容器宽度等比缩放**:固定 px 的元素在容器变宽时不跟着放大,视觉看起来"色块大了间距小了挤一团"。**修法**:给容器加 `container-type: inline-size` → 内部所有 `cqw` 单位(1cqw = container width 1%)随容器宽度等比缩放。比 vw(viewport)更精确——侧栏宽度变化只影响主区,viewport 不变但 cqw 会变。范例:`Stats.vue` 热力图卡片 `container-type: inline-size` + grid gap `0.3cqw` + 图例色块 `1.5cqw` + 字号 `1cqw`,窗口拉宽 cell/gap/图例同步等比放大,不再"色块大间距挤"。Chrome 105+ / Safari 16+ / Firefox 110+ 支持,Electron 内核够新。

- **`-webkit-line-clamp` 截断要求 `-webkit-box` 容器直接包含可截断内容，不能隔一层 div**：典型错误是 `<div class="line-clamp-4"><div v-html="..."></div></div>` —— 外层 -webkit-box 只看到 1 个块级子元素（内层 div），把整体当 1 行 box 算 → 4 行截断失效，整个 markdown 全部展开。**修法**：line-clamp-N class 直接套在包含 markdown 的 div 上（如 `<div class="vditor-reset line-clamp-4" v-html="..." />`），让 -webkit-box 直接含 markdown 输出的 p/h1/ul 等块级子元素。同时确保没有 `overflow: visible !important` 之类的高优先级规则顶住 line-clamp 的 overflow:hidden。范例：`NoteCard.vue` / `Trash.vue`。

- **圆角裁切 + absolute 定位锚点不要混在同一个 div 上**：父级 `overflow-hidden` 会裁掉绝对定位的子下拉。修法：外层套一个仅做 `relative` 的容器，内层做 `overflow-hidden` 圆角裁切。

- **`position: sticky` 的"上限"是父级 content box, 不是 scrollport**: 父级有 `padding-top` 时, sticky top: 0 子元素停在父级 padding 内边界, 不是 scrollport 顶部。**症状**: 滚动开始几像素 sticky 元素跟着内容滑动, 到达父级 padding 边界才钉住。**修法**: sticky 元素的父级 padding-top **必须去掉**(改 pb-x 只留底部, 或者把 padding 移到 sticky 元素自身内部用 pt-x 代替)。范例: `Trash.vue` 根 div 从 `py-6` 改 `pb-6`, sticky toolbar 自带 `py-2` 给视觉间距。

- **sticky 元素的钉住范围 = containing block, 父级太矮等同 sticky 失效**: sticky 元素只能在 containing block (最近 block 父) 内部钉住, 父级 height = sticky 自身 height 时没"钉住"空间, 元素跟着 normal flow 滚走。**症状**: 加 `sticky top-0` 但实际滚动时跟着内容走, 像 sticky 没生效。**修法**: 让 sticky 的父级跨越整个 scrollport (overflow 容器) 的内容高度。**典型场景**: Teleport target 是 main 内的空 portal div, batch bar 是 portal 唯一子, portal height = 46px → sticky 失效。**正确做法**: portal 同时包住 RouterView (portal height = main 内容全高), 或者 sticky 元素直接是 scrollport 的子。范例: `App.vue` 的 `#batch-bar-portal` 包住 `<RouterView>`。

- **Vue 3.5+ `<Teleport>` target 在 source 之后 mount 要用 `defer` prop**: TopBar 跟 main 是 flex sibling, TopBar 先 mount 时 main 内的 `#batch-bar-portal` 还不存在 → Teleport warn 找不到 target 并 fallback 到原 DOM 位置 (源代码位置), 等于 Teleport 没生效。**症状**: portal div 为空, source 内容在原位置渲染。**修法**: `<Teleport to="#batch-bar-portal" defer>` 让 Teleport 延后到 patch 完成后 attach, 那时 target 已经 mount。范例: TopBar batch bar Teleport 到 App.vue main 内 portal。

- **sticky 元素切换 relative ↔ fixed 那一瞬间, 内容亚像素抖动 1-2px**: sticky 元素从"跟随文档流"切到"钉住"时浏览器重新计算渲染层, 亚像素位置(如 23.7px)在切换瞬间四舍五入到 24px, 文字位置抖一两像素。**修法**: sticky 元素加 `transform: translateZ(0)` + `will-change: transform`, 强制从挂载起就在独立 GPU 合成层, 切换时不需要动态创建 layer, 亚像素位置一直稳定。范例: `Trash.vue` sticky toolbar inline style。**注意**: `transform` 会让该元素成为 `position: fixed` 子元素的 containing block, 所以只在叶子节点(没 fixed 子代)上用; 全屏 fixed modal 之类的祖先用 transform 会困住子代(详见动画段同名坑)。

- **跨用户字号设置(prefs.fontSize 改 `<html>` 的 font-size)下"固定高度容器内文字居中"用 `h-[N] + leading-[N]` 而不是 `h-[N] + leading-none + items-center`**: 后者让浏览器算 `(容器高 - 字号)/2` 作为居中偏移, **rem 单位经过用户字号 scale 后 round 到整数 px, 容器和字号 round 后的差值奇偶在不同字号下变化** → 差是偶数(2/4/6...)精确居中, 差是奇数(3/5/7...) round 到 .5px 然后偏 0.5-1px。`leading-[N]` 让 line-box 高度 = 容器高度, 字符在 line-box 内的位置由字体 baseline 决定, 字体设计师保证跨字号比例一致 → 不依赖减法 round。**配套规则**: 容器和字号都用 rem 单位(`h-[1.125rem]` / `text-[0.6875rem]`)跟用户字号同步缩放, **混用 rem 容器 + px 子元素是跨字号比例失调的根源**(rem 跟字号 scale, px 不动 → 比例变化)。**只适用于字符居中**: toggle 圆球 / icon 等几何块没有 baseline, flex items-center 已是几何居中最优, 跨字号完美对齐物理上做不到(Element Plus / Naive UI 同样有这个问题, 接受 18 字号完美 + 其他字号微偏 <1px 是合理折中)。**vs 浏览器 zoom (Ctrl+/-)**: zoom 是 paint 层等比 scale, layout 数学关系不变, 不会引入这种 round 奇偶问题。范例: `Sidebar.vue` 待办未完成数字徽章; `ToggleSwitch.vue` 迷你 size 接受跨字号微偏。详见 commit 47bb87d / d58382d 按钮 padding rem-based 同根因。

## Popover / Teleport / Stacking context

- **下拉/popover 在编辑器旁边总被盖住**：编辑器（Vditor 等）经常创建 stacking context，子组件的 z-[9999] 不起作用。解决方案：**默认走 `<Teleport to="body">` + `position: fixed` + 动态算位置**。范例：TopBar 的标签建议下拉、batchMove 下拉。

- **"下拉 + 遮罩"成对组件不能"半个 Teleport"**：典型是"点外面关菜单"模式——菜单 `absolute z-50` + 全屏透明遮罩 `fixed z-40`。如果只 Teleport 其中一个，遇到祖先有 stacking context（`opacity != 1` / `transform` / `filter` / `will-change` 等）时本地那个 z-index 会被困在局部 context、对外失效（等同 z-auto），Teleport 出去的反而盖住它，**点击全落到遮罩上、菜单按钮看着在那但全部失效**。修法：要么都 Teleport，要么都不。范例：NoteCard 三点菜单+关闭遮罩 在 Todos 已完成区 `.notes-masonry opacity-60` 内被坑过（编辑/置顶/标记未完成/删除全点不动）。

## Vue / HMR

- **`async watch` / `async watchEffect` 必须用 `onCleanup` 守门,否则迟早 race**:依赖快速变化(用户连续编辑 / 流式 SSE / 快速切卡片)时,多次 callback 并行运行,await 完成顺序无保证 —— 旧的若后完成会覆盖新的最终值,UI 看似"不刷新"。**症状**:编辑后偶尔列表显示旧内容,刷新页面又正常(reload 后 watch 从零跑第一次,没竞争)。**修法**:`watchEffect(async (onCleanup) => { let cancelled = false; onCleanup(() => cancelled = true; ); ... await ...; if (cancelled) return; result.value = ...; })`。watch 签名是 `(new, old, onCleanup)`,第三参数同理。范例:`NoteCard.vue` 的 markdown 渲染 watchEffect、`NoteDetail.vue` 的 content watch。**通用规律**:只要 watch/watchEffect 里有 `await`,就要 onCleanup,跟 fetch 过期 abort / setTimeout 卸载 clear 是同类责任。

- **`onMounted` 给 `document`/`window` 挂全局副作用 HMR 不友好**：开发期 HMR 重 mount 后旧 handler 还在 document 上，capture 阶段先于新 handler 触发并 `stopImmediatePropagation`，调用旧闭包里的函数（操作旧响应式状态，新 UI 完全没反应；典型症状："改完代码 X 功能失效，F5 就好"）。**`onBeforeUnmount` 不够用**——HMR 卸载顺序不可靠。修法：组件文件顶部用模块级 `let prevXxxHandler = null` 缓存上次挂的对象，下次 `onMounted` 入口先 `removeEventListener` / 还原原函数再挂新的。范例：`App.vue` 顶部 `prevRefClickHandler` + `prevWindowOpen` 的模块级清理逻辑。

## markdown 渲染（含 Vditor）

- **显示态复用 Vditor 编辑器 CSS（`.vditor-reset`）渲染 markdown，避免重写一套 markdown 样式**：NoteCard / NoteDetail / Trash / AI 对话 / 引用预览这些显示态笔记 markdown 的地方，结构上用 `<div class="note-content"><div class="vditor-reset" v-html="..."></div></div>` 嵌套两层。外层 `.note-content` 提供搜索高亮 / 音频胶囊 / 图片预览 click delegate 等附加规则，内层 `.vditor-reset` 复用 `vditor.css` 的 heading / list / code / table 等 markdown 元素样式（显示态视觉跟编辑态完全一致）。**`style.css` 的 `.note-content .vditor-reset` 必须清零 background / color / padding / margin（覆盖 vditor.css 默认值），但绝对不要加 `overflow: visible !important` —— 它会顶住 `.line-clamp-N` 需要的 overflow:hidden 导致截断失效**。vditor-reset 默认 `overflow:auto` 在我们卡片/弹窗里实际不会触发滚动条（高度自适应，无固定 height）。历史教训：曾经尝试装 `@tailwindcss/typography` 用 `prose prose-sm`，但 prose 自带颜色/字号风格跟主题不搭，且跟 Vditor 编辑态视觉不一致，最终选了"复用 vditor-reset"方案 C。

- **`html.replace(regex, '<mark>$1</mark>')` 这种字符串级别的搜索高亮会破坏 HTML 属性**（比如 `<a href="x.mp3">` 里的 mp3 被替换 → CSS 选择器 `a[href$=".mp3"]` 不匹配 → 音频胶囊样式失效）。正确做法：用 `(<[^>]+>)|([^<]+)` regex 拆"标签 vs 文本"，只在文本上替换。范例：`NoteCard.vue` 的搜索高亮。AI.vue 用 TreeWalker + range.surroundContents，天然安全。

- **markdown 内嵌 emoji + 渲染端 regex 自动加 emoji = 双图标 bug**：写入端就别塞 emoji，渲染端用 `replace(/^📌\s*/, '')` 剥老数据的前缀。范例：`utils/refLink.ts`。

- **流式 markdown 渲染用"单调递增版本号 + GT 比较"**：每个 SSE delta 都触发一次 `Vditor.md2html(snapshot)`（异步、多个 in-flight、完成顺序乱）。错误做法是给每个 delta 分 `myVer` 然后完成时检查 `myVer === currentVer`（"还是最新版才覆盖"），结果连续 delta 时 myVer 永远被超越 → 永远不更新 → 看着"全部出完才渲染"。**正解**：维护 `lastRenderVer`，完成时 `myVer > lastRender` 才覆盖（内容单调向新）。范例：`AI.vue` 的 `streamingVersion` + `streamingLastRenderVer`。

- **markdown 编辑器按 Enter vs 粘贴文本行间距差异**：Markdown 语法里"换行"是个语义陷阱 —— 按 Enter 一次生成段落分隔（`<p>...</p><p>...</p>`，间距 = `p` 的 `margin-bottom` 默认 16px）；粘贴含 `\n` 的多行文本生成同段落硬换行（`<br>`，间距 = `line-height` 大约 21px）。视觉上"两行文字"但 DOM 结构完全不同。Vditor 默认 `.vditor-reset p { margin-bottom: 16px }` 让段落间距偏大。**修法**：全局 CSS 把 `.vditor-reset p` 和 `.note-content p` 的 `margin` 缩小到 `0.4em`（用 em 跟字体缩放）。**保留 markdown 段落语义**（导出 / 搜索 / AI 处理都正确），只调视觉。范例：`style.css` 的 `.note-content p, .vditor-reset p { margin: 0 0 0.4em !important }`。

- **Vditor (lute) 解析器会破坏 markdown 内嵌的 inline `<svg>` / HTML span**：把 SVG 字符串拼进 markdown 字符串里 → `md2html` 后 span 的 class/data-* 一并被剥掉，全局 click 监听找不到锚点（典型症状：引用预览不弹了）。**分两步**：markdown 阶段只生成不带 SVG 的纯 span，md2html 之后再用 `injectXxxIcons(html)` 用 string.replace 把 SVG 注入进去。范例：`utils/refLink.ts` 的 `renderRefLink` + `injectRefLinkIcons` 双阶段。三个调用点 `NoteCard.vue` / `App.vue` / `NoteDetail.vue` 都要走这个流程。

- **`Vditor.insertValue` 在异步回调里必须先 `focus()`**：`insertValue` 内部走 `range.insertNode`，插入位置是浏览器**全局 selection**，不是 editor 内位置。异步等待期间（上传 / 引用搜索 / AI 应用 / 录音上传）用户可能点了别处，selection 跑到 TopBar / Sidebar / 任意 DOM 节点 → markdown 文本作为纯 text node 插到那里，**切换路由不消失**（被插的节点不在 router-view 子树），F5 才能刷掉。偶发，看用户点击时机。**统一 pattern**：`vditor?.focus(); setTimeout(() => vditor?.insertValue(...), 80);`，给浏览器 ~80ms commit focus。范例：`RichEditor.vue` 全部 4 处 insertValue（upload format / insertRef / applyAiResult / uploadPendingVoice）都走这个。

- **Vditor 工具栏 upload 项是 `<div>` 不是 `<button>`**：源码硬编码 `s = "upload" === t.name ? "div" : "button"`，整个工具栏唯一例外。任何 `.vditor-toolbar__item button` 的样式（尺寸 / color / hover 灰底圆角 / 子 SVG width/height）对 upload **全失效**，要把 `[data-type="upload"]` 接进同一组 selector。另外 div 默认不居中，要单独给 upload 加 `display: inline-flex + align-items: center + justify-content: center + cursor: pointer`，否则 SVG 贴左上角且鼠标不变手。范例：`RichEditor.vue` toolbar 样式块（`.vditor-wrapper .vditor-toolbar__item ...` 那一段）。

- **Vditor mount 会覆盖 wrapper inline style 的 minHeight**：源码 `e.element.style.minHeight = options.minHeight + 'px'` 直接写到 wrapper 上。如果 Vue 端 `:style` 设的 minHeight 跟传给 Vditor 的 `options.minHeight` 不一致，会出现"加载前高 / 加载后矮 / 用户首次 reactive 交互后再变高"的三段抖动 —— 因为 Vue 每次 patchStyle 会把 :style object 里的 minHeight 重写回 element.style，盖掉 Vditor 设的。**修法**：让 Vue 端 inline minHeight 精确等于传给 Vditor 的 `options.minHeight`（不要自己加 toolbar 占位高度），三个时刻就一致。范例：`RichEditor.vue` 的 `<div ref="editorRef" class="vditor-wrapper" :style="{ minHeight: minHeight + 'px' }">` 跟 Vditor config `minHeight: props.minHeight` 完全对齐。

- **Vditor IR 模式 heading 的 H1/H2/H3 标记会"半个数字"溢出编辑区左边**：Vditor 给 heading 加 `:before` 伪元素显示 "H1" / "H2" 标记，定位用 `margin-left: -29px` 飞到编辑区外。我们 `.vditor-reset` 的 `padding-left: 16px` 不够容纳 29px 偏移 → 标记左半被裁。**修法**：直接 `display: none !important` 隐藏标记，IR 已经把 heading 渲染成大字粗体，语义足够明显，不需要额外标记提示。范例：`RichEditor.vue` 的 `.vditor-ir .vditor-reset > h1..h6:before` 隐藏。

- **Vditor IR 模式 markdown `![](裸名)` 渲染 `<img src="裸名">` 浏览器拼当前页 url 路径 → 404**：项目约定 DB / 笔记 content 里文件 url 都存裸名(如 `xxx.png`)不带 `/api/uploads/` 前缀,显示态渲染前调 `resolveMarkdownFileUrls(md)` 拼前缀。但 **Vditor IR 模式编辑器内部**直接读 markdown 文本里的 href 给 `<img src>`/`<a href>`,不走我们的拼前缀 helper —— 浏览器解析相对路径 = 当前页 URL + 裸名 = 404,**编辑器内打开的笔记图片预览全是裂图**。**修法**: RichEditor 走"编辑器内 absolute / 存储裸名"双向转换 —— `value: resolveMarkdownFileUrls(initialContent)` 进编辑器拼前缀(Vditor IR 渲染 img 正常),`handleSubmit` 里 `stripMarkdownFileUrls(getValue())` 剥前缀回裸名保存进 DB。同样 `vditor.setValue` / `insertValue` / Vditor `succMap` 都用 `resolveFileUrl()` 拼前缀。helper 都在 `utils/fileUrl.ts`。范例: `RichEditor.vue` 5 处包装(value / handleSubmit / setValue / succMap / insertValue 两处)。

- **Vditor toolbar tooltip 默认伪元素会被 `main` 的 `overflow-y-auto` 裁切**：App.vue 的 `<main class="flex-1 overflow-y-auto">` 让 tooltip 飞出 main 上边界（朝向 TopBar 方向）时被 overflow 裁掉一半。这跟 z-index / stacking context 无关 —— overflow 裁切是另一回事。**修法**：CSS 隐藏 Vditor 默认 tooltip 伪元素，用 `<Teleport to="body">` 实现自定义 tooltip：mouseover 事件委托到 vditor-wrapper → closest `.vditor-tooltipped` 找按钮 → 读 `aria-label` → `getBoundingClientRect` 算位置 → fixed 定位 + `z-[10000]` 永远顶层。**边界处理**：`r.top < 32` 时自动翻转到按钮下方（应对 Capture 等顶部贴边场景）；tooltip center 用 `clamp(HALF+MARGIN, vw-HALF-MARGIN)` 防止最左/最右按钮 tooltip 超出窗口边界。范例：`RichEditor.vue` 的 `customTooltip` + `onToolbarMouseOver`。

## 动画（TransitionGroup / FLIP）

- **TransitionGroup 中"长距离飞行 + 渐隐"动画的 transform 和 opacity 曲线方向不能相反**：典型错误是 `transition: transform 0.5s cubic-bezier(0.55, 0.06, 0.68, 0.19), opacity 0.5s ease-out`（transform 前慢后快"加速冲过去"、opacity 前快后慢"早早就 fade 掉"）。结果：实际位置进度约 25-30% 时 opacity 已经 ~0.2 几乎透明 → 视觉上"飞一半就消失"。**修法**：给 opacity 加 delay 推到飞行末段才开始变化，比如 `opacity 0.15s ease-out 0.35s`（350ms 后才开始 fade，150ms 内变 0）。这是 macOS dock"被吸进 dock"的标准做法 —— 元素始终可见地飞过去，到目的地附近才淡化。范例：`utils/cardLeave.ts` 的 `flyToNavLeave`。短距离飞行不明显（opacity 还没 fade 完元素就到目的地了），长距离场景才暴露 bug。

- **TransitionGroup 列表删除"左飞 + 高度收缩"动画**：用 `<TransitionGroup name="xxx" tag="div">` 包 v-for；CSS `.leave-active` **必须** `overflow: hidden`，否则 max-height 不生效；`.leave-to` 同时设 `max-height: 0`、`opacity: 0`、`transform: translateX(-110%)`，并把 `margin/padding-y` 都 `!important` 归零（否则空间不收缩、相邻项不会自然上移）；`.leave-from` 显式给个 max-height（如 5rem）作为起点。范例：`AI.vue` 末尾的 `.conv-list-leave-*`。

- **笔记卡片列表 leave 动画体系**（`utils/cardLeave.ts` 含 `fadeOutLeave` / `collapseLeave` / `flyToNavLeave` / `fadeInEnter`）—— 涉及 TransitionGroup + Vue FLIP 干扰、`watch flush:'sync'` snapshot、helper 按容器布局选型、staying 对齐动画依赖等多个坑，详见 **`packages/web/src/utils/CLAUDE.md`**。改这些 helper 或在 view 里用它们前先读那里。

- **多条同时进出的 TransitionGroup 用 `leave-active: absolute` 让退出元素脱离 flex 流**：`max-height / padding / margin` 塌缩是 layout 属性,每帧 reflow;多条 (toast / 卡片) 同时 enter+leave 时 N 个元素并行 layout 反复重排 → 整树抖动卡顿。**修法**:`leave-active-class="absolute"` 让退出元素瞬间脱离 flex 流(默认 `top: auto / left: auto` 保留 static 位置),剩下元素立即重排,由 `move-class` 走 FLIP transform 平滑补位;动画本身只过渡 `opacity + transform`(用 `transition-[opacity,transform]` 而非 `transition-all`,显式列出告知浏览器走 GPU compositing)。全程零 reflow。**vs 单条/双条场景**:单条 / 双条用 `max-height` 塌缩 + `transition-all` 写法直观也够丝滑;多条进出 (5+ 并行) 才必须走 absolute 路径。**何时不能用 absolute**:退出元素 leave 期间还要在 flex 流里持续占位(响应 hover / 交互),那只能塌缩。范例:`components/GlobalToast.vue` 叠加式 toast(上限 5 条同时显示)。

- **modal 容器用 transform / scale 动画会困住内部 `fixed inset-0` 全屏子元素**：CSS 规范——祖先有 `transform / perspective / filter / will-change` 等会让 `position: fixed` 子元素的 containing block 从 viewport 变成那个祖先。典型 bug 场景: `NoteEditModal` 用 modal-enter scale 动画(`.relative` 容器 scale 0.95→1)，内部 `RichEditor` 全屏时根 div 是 `fixed inset-0 z-[200]`。enter 动画 180ms 期间 `.relative` 一直有 transform → fixed 全屏元素被困在 modal 小卡片尺寸里 → 看着像"全屏打开时先一闪小窗"。**修法**：全屏场景下用一个不带 scale 的 Transition name（如 `modal-fade`，只 fade 不 transform），跳过 scale 动画。范例：`NoteEditModal.vue` 的 `<Transition :name="initialFullscreen ? 'modal-fade' : 'modal'">`。

- **Vue Transition leave 期间复杂第三方组件（Vditor 等）会提前 destroy / 改动 DOM，CSS lock 拦不住**：典型症状是"modal 关闭时，里面的编辑器/复杂内容先消失，剩下的空容器再 fade out 一阵，看着像两阶段闪烁"。**用 `chrome-devtools-mcp` + `MutationObserver` 实测发现**：按 Esc 后 ~3ms 内 vditor 就在 wrapper 上连续 5 次改 style + 移除子节点(`childList -2`)，比 leave 动画(180ms)早完成绝大部分操作 → 剩下的 175ms 用户看到的就是 "空 wrapper 在 fade"。**lock height / `visibility: hidden` / GPU layer(`transform: translateZ(0)`) / disable transition 都无效**：vditor 用 JS `setAttribute` 直接覆盖你的 CSS，跑得比 CSS 早。**真正能修的方案——`cloneNode + replaceChild` 偷天换日**: 按 Esc 瞬间把 wrapper 克隆一份**静态 HTML 副本**插回 DOM，原 wrapper 从 DOM 树移除变成**游离节点**。Vditor 内部 destroy 操作的是游离节点（已不在 DOM 树），DOM 里看到的 staticCopy 是当时状态的静态快照，fade 期间完全稳定。**借力打力**: 不跟 Vditor 内部机制对抗(改不动)，而是让它打空气——目标被偷换走。**这个思路适合所有"组件 unmount 期间想保留视觉的场景"**（Vditor / 复杂图表 / video player 等）。范例：`NoteEditModal.vue` 的 `startClose()`。

- **找视觉/layout 闪烁的 root cause 用 `chrome-devtools-mcp` + `MutationObserver`，不要靠肉眼猜**：CSS / lock height 类修法 5 个方向猜错(就这个 modal 闪烁 bug 走了一通弯路)。**正确流程**: 装 `chrome-devtools-mcp` MCP server → Electron 启动加 `--remote-debugging-port=9222`(在 `start-desktop.bat` 和 `packages/desktop/package.json` 都加) → MCP `evaluate_script` 注入 `MutationObserver`(监听目标元素 + 父级容器整个 subtree, `attributes/childList/subtree=true`) → 触发要观察的动作(`press_key` Esc / click 等) → 读取 mutation log。一帧的精度(<1ms)定位到具体哪个元素、哪个属性、哪一刻被改了，对症修法。**录屏慢放只能精确到 16ms (60fps)，看不到 3ms 内连续 5 次的 setAttribute**。

- **Vue Transition 用 transform class (`-translate-y-X` / `translate-y-0`) 做位移动画, 结束后 transform 被 Vue 移除元素回到 base, base 没 transform → 渲染层从 GPU 合成切回普通层, 字体子像素抗锯齿模式切换 (grayscale → subpixel), 视觉"字抖一下"**: 跟本文件 CSS 段"sticky 切换 relative↔fixed 抖动"同源 —— 都是 transform 进出 GPU 合成层时字体光栅化变化. **修法**: 给 transition 元素 base class 加 `transform-gpu` (Tailwind utility, 等价 `transform: translate3d(0,0,0)`), 让 GPU 合成层从 mount 起就常驻, 动画结束后 transform 不消失, 渲染层不切换. Tailwind 的 `transform-gpu` 通过 `--tw-translate-y` 等 CSS 变量跟 `-translate-y-8` / `translate-y-0` 协同, 不冲突 (Vue Transition class 仍正常生效 set translate-y, transform-gpu 提供 translate3d 组合规则). 范例: `GlobalToast.vue` toast div.

- **Vue Transition 的 enter-to / leave-from class 在动画结束时被 Vue 移除, 元素回到 base class —— 想保留稳态非默认值 (如 opacity 0.75 而非 1.0) 必须写在 base, 不能只写在 enter-to**: 典型错误是 base 只写 Tailwind `opacity-75`, 期望动画结束后保留. 但 Tailwind utility `.opacity-0` 和 `.opacity-75` 同 specificity (0,0,1,0) 且都出现在元素 class 时, **如果 Tailwind utility 输出顺序意外导致 `.opacity-75` 没生效** (HMR 没重新扫描 / JIT cache / 之前没用过 opacity-75 现在新加等) → 稳态就掉回默认 1.0. **更稳的修法**: base 用 inline `:style="{ opacity: 0.75 }"` 钉死稳态值 (绕过 Tailwind class 优先级不确定性), enter-from / leave-to 用 Tailwind `!opacity-0` (`!` 前缀生成 `opacity: 0 !important`, 唯一能压过 inline style 无 !important 的方式). enter-to / leave-from 不需要再写 opacity, 让 inline 自然接管. 范例: `GlobalToast.vue` 透明 toast.

- **"拖动 + 单击关闭"并存要防"拖完误关"**：`mousedown → 拖 → mouseup` 后浏览器自然会再触发一次 `click`，如果这个元素的 click 绑了关闭/导航，手刚松开就误触发。修法：`mousemove` 时记录 `dragMoved = true`（带 ~3px 阈值避免抖动误判），`click` handler 检测 `dragMoved` 真就 `return`、否则关闭。同时 `mousemove` / `mouseup` 监听必须挂 `window`（不是元素本身），否则鼠标快速移出元素时拖动状态会卡住；`<img>` 加 `draggable="false"` 防止 HTML5 原生拖图弹出半透明鬼影。范例：`Resources` 图片预览（放大后可拖、单击关闭，两者共存）。

## 其他

- **Windows bat 文件编码**：永远用 PowerShell `[System.IO.File]::WriteAllBytes` 写 **GBK + CRLF** 的 bat 文件，**不要**用 Write 工具（UTF-8 + LF），cmd 默认 cp936 会把 UTF-8 中文字节当命令分隔符乱读。`chcp 65001` 救不了，因为 cmd 逐行读，那一行本身就被拆了。

- **`prompts.ts` 模板字符串里别嵌反引号写示例**：在 `` `...` `` 模板字符串内再写 `` ` `` 会让 tsx 解析器把模板字符串提前闭合 → server 起不来 → 没有红色编辑器警告，只有运行时崩溃。**用 「」 或 '...' 包代码/字段示例**。范例：`prompts.ts` chat prompt 里 `「label」(refId:xxx)` 写法（不要再变成 `` `「label」(refId:xxx)` ``）。
