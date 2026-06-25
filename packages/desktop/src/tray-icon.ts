import { nativeImage } from 'electron';
import * as path from 'path';

// 应用图标加载器：从 build/icon-{theme}.ico 读取（多尺寸 ICO，OS 按 DPI 自动选 16/24/32 等）。
// 同时用于 Tray.setImage 和 mainWindow.setIcon —— 主题切换时一次调用统一更新所有位置。
export function createTrayIcon(theme: string = 'blueberry') {
  return nativeImage.createFromPath(
    path.join(__dirname, '..', 'build', `icon-${theme}.ico`)
  );
}

// 托盘图标. macOS 用黑白 template (`setTemplateImage` 让系统按菜单栏明暗自动反色), Windows 用彩色主题 ico.
// Mac 图标走 base64 内嵌而非 createFromPath: 打包后 build/trayTemplate.png 在 asar 内, Mac 的 nativeImage
// 从 asar 路径读 png 实测空白 (Windows 的 ico 能读, Mac 不行). base64 DataURL 无文件路径依赖, 一劳永逸.
// 内容: Quink logo 黑色剪影 (icon-blueberry.png alpha 通道提取, 16 + 32@2x retina).
const TRAY_TEMPLATE_16 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABPklEQVR4nJ2TMUsDQRCFv5CABknA1p9gJbbWgp0IVoKKFlbaCVbWFirEi6CNRQq1ErVRULESLfILAlpoF6wFo9GEwXdhbr1AdGDYmzdv387OzcKPZeS9WoKf0VoAVoAKcAwcOj8SVhGnEOylH7gBWsCX1jSPc1dAny9pUYkG8KHvV6AKPCtuKhfnF7zAtsBP+TqQVy4LzAB1cWKBTS8QuTLXhI0Bq8Co4nFdoSme7enYjsAXnTgd3HtKvEuHJwRKAo1gdqL4zTXNbMMJlNMEHoK4ofVe+G43gUjgOzACFIFb17BTYAB46naFyCXugEHhNjBDwBJwDTwCB+JZ3zq2FZRcA5aBCWASGAbmgQvlfv3GOTcHJvIdTKA10063Nc7NeoEccP6HUT7TnoTZe7AyrR/7Kb6nzhvHuAn793NuA6RNgt2iLCREAAAAAElFTkSuQmCC';
const TRAY_TEMPLATE_32 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAADBElEQVR4nK2XTYhOURjHf/cOM5aIYWV8jLIwDCY1JRMLC6lJ1CRZKCvKSlnYKVNDPqIoCUVIyYKQspWSDQuTJiWsjI/G58w773119Bz95zh3vPe+c+rpuR/Px/885/m4FyZfKdBkNK0geT1no/BKyypOhb0USOx6HrAR6AN2FaQ+051vtpJ6QKTGlwLXgRGg1iB9BW6YTfWR67wHGDblzHi1JKmND8D6PBCp8UXAe1MYE2WlzIxXjMbFWUw2Mzl3/w5YGAPRZPy0OI8ZG88BVfsPELV5KvCJT7gZwFAQtnDXNdvNc+AmcAV4aOEN5ULyz1+Zr7++Uwn/jwgAH0a3w0vASkHvwc8C9gCvJRqxCNbMR1sMwCpRzAL+BeiVs/OOE2s63sZs4G6w4xCAi+AKzYPUbrqCzPUKDtQWk2kW763beSDNcpSPIiC0orrqATBu1yfsfYvxtdYjXgDPLHGX2Lvpxpdb/ceiWReAqvERMe7WNslmjZJLwnUBiPNBPhQCUDF+X5y3Am+lpHyz8YAGgZki39tIBMaMHxWDOyfJcA94t8i7yP2MRKsQgENi8EDgLAbgjMjPCfKg4QjsqCMCF0W+HfhVFkDF+L1gR2/kfRbp9SdFfutUVUG7GN0eyWqN2EGRvWDPRstEIBNHx+29bzQbgMdmWCeik91nMp2N9oFMFNzuNgUgXAdcDKwGOoDNwBPgtnXIB6b72a6/BUOpLgC1oNH0iHPfjpFrZ+esRcPnxC17d0ecO1oTA9Apinq+VZlihy0Z1XG4XLVcA84BT21sfwwqZsIwSuymLWcch3N+2HZ2zObEVeAysB9YJlNxL/ApcqTfgQW6iUSGzWDOKA0TM49Gzal2QC1Z9+yl5FLiw+bHan9QVjHyRrUCtBL06GKleiTwOQFJqyHUgZMVpFBHB5azPTcvh1LjHZN8G5Yhb2PIbKuvf1YqkRiwbzzfyco4HjUbA2ZTfeSuNEhMN1a7rQ8UoW77G2op8muGgJiQJA2u0n/JHrX+ptdLXi+vYf1ZvwFJ7BG5ncRTBwAAAABJRU5ErkJggg==';

export function createTrayImage(theme: string = 'blueberry') {
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromDataURL(TRAY_TEMPLATE_16);
    img.addRepresentation({ scaleFactor: 2, dataURL: TRAY_TEMPLATE_32 });
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(
    path.join(__dirname, '..', 'build', `icon-${theme}.ico`)
  );
}
