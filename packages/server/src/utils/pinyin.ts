import { pinyin } from 'pinyin-pro';

/**
 * 把中文 text 转成可搜索串: 全拼 + 首字母(都用默认读音,不穷举多音字).
 *
 * 故意不穷举多音字 —— 蘑菇接受"重做不能搜 cxcz" 换 "种/单"等罕用读音字不会误命中.
 * 即每字按 pinyin-pro 字典默认读音, "重"=zhong (zhòng/chóng 选 zhong),
 * "撤销重做"全拼=chexiaozhongzuo / 首字母=cxzz, 搜 cxcz 不命中.
 *
 * 用 chars.map 每字单独调 pinyin 避免 nonZh:'consecutive' 让连续标点/空格合并 token
 * 导致索引错位(前端高亮也是同样原因改成逐字算).
 */
export function toPinyinSearchable(text: string): string {
  if (!text) return '';
  const chars = [...text];
  const fullArr = chars.map(c => {
    if (!/[一-鿿]/.test(c)) return c.toLowerCase();
    return pinyin(c, { toneType: 'none' }).toLowerCase();
  });
  const full = fullArr.join('');
  const initials = fullArr.map(p => p[0] || '').join('');
  return `${full} ${initials}`;
}
