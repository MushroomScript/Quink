"""
从 assets/source/icon.png 生成全套图标，并为 7 套主题各产出一份着色版本。

着色算法（HSV）：
  对非透明 + 有彩色（saturation > 0.1）的像素，用目标主题色的 hue + saturation 替换，
  保留原图的 value（亮度），自然继承 anti-alias 边缘的灰度过渡。白色 Q 字（saturation 接近 0）
  保持不变。

输出：
  packages/web/public/
    favicon.ico                 (blueberry 默认,manifest.json 引用,16/32/48)
    quink-192.png               (PWA,blueberry 默认)
    quink-512.png               (PWA,blueberry 默认)
    apple-touch-icon.png        (iOS,blueberry 默认,180×180)
    favicon-{theme}.ico × 7     (主题切换)
    quink-{theme}-192.png × 7   (登录页 / 关于页 / 标题栏 img)

  packages/desktop/build/
    icon.ico / icon.png         (blueberry 默认)
    icon-{theme}.ico × 7        (Electron mainWindow.setIcon / tray.setImage)
    icon-{theme}.png × 7        (备份)
"""

from PIL import Image
from pathlib import Path
from colorsys import rgb_to_hsv, hsv_to_rgb
import shutil

ROOT = Path(__file__).parent.parent
SRC = ROOT / 'assets' / 'source' / 'icon.png'
WEB_PUB = ROOT / 'packages' / 'web' / 'public'
DESKTOP_BUILD = ROOT / 'packages' / 'desktop' / 'build'

# 抠米白底参数
BG = (249, 248, 244)
TOL = 18
SOFT = 14

# 主题色映射（取自 packages/web/src/style.css 的 --c-accent，dark 用 accent-dark）
THEMES = {
    'blueberry': (116, 143, 252),
    'lavender':  (167, 139, 250),
    'mint':      (94, 206, 172),
    'peach':     (252, 150, 134),
    'lemon':     (240, 190, 80),
    'cloud':     (140, 160, 185),
    'dark':      (100, 130, 230),
}
DEFAULT_THEME = 'blueberry'


def remove_bg(img):
    img = img.convert('RGBA')
    pixels = list(img.getdata())
    out = []
    for r, g, b, _ in pixels:
        d = max(abs(r - BG[0]), abs(g - BG[1]), abs(b - BG[2]))
        if d <= TOL:
            out.append((r, g, b, 0))
        elif d <= TOL + SOFT:
            out.append((r, g, b, int(255 * (d - TOL) / SOFT)))
        else:
            out.append((r, g, b, 255))
    img.putdata(out)
    return img


def colorize(img, target_rgb, sat_boost=1.0, value_scale=1.0):
    """着色: squircle 蓝紫主色 → target_rgb hue+sat,白 Q 不动,保留 anti-alias 边缘.
    sat_boost: 饱和度倍数(默认 1.0). target 饱和度低的主题(cloud)用 > 1 让图标更鲜明.
    value_scale: 亮度系数(默认 1.0). target 亮度高的主题(cloud)用 < 1 让图标变深不糊.
    """
    tr, tg, tb = (c / 255 for c in target_rgb)
    th, ts, _tv = rgb_to_hsv(tr, tg, tb)
    ts = min(1.0, ts * sat_boost)

    pixels = list(img.getdata())
    out = []
    for r, g, b, a in pixels:
        if a == 0:
            out.append((r, g, b, a))
            continue
        h, s, v = rgb_to_hsv(r / 255, g / 255, b / 255)
        # saturation > 0.1 = 有彩色的部分（squircle 主色及其边缘），换 hue + sat，调 value
        # saturation <= 0.1 = 白色 Q 字 / 中性灰，不动
        if s > 0.1:
            nr, ng, nb = hsv_to_rgb(th, ts, v * value_scale)
            out.append((int(nr * 255), int(ng * 255), int(nb * 255), a))
        else:
            out.append((r, g, b, a))
    img.putdata(out)
    return img


