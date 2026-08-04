// 让编辑器里的内联样式标签「真的显示成样式」的装饰层。
//
// 背景: markdown 本身没有颜色/字号, 只能靠内联 HTML `<span style="color:红">文字</span>`。
// Vditor 不渲染它, 只把标签当代码片段显示。这一层做两件事:
//   1. 把开/闭标签那串源码用 CSS 收成一个小色点 (加 contenteditable=false 让光标进不去)
//   2. 给两个标签之间的内容套一层"装饰 span", 把标签里的 style 真正应用上去
//
// 存储不受影响: 装饰 span 是我们插的, Vditor 序列化回 markdown 时不认它, 存进库的还是干净 markdown。
//
// ── 五条铁律 (IR 时期用六轮踩出来的, 换 WYSIWYG 后依然成立) ──
// A. 输入法组合期间一个 DOM 都不能动, 否则打断 IME (症状: 打 s 选"是", s 和 是 一起上屏)
// B. 装饰还在就什么都不做。而且必须**逐对检查**, 不能比总数 ——
//    Vditor 重建 block 时有个中间态: 标签还没渲染出来, 这时配对数 0、装饰数 0,
//    `0 === 0` 会被误判成"干净"而跳过, 要等下次 DOM 变动才补, 中间几十毫秒就是用户看到的掉色
// C. 只重建受影响的 block, 不动全文
// D. 补装饰必须**同步**做 (MutationObserver 回调里直接做, 微任务内)。
//    换成 setTimeout 就会跨过绘制帧: Vditor 冲掉 -> 先画一帧没颜色的 -> 才补回来, 那一帧就是"闪"
// E. 忙的时候只排队不丢弃 + 每帧 rAF 兜底 + flush 结尾补到收敛
//
// ── WYSIWYG 跟 IR 的结构差异 ──
// IR:       <span data-type="html-inline" class="vditor-ir__node"><code class="vditor-ir__marker">源码</code></span>
// WYSIWYG:  <code data-type="html-inline">源码</code>          ← 一层, 而且文本前面有个零宽空格
// 本文件按 WYSIWYG 写, 同时兼容 IR (两种都查得到)。

const ZWSP = /[​﻿]/g;

export interface DecorHandle {
  /** 立刻检查一遍并补齐装饰 */
  refresh: () => void;
  /** 卸载: 停掉所有监听, 撤掉已加的装饰 */
  destroy: () => void;
}

interface Pair {
  open: HTMLElement;
  close: HTMLElement;
  style: string;
}

/** 标签节点里的源码文本 (剥掉 Vditor 塞的零宽空格) */
function markerText(el: HTMLElement): string {
  return (el.textContent || '').replace(ZWSP, '').trim();
}

/** 找出范围内成对的 <span style="..."> ... </span> */
function pairsIn(scope: HTMLElement): Pair[] {
  const nodes = Array.from(
    scope.querySelectorAll<HTMLElement>('code[data-type="html-inline"], span[data-type="html-inline"]'),
  );
  const open: { node: HTMLElement; style: string }[] = [];
  const pairs: Pair[] = [];
  for (const node of nodes) {
    const txt = markerText(node);
    const m = /^<span\s+style="([^"]*)"\s*>$/i.exec(txt);
    if (m) { open.push({ node, style: m[1] }); continue; }
    if (!/^<\/span>$/i.test(txt)) continue;
    const s = open.pop();
    if (!s) continue;
    if (s.node.parentNode !== node.parentNode) continue;   // 跨层的不处理
    pairs.push({ open: s.node, close: node, style: s.style });
  }
  return pairs;
}

/**
 * 只放行这几个 CSS 属性。
 *
 * 标签里的 style 是**笔记内容**, 群组共享的笔记内容是别人写的 —— 直接把任意 style
 * 套到编辑器 DOM 上, 等于让对方控制你的界面 (`position:fixed;inset:0` 就能铺一层盖住整个编辑区)。
 * 本功能自己只会产生 color / font-size, 白名单里另外几个是留给手写 markdown 的常见需求。
 */
const SAFE_PROPS = new Set([
  'color', 'background-color', 'font-size', 'font-weight', 'font-style', 'text-decoration',
]);

