// 视频首帧缩略图缓存. 跟 pdfCache 同 pattern (内存 Map + Electron 持久化磁盘).
// 转码用临时 <video> 元素 loadedmetadata → seek 到 0.1s 避免黑帧 → canvas drawImage → toBlob jpeg

const memCache = new Map<string, string>();

async function loadFromDisk(url: string): Promise<string | null> {
  const desk = (window as any).quinkDesktop;
  if (!desk?.videoThumbCacheGet) return null;
  try {
    const buf = await desk.videoThumbCacheGet(url);
    if (!buf || buf.byteLength === 0) return null;
    const blob = new Blob([buf], { type: 'image/jpeg' });
    const objectUrl = URL.createObjectURL(blob);
    memCache.set(url, objectUrl);
    return objectUrl;
  } catch {
    return null;
  }
}

async function captureAndPersist(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.src = url;
    let settled = false;

    const cleanup = () => {
      video.removeAttribute('src');
      try { video.load(); } catch {}
    };
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    video.onloadedmetadata = () => {
      // 跳到 0.1s 取首帧 (开头 0s 经常是黑帧 / 解码未稳定)
      video.currentTime = Math.min(0.1, (video.duration || 1) * 0.05);
    };

    video.onseeked = async () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return settle(() => { cleanup(); reject(new Error('no canvas ctx')); });
        ctx.drawImage(video, 0, 0);
        const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => b ? res(b) : rej(new Error('toBlob null')), 'image/jpeg', 0.85)!);
        const objectUrl = URL.createObjectURL(blob);
        memCache.set(url, objectUrl);
        // 持久化 fire-and-forget
        const desk = (window as any).quinkDesktop;
        if (desk?.videoThumbCachePut) {
          blob.arrayBuffer().then((ab) => desk.videoThumbCachePut(url, ab)).catch((e: any) => console.warn('[videoThumbCache put]', e));
        }
        settle(() => { cleanup(); resolve(objectUrl); });
      } catch (e) {
        settle(() => { cleanup(); reject(e); });
      }
    };

    video.onerror = () => settle(() => { cleanup(); reject(new Error('video load error')); });

    // 超时兜底 (某些不可解码视频会一直 loading 不报错)
    setTimeout(() => settle(() => { cleanup(); reject(new Error('video thumb timeout')); }), 15000);
  });
}

export async function getOrCaptureVideoThumb(url: string): Promise<string> {
  const mem = memCache.get(url);
  if (mem) return mem;
  const disk = await loadFromDisk(url);
  if (disk) return disk;
  return captureAndPersist(url);
}
