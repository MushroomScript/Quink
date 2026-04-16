import { nativeImage } from 'electron';

/**
 * Generate a simple tray icon programmatically (no external file needed).
 * A 16x16 blue "Q" icon.
 */
export function createTrayIcon() {
  // 16x16 RGBA raw pixel data — simple blue square with white "Q" shape
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Rounded background
      const cx = x - 7.5, cy = y - 7.5;
      const dist = Math.sqrt(cx * cx + cy * cy);

      if (dist <= 7.5) {
        // Blue background
        buf[idx] = 59;     // R
        buf[idx + 1] = 130; // G
        buf[idx + 2] = 246; // B
        buf[idx + 3] = 255; // A

        // White "Q" shape — circle + tail
        const qDist = Math.sqrt(cx * cx + cy * cy);
        const isCircle = qDist >= 3 && qDist <= 5.5;
        const isTail = x >= 8 && x <= 11 && y >= 8 && y <= 11 && (x - 6) === (y - 6);

        if (isCircle || isTail) {
          buf[idx] = 255;
          buf[idx + 1] = 255;
          buf[idx + 2] = 255;
        }
      } else {
        // Transparent
        buf[idx + 3] = 0;
      }
    }
  }

  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}
