import { pinyin } from 'pinyin-pro';

/**
 * 拼音匹配: candidate 包含 query 的字面 OR 全拼 OR 首字母,任一满足返回 true.
 * 用于前端短文本列表过滤(标签 / 文件名等),让用户输入英文 zb / zhoubao 命中"周报".
 *
 * - 字面: candidate.toLowerCase().includes(q) — 英文搜英文 + 中文搜中文
 * - 全拼: "周报学习" → "zhoubaoxuexi",query="zhou" 命中
 * - 首字母: "周报学习" → "zbxx",query="zb"/"zbxx" 命中
 *
 * 非中文字符(英文/数字/符号)pinyin-pro 默认原样保留,自动支持纯英文混合输入。
 *
 * 性能: 每次调用都会算 candidate 的拼音,如果列表很大(>1000)且每次输入都重新过滤,
 * 考虑加 WeakMap 缓存。当前用法(标签 ~几十条 / 资源页 ~几百条)直接算够用
 */
export function pinyinMatch(candidate: string, query: string): boolean {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (!candidate) return false;
  // 字面
  if (candidate.toLowerCase().includes(q)) return true;
  // 每字单独调 pinyin 避免 nonZh:'consecutive' 让连续标点/空格合并 token 导致错位
  const chars = [...candidate];
  const fullArr = chars.map(c => {
    if (!/[一-鿿]/.test(c)) return c.toLowerCase();
    return pinyin(c, { toneType: 'none' }).toLowerCase();
  });
  // 全拼
  if (fullArr.join('').includes(q)) return true;
  // 首字母
  return fullArr.map(p => p[0] || '').join('').includes(q);
}

/**
 * 在 text 里找出所有 query 拼音命中的字符位置区间(用 chars 数组索引,处理 emoji 等 surrogate pair).
 * 既包含字面匹配,也包含拼音匹配(全拼 / 首字母 / 混合).
 *
 * 算法: 字面匹配先扫一遍; 拼音匹配从每个起始位置贪心消耗 query —— 每个字尝试"全拼前缀"或"首字母",
 * 完全消耗 query 后记录区间。重叠区间合并避免重复 <mark>.
 *
 * 例: text="今天周报学习中", query="zb" → 找到 "周报" [2,4) 区间
 * 例: text="今天周报学习中", query="zhoubao" → 找到 "周报" [2,4) 区间
 * 例: text="今天周报学习中", query="zhouxx" → 不能消耗(zhou 后接 xx 跟 "学习" 首字母对上 → 命中 "周学" 或匹配失败)
 */
export function findPinyinMatchPositions(text: string, query: string): Array<[number, number]> {
  const q = query.trim().toLowerCase();
  if (!q || !text) return [];
  const chars = [...text]; // 处理 surrogate pair: emoji 单元素

  const ranges: Array<[number, number]> = [];

  // 1. 字面匹配 (lower case includes): 英文 query 直接搜文本内英文,中文 query 直接搜中文
  const lower = chars.map(c => c.toLowerCase()).join('');
  // chars 转 lowerString 时 chars 长度 = lowerString 长度 (BMP 字符 1:1; emoji surrogate pair 用 spread 已合并为 1 chars 元素, 但 lowerString 拼回会变多 byte —— 这里用 chars index 不用 string index)
  // 用 chars-by-chars 比较 q (转 array)
  const qChars = [...q];
  outer:
  for (let i = 0; i <= chars.length - qChars.length; i++) {
    for (let j = 0; j < qChars.length; j++) {
      if (chars[i + j].toLowerCase() !== qChars[j]) continue outer;
    }
    ranges.push([i, i + qChars.length]);
  }

  // 2. 拼音匹配: 每个字单独调 pinyin 保证跟 chars 1:1 对齐(整段调 nonZh:'consecutive' 会
  // 把连续空格/标点合并 token → pyFull 长度 ≠ chars → 索引错位 → 错误高亮邻字).
  // 不穷举多音字: 每字只用默认读音, 避免"种 chong / 单 chan"等罕用古音被命中.
  // 代价: "重做"搜 cxcz 不命中("重"按 zhong) —— 接受换全局零误命中.
  const pyFull: string[] = chars.map(c => {
    if (!/[一-鿿]/.test(c)) return c.toLowerCase();
    return pinyin(c, { toneType: 'none' }).toLowerCase();
  });

  for (let start = 0; start < chars.length; start++) {
    let qIdx = 0;
    let i = start;
    while (qIdx < q.length && i < chars.length) {
      const py = pyFull[i];
      if (!py) break;
      // 全拼: 当前字读音是 query 当前位置完整前缀
      if (q.startsWith(py, qIdx)) {
        qIdx += py.length;
        i++;
        continue;
      }
      // 半拼(只可能是 q 最后一段): q 剩余 < py 长度 AND py 以 q 剩余开头.
      // 例: q="zhouba" / text="周报" → "周"消耗"zhou"后剩"ba",bao.startsWith("ba")→ 消耗剩余命中
      const remainingStr = q.slice(qIdx);
      if (remainingStr.length > 0 && py.length > remainingStr.length && py.startsWith(remainingStr)) {
        qIdx = q.length;
        i++;
        continue;
      }
      // 首字母: 当前字默认读音首字母 = query 当前字符
      if (py[0] === q[qIdx]) {
        qIdx++;
        i++;
        continue;
      }
      break;
    }
    if (qIdx >= q.length && i > start) {
      ranges.push([start, i]);
    }
  }

  // 3. 合并重叠区间 (字面 + 拼音可能命中同一段)
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  return merged;
}

/**
 * 在 text 里把所有 query 命中位置(字面 + 拼音)包成 <mark class="search-highlight"> 标签.
 * 调用前确保 text 是纯文本(不含 HTML 标签),否则会污染 HTML 结构 —— 上层用"标签 vs 文本"
 * regex 分流再调用本函数即可(NoteCard.vue 的高亮逻辑)
 */
export function highlightTextByPinyin(text: string, query: string): string {
  const ranges = findPinyinMatchPositions(text, query);
  if (ranges.length === 0) return text;
  const chars = [...text];
  // 倒序注入避免索引偏移
  const out: string[] = [];
  let cursor = chars.length;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [s, e] = ranges[i];
    out.unshift(chars.slice(e, cursor).join(''));
    out.unshift('</mark>');
    out.unshift(chars.slice(s, e).join(''));
    out.unshift('<mark class="search-highlight">');
    cursor = s;
  }
  out.unshift(chars.slice(0, cursor).join(''));
  return out.join('');
}
