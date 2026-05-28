// HEIC → JPEG 缩略图生成 (服务端实现, 替代客户端 heic-to).
// 用 libheif-js (WASM) decode HEIC 拿到 RGBA, 再用 jpeg-js encode 成 jpeg buffer 写盘.
// 完全纯 JS/WASM 实现, 不需要服务器装 libheif/libvips 系统级软件, 跟 Quink "轻便部署" 一致.
// 调用方:
//   - upload.ts 上传 HEIC 后同步生成 <basename>.thumb.jpg
//   - server 启动时(或按需 endpoint) 扫历史 HEIC 文件批量补 thumb

import * as fs from 'fs';
import * as path from 'path';
// 用 wasm-bundle 版本: 把 .wasm 内嵌到 .js 里 (避免 libheif-js/wasm 用相对路径 readFileSync 找 wasm
// 文件时因为 server cwd 不对而 crash). pure-js 版本慢几倍, 不可接受
import libheif from 'libheif-js/wasm-bundle';
import jpegJs from 'jpeg-js';

const MAX_DIM = 1500;

export function isHeicFilename(filename: string): boolean {
  return /\.(heic|heif)$/i.test(filename);
}

// 给原 HEIC 文件路径算 thumb 路径: foo.heic → foo.heic.thumb.jpg
export function heicThumbPath(originalPath: string): string {
  return originalPath + '.thumb.jpg';
}

// 同步读 HEIC 文件 → libheif decode → 长边限 MAX_DIM 缩放 → jpeg encode 写盘.
// 阻塞调用 (但 wasm 单张 1-3s, 个人使用场景接受). 出错 throw, 调用方自行 try/catch
export async function generateHeicThumb(heicPath: string, outPath: string = heicThumbPath(heicPath)): Promise<void> {
  const buffer = fs.readFileSync(heicPath);
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(buffer);
  if (!images || images.length === 0) throw new Error('HEIF decode returned 0 images');
  const image = images[0];
  const srcW = image.get_width();
  const srcH = image.get_height();

  // 拿到 raw RGBA buffer (libheif display 是 callback 风格)
  const raw: { data: Uint8ClampedArray; width: number; height: number } = await new Promise((resolve, reject) => {
    image.display({ data: new Uint8ClampedArray(srcW * srcH * 4), width: srcW, height: srcH }, (display: any) => {
      if (!display) return reject(new Error('HEIF display callback returned null'));
      resolve(display);
    });
  });

  // 限长边 1500px 缩放. 缩放算法用最简单的 nearest neighbor (jpeg-js 不提供 resize),
  // 后续渲染层 (前端 <img object-cover>) 也会再次插值, 这里 nearest 够用
  const ratio = Math.min(MAX_DIM / srcW, MAX_DIM / srcH, 1);
  const dstW = Math.round(srcW * ratio);
  const dstH = Math.round(srcH * ratio);
  let finalData: Uint8Array;
  if (ratio === 1) {
    finalData = Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
  } else {
    const dst = new Uint8Array(dstW * dstH * 4);
    for (let y = 0; y < dstH; y++) {
      const sy = Math.floor(y / ratio);
      for (let x = 0; x < dstW; x++) {
        const sx = Math.floor(x / ratio);
        const srcIdx = (sy * srcW + sx) * 4;
        const dstIdx = (y * dstW + x) * 4;
        dst[dstIdx] = raw.data[srcIdx];
        dst[dstIdx + 1] = raw.data[srcIdx + 1];
        dst[dstIdx + 2] = raw.data[srcIdx + 2];
        dst[dstIdx + 3] = raw.data[srcIdx + 3];
      }
    }
    finalData = dst;
  }

  const jpeg = jpegJs.encode({ data: finalData, width: ratio === 1 ? srcW : dstW, height: ratio === 1 ? srcH : dstH }, 90);
  fs.writeFileSync(outPath, jpeg.data);
}

// 扫整个 uploads 目录, 给所有 HEIC 文件批量补 thumb (跳过已存在的). 在 server 启动时调一次,
// 处理升级前已上传的 HEIC. 异步执行不阻塞启动
export async function backfillHeicThumbs(uploadsDir: string): Promise<void> {
  let files: string[];
  try {
    files = fs.readdirSync(uploadsDir);
  } catch {
    return;
  }
  const heics = files.filter((f) => isHeicFilename(f));
  let generated = 0;
  for (const f of heics) {
    const heicPath = path.join(uploadsDir, f);
    const thumbPath = heicThumbPath(heicPath);
    if (fs.existsSync(thumbPath)) continue;
    try {
      await generateHeicThumb(heicPath, thumbPath);
      generated++;
    } catch (e) {
      console.warn('[backfillHeicThumbs]', f, (e as any)?.message);
    }
  }
  if (generated > 0) console.log(`[backfillHeicThumbs] generated ${generated} thumbs (skipped ${heics.length - generated} existed)`);
}
