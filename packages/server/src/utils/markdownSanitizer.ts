// Markdown 层危险 URI 拦截 (深度防御, 跟前端 DOMPurify 双层挡).
// 覆盖:
// - markdown link  [label](url)   → url 里 javascript: / vbscript: / data:(非 image) → 替换成 #blocked
// - markdown image ![alt](url)   → 同上
// - autolink       <url>          → 若匹配危险 scheme → 剥成纯文本 (# blocked <url>)
// - reference link [label]: url   → 同上
//
// 不做的:
// - HTML 标签 (`<script>` / `<iframe>` / on*= handler) —— 前端 DOMPurify 层拦
// - 后端不做完整 HTML sanitize 是为了保留 markdown 里合法的裸 HTML 场景 (用户自己写的 `<details>` 等)

const DANGEROUS_URL_RE = /^(?:javascript|vbscript):/i;
const DATA_URL_RE = /^data:/i;
const DATA_IMAGE_RE = /^data:image\//i;

function isDangerousUrl(raw: string): boolean {
  const trimmed = raw.trim().toLowerCase();
  if (DANGEROUS_URL_RE.test(trimmed)) return true;
  if (DATA_URL_RE.test(trimmed) && !DATA_IMAGE_RE.test(trimmed)) return true;
  return false;
}

export function sanitizeUserMarkdown(text: string): string {
  if (!text) return text;
  let out = text;
  // markdown link / image: [label](url) ![alt](url)
  out = out.replace(/(\!?\[[^\]]*\])\(([^)]+)\)/g, (full, label, url) => {
    if (isDangerousUrl(url)) return `${label}(#blocked)`;
    return full;
  });
  // reference-style link 定义: [id]: url
  out = out.replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/gm, (full, prefix, url) => {
    if (isDangerousUrl(url)) return `${prefix}#blocked`;
    return full;
  });
  // autolink: <javascript:...> / <vbscript:...> / <data:...>
  out = out.replace(/<((?:javascript|vbscript|data):[^>]*)>/gi, (_, url) => {
    if (isDangerousUrl(url)) return '`#blocked`';
    return `<${url}>`;
  });
  return out;
}