def colorize_inverted(img, squircle_rgb, q_rgb):
    """反色版：squircle 用 squircle_rgb，Q 字用 q_rgb。
    用于 dark 主题：深灰蓝 squircle + 蓝紫 Q，跟其他主题"主题色 squircle + 白 Q"形成视觉对比。
    """
    sh, ss, sv_t = rgb_to_hsv(*[c / 255 for c in squircle_rgb])
    qh, qs, qv_t = rgb_to_hsv(*[c / 255 for c in q_rgb])

    pixels = list(img.getdata())
    out = []
    for r, g, b, a in pixels:
        if a == 0:
            out.append((r, g, b, a))
            continue
        h, s, v = rgb_to_hsv(r / 255, g / 255, b / 255)
        if s > 0.1:
            # 原 squircle 蓝紫主色 → squircle_rgb，保留一点原 value 变化让边缘 anti-alias 自然
            new_v = sv_t * (0.75 + 0.25 * v)
            nr, ng, nb = hsv_to_rgb(sh, ss, new_v)
        else:
            # 原白 Q → q_rgb，原亮度 v 直接做亮度系数（白→满亮 q_rgb，边缘灰→中等 q_rgb）
            nr, ng, nb = hsv_to_rgb(qh, qs, qv_t * v)
        out.append((int(nr * 255), int(ng * 255), int(nb * 255), a))
    img.putdata(out)
    return img


def save_png(img, path, size):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.resize((size, size), Image.LANCZOS).save(path, 'PNG', optimize=True)
    print(f'  PNG  {size:>4}  {path.relative_to(ROOT)}')


def save_ico(img, path, sizes):
    path.parent.mkdir(parents=True, exist_ok=True)
    biggest = max(sizes)
    img.resize((biggest, biggest), Image.LANCZOS).save(
        path, format='ICO', sizes=[(s, s) for s in sizes]
    )
    print(f'  ICO  {sizes}  {path.relative_to(ROOT)}')


def build_theme(base, name, color):
    print(f'theme: {name}  rgb{color}')

    # web 端图标（favicon / 应用内 logo / 标题栏小图）
    if name == 'dark':
        # dark 反色: 中等深灰蓝 squircle + 蓝紫 Q
        # squircle 用 (74,83,120)=#4a5378 而非更暗的 (40,45,65),否则在 dark 主题页面背景 #1e1e2a
        # 上对比只有 1.8:1（远低于 WCAG AA 3:1）,图标边缘消失
        web_colored = colorize_inverted(base.copy(), (74, 83, 120), (130, 160, 255))
    elif name == 'cloud':
        # cloud accent 饱和度低 + 亮度高,小尺寸（任务栏 16-32px）下太淡 → 增强
        web_colored = colorize(base.copy(), color, sat_boost=1.8, value_scale=0.78)
    else:
        web_colored = colorize(base.copy(), color)
    save_ico(web_colored, WEB_PUB / f'favicon-{name}.ico', [16, 32, 48])
    save_png(web_colored, WEB_PUB / f'quink-{name}-192.png', 192)

    # desktop 端图标（Win 任务栏 / 系统托盘 / Alt+Tab）:小尺寸 + 浅色任务栏背景下某些主题需要单独调
    # mint 高饱和高亮度,在浅任务栏上"刺眼漂浮",降低 value 让颜色更稳重
    if name == 'mint':
        desktop_colored = colorize(base.copy(), color, value_scale=0.72)
    else:
        desktop_colored = web_colored
    save_ico(desktop_colored, DESKTOP_BUILD / f'icon-{name}.ico', [16, 32, 48, 64, 128, 256])
    save_png(desktop_colored, DESKTOP_BUILD / f'icon-{name}.png', 1024)


def main():
    print(f'source: {SRC}')
    src = Image.open(SRC)
    print(f'  {src.size}  {src.mode}')

    print('removing background...')
    base = remove_bg(src).resize((1024, 1024), Image.LANCZOS)

    for name, color in THEMES.items():
        build_theme(base, name, color)

    # 默认（manifest 静态引用 + Electron fallback）= blueberry
    print(f'copying {DEFAULT_THEME} → default paths')

    def cp(s, d):
        shutil.copy(s, d)
        print(f'  COPY  {d.relative_to(ROOT)}')

    cp(WEB_PUB / f'favicon-{DEFAULT_THEME}.ico',    WEB_PUB / 'favicon.ico')
    cp(WEB_PUB / f'quink-{DEFAULT_THEME}-192.png',  WEB_PUB / 'quink-192.png')
    cp(DESKTOP_BUILD / f'icon-{DEFAULT_THEME}.ico', DESKTOP_BUILD / 'icon.ico')
    cp(DESKTOP_BUILD / f'icon-{DEFAULT_THEME}.png', DESKTOP_BUILD / 'icon.png')

    # PWA 用 512、iOS 用 180,默认主题各 1 份
    default_colored = colorize(base.copy(), THEMES[DEFAULT_THEME])
    save_png(default_colored, WEB_PUB / 'quink-512.png', 512)
    save_png(default_colored, WEB_PUB / 'apple-touch-icon.png', 180)

    print('done')


if __name__ == '__main__':
    main()
