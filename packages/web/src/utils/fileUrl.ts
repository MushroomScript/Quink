// File URL 拼前缀工具
//
// 后端约定: files.url + 笔记里 markdown link 的 url 都只存裸文件名(如 "语音备忘.m4a"),
// 前端在渲染层拼上 `/api/uploads/` 前缀,让 <img> / <a> / <audio> 等能正确加载。
//
// 兼容: 老数据(已带 / 前缀)和新数据(裸名)都能识别——detect 是否以 `/`/`http(s)://`/`data:`/`blob:` 开头
// 则视为 absolute URL 不动,否则当裸文件名拼前缀。

export function resolveFileUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (url.startsWith('/') || /^(https?|data|blob):/.test(url)) return url;
  return '/api/uploads/' + url;
}

// markdown 渲染入口预处理: 把 `](xxx.ext)` 这种"括号内裸文件名"拼成 `](/api/uploads/xxx.ext)`,
// 让 md2html 后生成的 <a href> / <img src> / <audio src> 都是绝对路径,点击下载/预览正常。
//
// 识别规则: 括号内不含 / ? # : 等 URL 特殊字符,但含 . 且后跟 1-8 个字母数字(扩展名)。
// 不影响:
//   - `[ref](?ref=xxx)` 引用链接(? 在排除字符里)
//   - `[google](https://google.com)` 外链(: 在排除字符里)
//   - `[ref](/note/abc)` 内部路由(/ 在排除字符里)
const MD_FILE_LINK_RE = /\]\(([^)\/?#:\s][^)\/?#:\s]*\.[A-Za-z0-9]{1,8})\)/g;

export function resolveMarkdownFileUrls(md: string): string {
  if (!md) return md;
  return md.replace(MD_FILE_LINK_RE, '](/api/uploads/$1)');
}

// 反向: 把 `](/api/uploads/xxx)` 剥回 `](xxx)`,用于编辑器 getValue 后保存进 DB(保持裸名约定)。
// 编辑器内部 markdown 始终用 absolute path 让 Vditor IR 渲染 img/anchor 能加载,
// 保存时剥前缀,DB 永远裸名。
export function stripMarkdownFileUrls(md: string): string {
  if (!md) return md;
  return md.replace(/\]\(\/api\/uploads\/([^)\s]+)\)/g, ']($1)');
}
