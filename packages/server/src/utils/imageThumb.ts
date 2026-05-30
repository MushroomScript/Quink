// 普通图片 (jpg/png/webp/gif) → JPEG 缩略图生成. 用 sharp (libvips).
// 调用方:
//   - upload.ts 上传图片 / 头像后同步生成 <basename>.thumb.jpg
//   - 前端 resolveFileThumbUrl 拼出 thumb URL, <img onerror> 降级到原图兜底没生成 thumb 的历史文件
//
// 命名约定: foo.png → foo.png.thumb.jpg (跟 heicThumb 同一约定, 路径不冲突)

import * as fs from 'fs';
import sharp from 'sharp';

const MAX_DIM = 600;          // 长边像素上限. 头像 80/36px / 资源缩略图 128px, 长边 600 给 zoom 200% 也够清晰
const JPEG_QUALITY = 80;

// 缩略图自身扩展名约定是 .thumb.jpg, 输入 filename 含 .thumb. 时跳过 (防对 thumb 再生成 thumb)
export function isThumbableImage(filename: string): boolean {
  if (/\.thumb\.jpg$/i.test(filename)) return false;
  return /\.(jpe?g|png|webp|gif)$/i.test(filename);
}

export function imageThumbPath(originalPath: string): string {
  return originalPath + '.thumb.jpg';
}

// sharp 处理: resize 长边限 MAX_DIM (withoutEnlargement 防把小图放大) → jpeg quality 80 → 写盘.
// 出错 throw, 调用方自行 try/catch swallow (前端 onError 会兜底显示原图)
export async function generateImageThumb(
  originalPath: string,
  outPath: string = imageThumbPath(originalPath),
): Promise<void> {
  await sharp(originalPath, { animated: false })  // gif 只取首帧
    .rotate()                                     // 按 EXIF orientation 自动转, 避免手机竖图横显示
    .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toFile(outPath);
}