/** 滤掉白名单外的声明, 返回可以安全塞进 cssText 的字符串 */
function sanitizeStyle(css: string): string {
  return css
    .split(';')
    .map((decl) => decl.trim())
    .filter((decl) => {
      const i = decl.indexOf(':');
      if (i < 0) return false;
      if (!SAFE_PROPS.has(decl.slice(0, i).trim().toLowerCase())) return false;
      // 值里再塞外部资源 / 老 IE 的 expression 一律拒
      return !/url\s*\(|expression\s*\(|javascript:|@import/i.test(decl.slice(i + 1));
    })
    .join(';');
}

/**
 * 把装饰段的字号同步到那对隐藏标签上。
 *
 * 标签虽然是零宽隐藏盒子, 但光标停在它旁边时, 浏览器是按**紧邻的这个盒子**的行高
 * 画光标的。标签还按段落的小字号算的话, 大字号那行的光标就会又短又贴着行顶
 * (蘑菇实测: "有大号字, 我点到字前面的时候光标会出现在字左上角")。
 * 宽度由 .mk-color 的 width:0 + overflow:hidden 压着, 字号变大也撑不开布局。
 */
function syncMarkerSize(p: Pair, safe: string) {
  const fs = /(?:^|;)\s*font-size\s*:\s*([^;]+)/i.exec(safe)?.[1]?.trim() || '';
  for (const m of [p.open, p.close]) {
    if (m.style.fontSize !== fs) m.style.fontSize = fs;   // 值没变就不写, 少惊动 MutationObserver
  }
}

/**
 * 这一对是否已经装饰好了 (开闭标签之间正好夹着一个装饰 span, 且样式还是最新的)。
 *
 * `data-mk-deco` 属性里存的是**原始 style 字符串**, 专门用来做这个比较 ——
 * 不能拿 `el.style.cssText` 比, 那是浏览器规范化过的 (`color:#e11d48` 会变成
 * `color: rgb(225, 29, 72);`), 永远跟原文对不上。
 * 少了这个比较, "改标签里的 style" 这种操作会被当成"装饰还在"直接跳过, 样式不更新
 * (实测: 给已上色的字再设字号, markdown 合并对了但编辑器里字号没变)。
 */
function pairDecorated(p: Pair): HTMLElement | null {
  const mid = p.open.nextSibling as HTMLElement | null;
  if (!mid || mid.nodeType !== 1 || !mid.hasAttribute?.('data-mk-deco')) return null;
  if (mid.nextSibling !== p.close) return null;
  if (mid.getAttribute('data-mk-deco') !== p.style) return null;   // 样式变了要重画
  return mid;
}

/** 铁律 B: 逐对检查, 不比总数 */
function isClean(scope: HTMLElement): boolean {
  const pairs = pairsIn(scope);
  for (const p of pairs) if (!pairDecorated(p)) return false;
  return scope.querySelectorAll('span[data-mk-deco]').length === pairs.length;
}

export function createInlineStyleDecor(root: HTMLElement): DecorHandle {
  let composing = false;      // 输入法组合中
  let painting = false;       // 自己正在改 DOM
  let disposed = false;
  let mo: MutationObserver | null = null;
  let rafId = 0;
  const pending = new Set<HTMLElement>();

  function blockOf(node: Node | null): HTMLElement | null {
    let el: HTMLElement | null = node?.nodeType === 3 ? node.parentElement : (node as HTMLElement | null);
    while (el && el !== root && !el.hasAttribute?.('data-block')) el = el.parentElement;
    return el && el !== root ? el : root;
  }

  function blocks(): HTMLElement[] {
    const list = Array.from(root.querySelectorAll<HTMLElement>('[data-block]'));
    return list.length ? list : [root];
  }

  function allClean(): boolean {
    return blocks().every(isClean);
  }

  // ── 光标按文本偏移量存取: 装饰会动 DOM, 存节点引用会失效 ──
  function caretOffset(node: Node, off: number): number {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let total = 0;
    let n: Node | null;
    while ((n = w.nextNode())) {
      if (n === node) return total + off;
      total += (n as Text).length;
    }
    return -1;
  }
  function saveCaret(): { pos: number } | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!r.collapsed || !root.contains(r.startContainer)) return null;
    const pos = caretOffset(r.startContainer, r.startOffset);
    return pos < 0 ? null : { pos };
  }
  function restoreCaret(saved: { pos: number } | null) {
    if (!saved) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let total = 0;
    let n: Node | null;
    while ((n = w.nextNode())) {
      const len = (n as Text).length;
      if (total + len >= saved.pos) {
        try {
          const r = document.createRange();
          r.setStart(n, Math.min(saved.pos - total, len));
          r.collapse(true);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(r);
        } catch { /* 偏移越界时放弃恢复, 不影响内容 */ }
        return;
      }
      total += len;
    }
  }

  /** 增量装饰: 已经装好的那一对完全不碰, 只处理被 Vditor 冲掉的 */
  function decorate(scope: HTMLElement) {
    const pairs = pairsIn(scope);
    const alive: HTMLElement[] = [];

    for (const p of pairs) {
      // 存原文进 data-mk-deco (给 pairDecorated 比对), 但真正上屏的只有过滤后的声明
      const safe = sanitizeStyle(p.style);
      syncMarkerSize(p, safe);

      const done = pairDecorated(p);
      if (done) { alive.push(done); continue; }   // 样式也一致, 一个 DOM 操作都不做

      // 装饰在但样式过期了(改过标签里的 style): 原地更新, 不重建节点
      const stale = p.open.nextSibling as HTMLElement | null;
      if (stale?.nodeType === 1 && stale.hasAttribute?.('data-mk-deco') && stale.nextSibling === p.close) {
        stale.setAttribute('data-mk-deco', p.style);
        stale.style.cssText = safe;
        alive.push(stale);
        continue;
      }

      // 标签本身彻底藏掉(CSS 在 RichEditor.vue 的 .mk-color), 编辑器里只留彩色文字本身。
      // contenteditable=false 是关键: 让光标进不去这串隐藏文字, 也让输入法碰不到它
      for (const marker of [p.open, p.close]) {
        if (!marker.classList.contains('mk-color')) {
          marker.classList.add('mk-color');
          marker.setAttribute('contenteditable', 'false');
        }
      }

      const mids: Node[] = [];
      let cur = p.open.nextSibling;
      while (cur && cur !== p.close) { mids.push(cur); cur = cur.nextSibling; }
      if (!mids.length) continue;

      const wrap = document.createElement('span');
      wrap.setAttribute('data-mk-deco', p.style);   // 存原文, 给 pairDecorated 比对用
      wrap.style.cssText = safe;
      p.close.parentNode!.insertBefore(wrap, mids[0]);
      for (const m of mids) wrap.appendChild(m);
      alive.push(wrap);
    }

    // 收掉配对已失效的孤立装饰 (用户把某个标签删了)
    for (const el of Array.from(scope.querySelectorAll<HTMLElement>('span[data-mk-deco]'))) {
      if (alive.includes(el)) continue;
      const par = el.parentNode!;
      while (el.firstChild) par.insertBefore(el.firstChild, el);
      par.removeChild(el);
      par.normalize();
    }
  }

  function flush() {
    if (disposed || composing || painting) return;   // 铁律 A
    const todo: HTMLElement[] = [];
    pending.forEach((scope) => {
      // block 被整个替换时 pending 里存的是失效引用, 回退到扫全文才能找到顶替它的新 block
      const targets = (!scope.isConnected || scope === root) ? blocks() : [scope];
      for (const b of targets) if (!isClean(b) && !todo.includes(b)) todo.push(b);   // 铁律 B
    });
    pending.clear();
    if (!todo.length) return;

    painting = true;
    mo?.disconnect();
    const caret = saveCaret();
    todo.forEach(decorate);                          // 铁律 C
    restoreCaret(caret);
    observe();
    painting = false;

    // 补完自检: 期间 Vditor 又改了就再来一轮, 补到收敛
    if (!allClean()) { pending.add(root); queueMicrotask(flush); return; }
  }

  function observe() {
    mo?.disconnect();
    if (disposed) return;
    mo = new MutationObserver((records) => {
      if (composing) return;                         // 铁律 A
      for (const r of records) {
        const b = blockOf(r.target);
        if (b) pending.add(b);
      }
      // 铁律 D: 同步补, 不能 setTimeout —— MutationObserver 回调在微任务里跑,
      // 此时浏览器还没绘制这一帧, 在这里补回去用户就看不到掉色
      if (painting) { queueMicrotask(flush); return; }   // 铁律 E: 忙时只排队不丢弃
      flush();
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
  }

  // 铁律 E: 每帧兜底。rAF 也在绘制前执行, 就算上面两条路都漏了, 最坏只掉 1 帧(~16ms)
  function rafGuard() {
    if (disposed) return;
    rafId = requestAnimationFrame(rafGuard);
    if (composing || painting || allClean()) return;
    pending.add(root);
    flush();
  }

  /**
   * 回车前把光标挪出样式段。
   *
   * 光标停在彩色文字末尾时, 它其实位于「开标签之后、闭标签之前」。直接回车会把闭标签
   * 推到下一个段落 —— 开标签留在上一段, 配对断掉, 颜色全没, 存出来的 markdown 也坏了
   * (变成 `<span style="...">红字\n\n\n</span>` 这种跨段落标签)。
   * 所以按回车时先把光标移到闭标签外面, 让分段发生在样式段之外。
   */
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.shiftKey || composing) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    const node = sel.getRangeAt(0).startContainer;
    const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
    const deco = el?.closest?.('span[data-mk-deco]');
    if (!deco) return;
    const close = deco.nextElementSibling;
    const anchor = close?.classList.contains('mk-color') ? close : deco;
    try {
      const r = document.createRange();
      r.setStartAfter(anchor);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch { /* 定位失败就按原样回车, 顶多是那一处样式散掉, 不影响其它内容 */ }
  }

  const onCompositionStart = () => { composing = true; };
  const onCompositionEnd = () => {
    composing = false;
    setTimeout(() => { pending.add(root); flush(); }, 30);
  };

  root.addEventListener('compositionstart', onCompositionStart);
  root.addEventListener('compositionend', onCompositionEnd);
  root.addEventListener('keydown', onKeydown, true);   // capture: 抢在 Vditor 的回车处理之前
  observe();
  rafId = requestAnimationFrame(rafGuard);
  pending.add(root);
  flush();

  return {
    refresh() { pending.add(root); flush(); },
    destroy() {
      disposed = true;
      cancelAnimationFrame(rafId);
      mo?.disconnect();
      mo = null;
      root.removeEventListener('compositionstart', onCompositionStart);
      root.removeEventListener('compositionend', onCompositionEnd);
      root.removeEventListener('keydown', onKeydown, true);
      painting = true;
      for (const el of Array.from(root.querySelectorAll<HTMLElement>('span[data-mk-deco]'))) {
        const par = el.parentNode!;
        while (el.firstChild) par.insertBefore(el.firstChild, el);
        par.removeChild(el);
        par.normalize();
      }
      for (const m of Array.from(root.querySelectorAll<HTMLElement>('.mk-color'))) {
        m.classList.remove('mk-color');
        m.removeAttribute('contenteditable');
      }
    },
  };
}

/**
 * 给选中的文字套一层内联样式标签。
 * 返回要插入的 markdown 文本, 由调用方用 execCommand 插进去 (走浏览器原生插入才能进撤销栈)。
 *
 * **标签内部绝不能含换行符** —— markdown 会把标签里的换行当成段落分隔, 开标签留在上一段、
 * 闭标签跑到下一段, 配对直接失效(颜色不显示, 存出来的 markdown 也坏了)。
 * 所以这里按行拆开, 每行各套一个标签, 换行符留在标签外面。
 *
 * 这种"一个段落里含软换行"的内容最常见的来源是**从外部粘贴多行文本**:
 * 编辑器里按回车得到的是两个 <p>, 而粘贴 `A\nB` 得到的是 `<p>A\nB</p>` —— 行间距不同,
 * 结构也不同, 蘑菇 2026-08-03 就是这么撞出来的。
 */
export function wrapWithStyle(selectedText: string, style: string): string {
  return selectedText
    .split('\n')
    .map((line) => (line.trim() ? `<span style="${style}">${line}</span>` : line))
    .join('\n');
}

/** 剥掉一段 markdown 里所有的内联样式标签 */
export function stripInlineStyle(md: string): string {
  return md.replace(/<span\s+style="[^"]*"\s*>/gi, '').replace(/<\/span>/gi, '');
}
