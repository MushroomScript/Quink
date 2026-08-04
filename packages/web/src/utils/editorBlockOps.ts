// Vditor IR 编辑器的表格 / 块操作。纯 DOM 操作, 不依赖 Vue, 不碰 Vditor 内部 API。
//
// 原理 (已 POC 验证): 直接改编辑区 DOM, 然后派一个 input 事件, Vditor 会自己把 DOM 序列化回
// markdown 并记进撤销栈 —— getValue() 立刻正确, Ctrl+Z 也能正常回退。
// 好处是不用 import Vditor 内部模块 (那些要传 IVditor 实例、依赖一堆内部文件、升级会变)。
//
// 两个必须遵守的点 (POC 踩到的):
//   1. 派 input 事件前必须 focus 编辑区, 否则 Vditor 的 input handler 内部调
//      getSelection().getRangeAt(0) 会抛 IndexSizeError
//   2. 块上下移要跳过"内容为空"的块 —— markdown 段落之间常有空 <p>, 跟它换位置
//      序列化结果不变, 用户点一次看起来没反应

/** markdown 表格的列对齐, 对应分隔行的 `:---` / `:---:` / `---:` */
export type ColumnAlign = 'left' | 'center' | 'right';

/** 从任意节点(通常是光标位置)往上找单元格 */
export function findCell(node: Node | null): HTMLTableCellElement | null {
  const el = node?.nodeType === 3 ? node.parentElement : (node as HTMLElement | null);
  return el?.closest?.('th, td') ?? null;
}

/** 从任意节点往上找表格 */
export function findTable(node: Node | null): HTMLTableElement | null {
  const el = node?.nodeType === 3 ? node.parentElement : (node as HTMLElement | null);
  return el?.closest?.('table') ?? null;
}

/** 找光标所在的顶层块 (编辑区的直接子元素), 块上下移用 */
export function findBlock(node: Node | null, root: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = node?.nodeType === 3 ? node.parentElement : (node as HTMLElement | null);
  while (el && el.parentElement !== root) el = el.parentElement;
  return el && el.parentElement === root ? el : null;
}

/**
 * 改完 DOM 后确保光标在编辑区内。
 *
 * 【绝对不要在这里派 DOM 的 input 事件】—— 那会触发 Vditor 绑在编辑区上的输入处理,
 * 它会把当前 block 整个重新解析。整行移动这种结构性改动不符合它的假设,
 * WYSIWYG 下实测直接把表格解析成了纯文本段落("| 水果 | 数量 |" 这样的字面量), 表格就没了。
 *
 * 让编辑器感知变更要走另一条路: Vditor 自己改表格 DOM 后调的是 execAfterRender,
 * 只记撤销栈 + 触发 options.input 回调, **不重新解析 DOM**。
 * 我们在 RichEditor.vue 的 afterBlockOp() 里做等价的事, 由调用方在改完 DOM 后调。
 */
export function commit(root: HTMLElement) {
  const sel = window.getSelection();
  const inside = !!sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).startContainer);
  if (!inside) root.focus();
}

/** 把光标放进某个元素 (操作完让用户接着打字, 也让悬浮控件继续锚在这) */
export function focusCell(el: HTMLElement, toStart = false) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(toStart);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** 单元格在所在行里的列序号 */
function columnIndexOf(cell: HTMLTableCellElement): number {
  let i = 0;
  let prev = cell.previousElementSibling;
  while (prev) { i++; prev = prev.previousElementSibling; }
  return i;
}

/**
 * 单元格在整张表里的坐标(第几行第几列)。
 *
 * 为什么需要它: commit() 会让 Vditor 重渲染整个 block, 把表格 DOM 整个重建 ——
 * 操作前拿到的单元格引用全部失效, 再拿它设光标就等于把光标丢到已 detach 的节点上
 * (实测症状: WYSIWYG 下点"本行上移", 光标飘走, 接着整张表被序列化坏掉不见了)。
 * 所以要用"坐标"这种能跨重建存活的方式记位置, 重建后再按坐标找回来。
 */
