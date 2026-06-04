// 笔记卡片 leave 动画 helper
//
// 为什么需要主动 snapshot：Vue 的 patch 顺序里，v-if 切换（顶部工具栏消失、空提示出现）
// 会先于 onLeave 钩子执行。当钩子触发时，TransitionGroup 容器已被推位移，getBoundingClientRect
// 拿到的是错位坐标 —— 单删最后一项也会"瞬移"。
// 解决：view 用 watch + flush:'sync' 在数据变更的同步上下文里主动调 snapshotCards()，
// 此时 DOM 还没 patch，所有卡片位置准确。onLeave 钩子直接读缓存。

const positionMap = new WeakMap<HTMLElement, DOMRect>();

// 在数据变更前主动调用，缓存所有卡片当前位置
// 推荐用法：watch(() => list.length, () => snapshotCards(), { flush: 'sync' })
// 默认匹配 .notes-masonry 容器和带 [data-animated-list] 属性的容器（资源/标签/AI 配置等列表）
export function snapshotCards(selector: string = '.notes-masonry, [data-animated-list]') {
  document.querySelectorAll(selector).forEach(container => {
    for (const child of Array.from(container.children)) {
      const c = child as HTMLElement;
      positionMap.set(c, c.getBoundingClientRect());
    }
  });
}

function lockToScreen(card: HTMLElement) {
  // 优先用 snapshot 缓存；fallback 到当前位置（边界情况：length 未变但元素变更，watch 漏触发）
  const rect = positionMap.get(card) || card.getBoundingClientRect();
  card.style.position = 'fixed';
  card.style.left = rect.left + 'px';
  card.style.top = rect.top + 'px';
  card.style.width = rect.width + 'px';
  card.style.height = rect.height + 'px';
  card.style.margin = '0';
  card.style.zIndex = '10';
  // leaving 卡片渐变期间(300ms)不参与 hit-test, 否则用户在原视觉位置右键/点击会命中
  // 这张 invisible 的 leaving 卡片而不是下面已重排上来的新卡片. 症状: 右键菜单的"全选"
  // 选中的是错位卡片内容, 或者点击没反应 (命中 leaving 卡片但它已经在渐变中)
  card.style.pointerEvents = 'none';
}

// 纯淡出（删除类操作）
// 关键：transition 必须推迟到 onUpdated 跑完之后才设，否则 TransitionGroup 的
// hasCSSTransform 会检测到 inline transition 误判为需要 FLIP，导致清空 transitionDuration
// 让动画瞬间结束。两层 RAF：第一层等 onUpdated 跑完，第二层触发动画
export function fadeOutLeave(el: Element, done: () => void) {
  const card = el as HTMLElement;
  card.style.transition = '';
  lockToScreen(card);
  requestAnimationFrame(() => {
    card.style.transition = 'opacity 0.3s ease-out';
    requestAnimationFrame(() => { card.style.opacity = '0'; });
  });
  setTimeout(() => { positionMap.delete(card); done(); }, 330);
}

// 塌缩动画：给垂直列表用（max-height 渐变到 0 + opacity + margin/padding 归零）
// 适合"项数变化时容器高度也要平滑收缩"的场景。leaving 元素保留在 flow 中渐变扁，
// 剩余项被自然挤上去，外层容器高度跟着自然平滑减小。
// 用 fadeOutLeave 会让 leaving 元素 position:fixed 瞬间脱流，外层容器瞬间收缩，不适合垂直列表。
export function collapseLeave(el: Element, done: () => void) {
  const card = el as HTMLElement;
  card.style.transition = '';
  // 记录当前高度作为 max-height 起点（auto 不能过渡，必须先设固定值）
  const height = card.offsetHeight;
  card.style.maxHeight = `${height}px`;
  card.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    card.style.transition = 'max-height 0.3s ease-out, opacity 0.3s ease-out, margin 0.3s ease-out, padding 0.3s ease-out';
    requestAnimationFrame(() => {
      card.style.maxHeight = '0px';
      card.style.marginTop = '0';
      card.style.marginBottom = '0';
      card.style.paddingTop = '0';
      card.style.paddingBottom = '0';
      card.style.opacity = '0';
    });
  });
  setTimeout(done, 330);
}

// 纯淡入（待办状态切换时配合 leave 形成对称过渡）
export function fadeInEnter(el: Element, done: () => void) {
  const card = el as HTMLElement;
  card.style.opacity = '0';
  card.style.transition = 'opacity 0.3s ease-out';
  requestAnimationFrame(() => { card.style.opacity = '1'; });
  setTimeout(done, 300);
}

// 笔记 type 映射到 sidebar 上对应的导航菜单路径
const TYPE_TO_NAV_PATH: Record<string, string> = {
  note: '/',
  todo: '/todos',
  snippet: '/notes',
  link: '/notes',
};

function findNavTargetRect(navPath: string): DOMRect | null {
  const el = document.querySelector(`[data-nav-path="${navPath}"]`) as HTMLElement | null;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return rect;
}

// 飞向 sidebar 上 type 对应的导航菜单项（用于回收站恢复，模拟 macOS "被吸进 dock" 感）
// 找不到目标（移动端 sidebar 抽屉未打开等场景）则 fallback 到向上飞
// 关键：同 fadeOutLeave，用两层 RAF 推迟 transition 设置，绕开 Vue TransitionGroup 的 FLIP 干扰
export function flyToNavLeave(el: Element, done: () => void) {
  const card = el as HTMLElement;
  card.style.transition = '';
  lockToScreen(card);
  const cardRect = positionMap.get(card) || card.getBoundingClientRect();
  const noteType = card.dataset.noteType || 'note';
  const navPath = TYPE_TO_NAV_PATH[noteType] || '/';
  const targetRect = findNavTargetRect(navPath);
  let dx = 0, dy = -120, scale = 0.6;
  if (targetRect) {
    dx = (targetRect.left + targetRect.width / 2) - (cardRect.left + cardRect.width / 2);
    dy = (targetRect.top + targetRect.height / 2) - (cardRect.top + cardRect.height / 2);
    scale = 0.1;
  }
  card.style.transformOrigin = 'center center';
  requestAnimationFrame(() => {
    // transform 用 ease-in cubic-bezier (前慢后快, "加速飞过去") 模拟 macOS dock 吸入感
    // opacity 延迟到末段才开始变 (delay 0.35s + duration 0.15s), 让元素飞到目标附近时才 fade,
    // 避免"飞了一半已经透明"的视觉 bug
    card.style.transition = 'transform 0.5s cubic-bezier(0.55, 0.06, 0.68, 0.19), opacity 0.15s ease-out 0.35s';
    requestAnimationFrame(() => {
      card.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
      card.style.opacity = '0';
    });
  });
  setTimeout(() => { positionMap.delete(card); done(); }, 550);
}
