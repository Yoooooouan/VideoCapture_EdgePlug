"""生成插件图标 - 蓝色圆底 + 白色播放+下载箭头"""
from PIL import Image, ImageDraw
import os

OUT = os.path.dirname(os.path.abspath(__file__))

def draw_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角矩形背景
    margin = max(1, size // 12)
    radius = size // 5
    d.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=radius,
        fill=(74, 144, 217, 255)
    )

    # 播放三角形（上半部分）
    cx = size // 2
    tri_top = size // 5
    tri_bot = int(size * 0.42)
    tri_size = size // 4
    d.polygon([
        (cx - tri_size // 2 - 1, tri_top),
        (cx - tri_size // 2 - 1, tri_bot),
        (cx + tri_size, (tri_top + tri_bot) // 2),
    ], fill=(255, 255, 255, 255))

    # 下载箭头（下半部分）
    arrow_top = int(size * 0.52)
    arrow_bot = int(size * 0.72)
    shaft_w = max(2, size // 14)
    # 竖线
    d.rectangle(
        [cx - shaft_w // 2, arrow_top, cx + shaft_w // 2, arrow_bot],
        fill=(255, 255, 255, 255)
    )
    # 箭头 V
    aw = size // 5
    ah = size // 8
    d.polygon([
        (cx - aw, arrow_bot - 2),
        (cx, arrow_bot + ah),
        (cx + aw, arrow_bot - 2),
        (cx + aw - max(2, size//20), arrow_bot - 2),
        (cx, arrow_bot + ah - max(3, size//10)),
        (cx - aw + max(2, size//20), arrow_bot - 2),
    ], fill=(255, 255, 255, 255))

    return img

for s in [16, 48, 128]:
    icon = draw_icon(s)
    icon.save(os.path.join(OUT, f'icon{s}.png'))
    print(f'Generated icon{s}.png')

print('Done.')