export function cellCoord(cell: HTMLTableCellElement): { r: number; c: number } | null {
  const table = findTable(cell);
  if (!table) return null;
  const row = cell.parentElement as HTMLTableRowElement;
  const r = Array.prototype.indexOf.call(table.rows, row);
  return r < 0 ? null : { r, c: columnIndexOf(cell) };
}

/** 按坐标取单元格, 越界时夹到边界(比如删了最后一行后还想把光标放回去) */
export function cellAt(table: HTMLTableElement, coord: { r: number; c: number }): HTMLTableCellElement | null {
  if (!table.rows.length) return null;
  const row = table.rows[Math.min(coord.r, table.rows.length - 1)];
  if (!row || !row.cells.length) return null;
  return row.cells[Math.min(coord.c, row.cells.length - 1)] ?? null;
}

/** 造一行, 单元格数量和对齐跟着参照行走 */
function buildRow(sample: HTMLTableRowElement, tag: 'td' | 'th'): HTMLTableRowElement {
  const tr = document.createElement('tr');
  for (let i = 0; i < sample.cells.length; i++) {
    const c = document.createElement(tag);
    const align = sample.cells[i].getAttribute('align');
    if (align) c.setAttribute('align', align);
    // 空单元格塞一个空格: 纯空 td 在 Vditor 序列化时可能塌掉, 光标也进不去
    c.textContent = ' ';
    tr.appendChild(c);
  }
  return tr;
}

// ── 行操作 ──
// 注意 markdown 表格必须有且只有一行表头, 所以表头行不能删、不能参与上下移,
// 在表头位置"上方插行"也只能插到 tbody 顶部(否则会变成两行表头, 序列化后表格散架)。

export function insertRowAbove(cell: HTMLTableCellElement): HTMLTableCellElement | null {
  const tr = cell.parentElement as HTMLTableRowElement;
  const table = findTable(cell);
  if (!table) return null;
  const row = buildRow(tr, 'td');
  if (cell.tagName === 'TH') {
    // 光标在表头 → 插到 tbody 最前面
    const tbody = table.tBodies[0] ?? table.appendChild(document.createElement('tbody'));
    tbody.insertBefore(row, tbody.firstChild);
  } else {
    tr.parentElement!.insertBefore(row, tr);
  }
  return row.cells[Math.min(columnIndexOf(cell), row.cells.length - 1)] ?? null;
}

export function insertRowBelow(cell: HTMLTableCellElement): HTMLTableCellElement | null {
  const tr = cell.parentElement as HTMLTableRowElement;
  const table = findTable(cell);
  if (!table) return null;
  const row = buildRow(tr, 'td');
  if (cell.tagName === 'TH') {
    const tbody = table.tBodies[0] ?? table.appendChild(document.createElement('tbody'));
    tbody.insertBefore(row, tbody.firstChild);
  } else {
    tr.parentElement!.insertBefore(row, tr.nextSibling);
  }
  return row.cells[Math.min(columnIndexOf(cell), row.cells.length - 1)] ?? null;
}

/** 表头行不能删 (markdown 表格没表头就不成立), 返回 false 表示没删 */
export function deleteRow(cell: HTMLTableCellElement): boolean {
  if (cell.tagName === 'TH') return false;
  const tr = cell.parentElement as HTMLTableRowElement;
  const tbody = tr.parentElement!;
  tr.remove();
  if (!tbody.children.length) tbody.remove();
  return true;
}

/** 跟上一行交换。表头行不动, tbody 第一行也没法再上移 */
export function moveRowUp(cell: HTMLTableCellElement): boolean {
  if (cell.tagName === 'TH') return false;
  const tr = cell.parentElement as HTMLTableRowElement;
  const prev = tr.previousElementSibling;
  if (!prev) return false;
  tr.parentElement!.insertBefore(tr, prev);
  return true;
}

export function moveRowDown(cell: HTMLTableCellElement): boolean {
  if (cell.tagName === 'TH') return false;
  const tr = cell.parentElement as HTMLTableRowElement;
  const next = tr.nextElementSibling;
  if (!next) return false;
  tr.parentElement!.insertBefore(next, tr);
  return true;
}

// ── 列操作 ──

