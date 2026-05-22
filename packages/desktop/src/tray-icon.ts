import { nativeImage } from 'electron';
import * as path from 'path';

// 应用图标加载器：从 build/icon-{theme}.ico 读取（多尺寸 ICO，OS 按 DPI 自动选 16/24/32 等）。
// 同时用于 Tray.setImage 和 mainWindow.setIcon —— 主题切换时一次调用统一更新所有位置。
export function createTrayIcon(theme: string = 'blueberry') {
  return nativeImage.createFromPath(
    path.join(__dirname, '..', 'build', `icon-${theme}.ico`)
  );
}
