// HEIC 缩略图 URL helper. 后端上传 HEIC 时同步生成 <basename>.thumb.jpg (libheif-js + jpeg-js),
// 前端直接 GET 这个 thumb URL, 不再客户端转码 + 持久化, 体积省 ~150KB gzip (heic-to + electron IPC).
// 后端启动时也 backfill 老 HEIC, 多端访问共享同一份 thumb (服务器存盘)

export function heicThumbUrl(originalUrl: string): string {
  return originalUrl + '.thumb.jpg';
}