function insertColumn(cell: HTMLTableCellElement, where: 'beforebegin' | 'afterend'): HTMLTableCellElement | null {
  const table = findTable(cell);
  if (!table) return null;
  const index = columnIndexOf(cell);
  let focusTarget: HTMLTableCellElement | null = null;
  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i];
    const ref = row.cells[Math.min(index, row.cells.length - 1)];
    if (!ref) continue;
    const isHead = ref.tagName === 'TH';
    const c = document.createElement(isHead ? 'th' : 'td');
    c.textContent = ' ';
    ref.insertAdjacentElement(where, c);
    if (!focusTarget && !isHead) focusTarget = c;
  }
  return focusTarget;
}

export const insertColumnLeft = (cell: HTMLTableCellElement) => insertColumn(cell, 'beforebegin');
export const insertColumnRight = (cell: HTMLTableCellElement) => insertColumn(cell, 'afterend');

/** 只剩一列时不给删 (markdown 表格至少要一列) */
export function deleteColumn(cell: HTMLTableCellElement): boolean {
  const table = findTable(cell);
  if (!table || !table.rows.length || table.rows[0].cells.length <= 1) return false;
  const index = columnIndexOf(cell);
  for (let i = 0; i < table.rows.length; i++) {
    table.rows[i].cells[index]?.remove();
  }
  return true;
}

/** 整列对齐。markdown 表格的对齐写在分隔行里, DOM 上体现为整列 th/td 的 align 属性 */
export function setColumnAlign(cell: HTMLTableCellElement, align: ColumnAlign) {
  const table = findTable(cell);
  if (!table) return;
  const index = columnIndexOf(cell);
  for (let i = 0; i < table.rows.length; i++) {
    table.rows[i].cells[index]?.setAttribute('align', align);
  }
}

/** 当前列的对齐 (给菜单显示选中态用) */
export function getColumnAlign(cell: HTMLTableCellElement): ColumnAlign | null {
  const v = cell.getAttribute('align');
  return v === 'left' || v === 'center' || v === 'right' ? v : null;
}

export function deleteTable(cell: HTMLTableCellElement): boolean {
  const table = findTable(cell);
  if (!table) return false;
  table.remove();
  return true;
}

// ── 块上下移 ──

/** 没有文字但视觉上有内容的元素, 这些块不能当空块跳过 */
const VISIBLE_NO_TEXT = 'img, hr, table, input, iframe, video, audio';

/**
 * 这个块是不是"空块"(markdown 段落间的空 <p>)。空块要跳过, 否则跟它换了位置
 * 序列化结果一样, 用户点一次看起来没反应。
 *
 * `matches` 那半不能少 —— `querySelector` 只找**后代**, 裸的 `<hr>` 自己不算自己的后代,
 * 少了它分隔线会被当空块跳过 (实测 `甲/---/乙` 里乙上移, 直接越过分隔线跳到甲前面)。
 */
function isEmptyBlock(el: Element): boolean {
  if ((el.textContent || '').trim()) return false;
  return !el.matches(VISIBLE_NO_TEXT) && !el.querySelector(VISIBLE_NO_TEXT);
}

/** 相邻的非空块 */
function siblingBlock(el: HTMLElement, dir: 'prev' | 'next'): HTMLElement | null {
  let sib = dir === 'prev' ? el.previousElementSibling : el.nextElementSibling;
  while (sib && isEmptyBlock(sib)) {
    sib = dir === 'prev' ? sib.previousElementSibling : sib.nextElementSibling;
  }
  return (sib as HTMLElement) ?? null;
}

export function canMoveBlock(block: HTMLElement, dir: 'up' | 'down'): boolean {
  return !!siblingBlock(block, dir === 'up' ? 'prev' : 'next');
}

export function moveBlockUp(block: HTMLElement): boolean {
  const target = siblingBlock(block, 'prev');
  if (!target) return false;
  block.parentElement!.insertBefore(block, target);
  return true;
}

export function moveBlockDown(block: HTMLElement): boolean {
  const target = siblingBlock(block, 'next');
  if (!target) return false;
  block.parentElement!.insertBefore(target, block);
  return true;
}
