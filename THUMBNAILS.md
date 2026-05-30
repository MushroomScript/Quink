# 静态图片缩略图体系

头像 / 资源缩略图 / 笔记小图等"显示尺寸 < 200px 但原图可能几 MB"的场景统一走这套：**后端上传时生成 .thumb.jpg → 前端 `<img>` 优先用 thumb URL → 历史文件没 thumb 时 `@error` 一次性降级原图**。

这份文档不自动加载。改头像 / 资源缩略图 / `upload.ts` 的 sharp 行为 / 加新图片显示场景前来读。

## 为什么要做

直接显示大原图缩到小尺寸会有明显锐化感。根因：

- 用户上传 4MB / 2000+ px 的原图，前端用 CSS 一步缩到 36/80/128 px = 缩放 **50-70 倍**
- Chromium 在大倍数 downsample 时只走一次 bilinear，没有 mipmap，高频细节产生 alias，看起来像被 sharpen filter 处理过
- `background-image: url(...)` 的 downsample 路径比 `<img>` 路径质量再差一档
- CSS `zoom != 100%`（Electron / PWA 显示比例）会让图像走二次合成，质量进一步降级

解法：后端用 sharp / libheif 生成长边 600 px 的 thumb，前端再缩到 36/80/128 px 时缩放倍数降到 ~10x，downsample 一次到位的视觉成本可以接受。

## 命名约定

所有 thumb 文件名 = 原文件磁盘名 + `.thumb.jpg`：

| 原文件 | thumb 路径 |
|---|---|
| `2026-05-30_123456_avatar.png` | `2026-05-30_123456_avatar.png.thumb.jpg` |
| `2026-03-22_xxx.heic` | `2026-03-22_xxx.heic.thumb.jpg` |

两条路径（普通图片 sharp / HEIC libheif）共用一套命名，**不冲突**。`isThumbableImage` 用 `\.thumb\.jpg$` 排除 thumb 自身防递归。

## 后端

### 普通图片（jpg/png/webp/gif）

`packages/server/src/utils/imageThumb.ts`：

- `isThumbableImage(filename)` —— 判断该不该生成 thumb（jpg/png/webp/gif，且文件名不含 `.thumb.` 自身）
- `imageThumbPath(originalPath)` —— 拼 thumb 路径
- `generateImageThumb(originalPath, outPath?)` —— sharp 处理：
  - `.rotate()` 按 EXIF orientation 自动转，避免手机竖图横显示
  - `.resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true })` 长边 600 / 小图不放大
  - `.jpeg({ quality: 80, mozjpeg: true })`
  - 出错 throw，调用方 try/catch swallow

### HEIC

`packages/server/src/utils/heicThumb.ts`：用 `libheif-js/wasm-bundle`（WASM）+ `jpeg-js`，纯 JS 不依赖系统 libvips（轻便部署）。慢一些（单张 1-3s）但个人使用可接受。

接口跟 imageThumb 同构：`isHeicFilename` / `heicThumbPath` / `generateHeicThumb` / `backfillHeicThumbs`。

### 上传时调用

`packages/server/src/routes/upload.ts`：

```ts
// /avatar
if (isThumbableImage(filename)) {
  try { await generateImageThumb(diskPath); }
  catch (e) { console.warn('[upload] avatar thumb generation failed:', filename, e?.message); }
}

// /file
if (isHeicFilename(filename)) {
  try { await generateHeicThumb(diskPath); } catch {}
} else if (isThumbableImage(filename)) {
  try { await generateImageThumb(diskPath); } catch {}
}
```

两者都 **同步 await**：sharp 处理 200-500ms / HEIC 1-3s 都阻塞响应。**失败 swallow** 不影响响应，前端 `@error` 兜底降级原图。

加新调用点（新上传接口 / 新文件类型）照搬这个模式。

### Backfill

HEIC 有 `backfillHeicThumbs(uploadsDir)`，server 启动时调一次扫历史 HEIC 补 thumb。

**普通图片暂时没做 backfill**：sharp 处理虽快（< 500ms 一张）但历史几百张图同步扫会卡启动。前端 `@error` 已经保证历史图片不裂，只是没改善锐化。蘑菇要全量 backfill 可以加一个 `backfillImageThumbs` 仿 `backfillHeicThumbs`（异步执行不阻塞启动），或者写一个 admin endpoint 按需触发。

## 前端

### 两个 helper

`packages/web/src/utils/fileUrl.ts`：

- **`resolveFileThumbUrl(url)`** —— 输入裸名或 absolute path，返回 `/api/uploads/<裸名>.thumb.jpg`。外链（http(s) / blob / data）原样返回让调用方按原图渲染
- **`thumbErrorFallback(e, originalUrl)`** —— `<img @error>` handler，一次性切回原图。用 `dataset.thumbFallback` 标记防原图本身也 404 时无限循环触发 error

### 标准模板

```vue
<img :src="resolveFileThumbUrl(url)"
  @error="thumbErrorFallback($event, resolveFileUrl(url))"
  class="..." />
```

- `class` 用 Tailwind 的 `object-cover` / `object-contain` 控制裁剪
- 圆形头像加 `rounded-full`
- 别忘了 `draggable="false"` 防意外 OS 拖图

### 不要用 background-image

```vue
<!-- ✗ Chromium 对 bg-image downsample 质量比 <img> 差一档 -->
<div class="bg-cover bg-center rounded-full" :style="{ backgroundImage: `url(${url})` }" />

<!-- ✓ 用 <img> + rounded-full + object-cover -->
<img :src="resolveFileThumbUrl(url)" class="rounded-full object-cover" />
```

历史代码里 `Settings.vue` / `Sidebar.vue` 的头像曾经用 background-image，这次（commit `bd69812`）一起改成 `<img>` 路径。新写显示场景**直接用 `<img>`**。

### 当前调用点

| 文件 | 位置 | 显示尺寸 |
|---|---|---|
| `Settings.vue` | 头像 | 80×80 |
| `Sidebar.vue` | 头像 | 36×36 |
| `Resources.vue` | grid 缩略图 | ~128×128 |
| `Resources.vue` | list 缩略图 | 36×36 |

新增图片显示场景（卡片小图预览 / 笔记 metadata 缩略图 / 文件 picker 预览等）也按这套来。
