// PDF 首页缩略图缓存 helper (内存 Map + Electron 持久化磁盘 IPC).
// 转码用 pdfjs 渲染 PDF 第一页 → canvas → jpeg blob.
// 用 legacy build: pdfjs-dist 5.x 用 BigInt.prototype.toHex (Chromium 138+), Electron 内嵌 Chromium 版本不够
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorker;

const memCache = new Map<string, string>();

// 并发渲染限制: 一屏 20+ PDF 同时进入视口会让 pdfjs 并发渲染 20 个 page → CPU 卡几秒.
// 限 3 个并发, 排队顺序处理, 用户感受是"逐个出现"而非"一起卡然后都出"
const MAX_CONCURRENT = 3;
let _active = 0;
const _queue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (_active < MAX_CONCURRENT) { _active++; return; }
  await new Promise<void>((resolve) => _queue.push(resolve));
  _active++;
}
function releaseSlot(): void {
  _active--;
  const next = _queue.shift();
  if (next) next();
}

async function loadFromDisk(url: string): Promise<string | null> {
  const desk = (window as any).quinkDesktop;
  if (!desk?.pdfThumbCacheGet) return null;
  try {
    const buf = await desk.pdfThumbCacheGet(url);
    if (!buf || buf.byteLength === 0) return null;
    const blob = new Blob([buf], { type: 'image/jpeg' });
    const objectUrl = URL.createObjectURL(blob);
    memCache.set(url, objectUrl);
    return objectUrl;
  } catch {
    return null;
  }
}

async function renderAndPersist(url: string): Promise<string> {
  await acquireSlot();
  try {
    return await _doRender(url);
  } finally {
    releaseSlot();
  }
}

async function _doRender(url: string): Promise<string> {
  const pdf = await pdfjsLib.getDocument(url).promise;
  const page = await pdf.getPage(1);
  // scale 1.0: A4 PDF 约 595x842 jpeg, 卡片显示足够清晰且文件小
  const viewport = page.getViewport({ scale: 1.0 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas ctx');
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => b ? res(b) : rej(new Error('toBlob null')), 'image/jpeg', 0.9)!);
  const objectUrl = URL.createObjectURL(blob);
  memCache.set(url, objectUrl);
  const desk = (window as any).quinkDesktop;
  if (desk?.pdfThumbCachePut) {
    blob.arrayBuffer().then((ab) => desk.pdfThumbCachePut(url, ab)).catch((e: any) => console.warn('[pdfCache put]', e));
  }
  return objectUrl;
}

export async function getOrRenderThumb(url: string): Promise<string> {
  const mem = memCache.get(url);
  if (mem) return mem;
  const disk = await loadFromDisk(url);
  if (disk) return disk;
  return renderAndPersist(url);
}

export function preconvert(url: string): void {
  getOrRenderThumb(url).catch((e) => console.warn('[pdf preconvert]', url, e));
}
