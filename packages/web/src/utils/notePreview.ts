// 笔记列表 / 回收站卡片是"预览", 不必全量渲染. 渲染前预处理:
// ① 剥掉 base64 内联图 (历史大笔记几十万字符 base64, 全量 md2html 卡死首屏; 新粘贴已走上传换 url 不产生, 此为历史 / 极端兜底)
// ② 截断到覆盖卡片可见区的长度 (line-clamp 视觉再截一次). 正常短笔记 < 阈值原样返回.
//
// 关键: NoteCard / Trash 卡片渲染 + useMasonry estimateHeight 高度估算必须用同一套.
// 否则估算按原始 (未截断) content 数图 → 高估那条长笔记 → 瀑布流以为那列很高不再分配 → 那列空着只剩 2 个 (蘑菇 2026-06-29 踩).
export function previewMarkdown(content: string, maxLen = 2000): string {
  if (!content) return content;
  const stripped = content.replace(/!\[[^\]]*\]\(data:[^)]*\)/gi, '');
  return stripped.length > maxLen ? stripped.slice(0, maxLen) : stripped;
}
