// File URL 拼前缀工具
//
// 后端约定: files.url + 笔记里 markdown link 的 url 都只存裸文件名(如 "语音备忘.m4a"),
// 前端在渲染层拼上 `/api/uploads/` 前缀,让 <img> / <a> / <audio> 等能正确加载。
//
// 兼容: 老数据(已带 / 前缀)和新数据(裸名)都能识别——detect 是否以 `/`/`http(s)://`/`data:`/`blob:` 开头
// 则视为 absolute URL 不动,否则当裸文件名拼前缀。
//
// 群组文件授权: /api/uploads/* 后端中间件按 noteShares 鉴权. <img> 不能带 Authorization header,
// 走 query token 模式: url 尾部拼 ?token=<jwt>. token 跟 localStorage quink_token 共用 SSE 同一套.

function getAuthToken(): string | null {
  return localStorage.getItem('quink_token');
}

function withToken(url: string): string {
  // 已含 query 用 & 拼; 否则用 ?
  const token = getAuthToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

export function resolveFileUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (url.startsWith('/') || /^(https?|data|blob):/.test(url)) return url;
  return withToken('/api/uploads/' + url);
}

// 缩略图 URL: 上传时后端 sharp 生成 <裸名>.thumb.jpg (长边 600). 头像 / 资源缩略图 / 笔记小图用.
// 命名跟 heicThumb 一致. 历史文件没 thumb → 浏览器 404 → 调用方 <img @error> 降级到原图.
// 外链 (http(s)/blob/data) 无法 thumb, 原样返回让调用方按原图渲染.
export function resolveFileThumbUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (/^(https?|data|blob):/.test(url)) return url;
  const bare = url.startsWith('/api/uploads/') ? url.slice('/api/uploads/'.length).replace(/\?.*$/, '') : url.replace(/^\/+/, '');
  if (!bare) return '';
  return withToken('/api/uploads/' + bare + '.thumb.jpg');
}

// <img :src="resolveFileThumbUrl(url)" @error="thumbErrorFallback($event, resolveFileUrl(url))">
// thumb 404 (历史文件 / sharp 失败) 时一次性切回原图; dataset 标记防原图也 404 无限循环.
export function thumbErrorFallback(e: Event, originalUrl: string): void {
  const t = e.target as HTMLImageElement;
  if (t.dataset.thumbFallback === '1') return;
  t.dataset.thumbFallback = '1';
  t.src = originalUrl;
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
  const token = getAuthToken();
  const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
  return md.replace(MD_FILE_LINK_RE, `](/api/uploads/$1${suffix})`);
}

// 反向: 把 `](/api/uploads/xxx)` 剥回 `](xxx)`,用于编辑器 getValue 后保存进 DB(保持裸名约定)。
// 编辑器内部 markdown 始终用 absolute path 让 Vditor IR 渲染 img/anchor 能加载,
// 保存时剥前缀 + 剥 query token, DB 永远裸名。
export function stripMarkdownFileUrls(md: string): string {
  if (!md) return md;
  // 剥 /api/uploads/ 前缀; 同时剥 ?token=... 后缀防 token 进 DB
  return md.replace(/\]\(\/api\/uploads\/([^)\s?]+)(?:\?[^)\s]*)?\)/g, ']($1)');
}

// 文件不存在的视觉提示:
// - <img src="/api/uploads/*"> 加载失败 → App.vue 全局 error capture listener replaceWith 红色占位 span
//   (CSS .quink-missing-file 在 style.css 内). 跟历史 inline onerror= 方案相比 CSP 友好, 全渲染入口自动覆盖.
// - <a href="/api/uploads/*"> 点击 → App.vue 全局 click handler 走 desk.openAttachment IPC (桌面端) 或 HEAD 预检 (Web 端), 404 toast.
// - <audio> 胶囊播放失败 → utils/audio.ts 的 audio.error handler toast "录音文件不存在".
