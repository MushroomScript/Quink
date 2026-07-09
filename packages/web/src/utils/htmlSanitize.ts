// v-html 前统一走一遍 DOMPurify (S2 REVIEW-TODO 修复).
// 后端 sanitizeUserMarkdown 已拦 markdown link 层的 javascript:/vbscript:/data: 前缀,
// 这里额外拦裸 HTML `<a href="javascript:">` / on* handler / script / iframe 等.
//
// 保留 Vditor / lute 输出所需的:
// - <audio controls> / <source> (语音备忘胶囊)
// - <svg><path> (refLink 图钉 inject)
// - <span class="note-ref-link" data-ref="..."> (refLink 引用块)
// - <input type="checkbox" checked disabled> (task list)
// - <mark class="quink-hl-*"> (搜索高亮)

import DOMPurify from 'dompurify';

const PURIFY_CONFIG = {
  ADD_TAGS: ['audio', 'source'],
  ADD_ATTR: ['target', 'controls', 'controlsList', 'preload'],
  // 允许 http/https/mailto/tel + data:image/*; 拒 javascript:/vbscript:/data:非 image
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|callto|cid|xmpp):|data:image\/|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string;
}
