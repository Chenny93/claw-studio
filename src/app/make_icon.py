# Claw Studio 图标 v4：深靛蓝渐变（让红色龙虾更突出）+ 系统 🦞，渐变铺满无角落色差，Emoji 以最大位图档渲染
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os
here = os.path.dirname(os.path.abspath(__file__))
FONT = r'C:\Windows\Fonts\seguiemj.ttf'

def emoji_img():
    best = None
    for fs in (256, 218, 160, 136, 109):
        try:
            f = ImageFont.truetype(FONT, fs)
            im = Image.new('RGBA', (fs * 2, fs * 2), (0, 0, 0, 0))
            ImageDraw.Draw(im).text((fs // 2, fs // 2), '🦞', font=f, embedded_color=True)
            bb = im.getbbox()
            if bb: best = im.crop(bb); break
        except Exception: pass
    return best
EM = emoji_img()
print('emoji src', EM.size)

def gradient(B):
    # 对角渐变：逐行插值，保证四角也是连续颜色
    top = (79, 70, 229); bot = (49, 46, 129)     # indigo-600 → indigo-900
    g = Image.new('RGBA', (B, B))
    px = g.load()
    for y in range(B):
        for x in range(0, B):
            t = (x * 0.35 + y) / (B * 1.35)
            px[x, y] = (int(top[0] + (bot[0] - top[0]) * t), int(top[1] + (bot[1] - top[1]) * t), int(top[2] + (bot[2] - top[2]) * t), 255)
    return g

GRAD = gradient(1024)

def build(px):
    B = 1024
    small = px < 48
    pad = 0 if small else 44
    m = Image.new('L', (B, B), 0)
    ImageDraw.Draw(m).rounded_rectangle([pad, pad, B - pad, B - pad], radius=250 if small else 224, fill=255)
    out = Image.new('RGBA', (B, B), (0, 0, 0, 0)); out.paste(GRAD, (0, 0), m)
    # 柔和顶部光晕（不是硬高光条）
    glow = Image.new('RGBA', (B, B), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([B * .1, -B * .45, B * .9, B * .45], fill=(165, 180, 252, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    out = Image.alpha_composite(out, Image.composite(glow, Image.new('RGBA', (B, B), (0, 0, 0, 0)), m))
    scale = 0.88 if small else 0.68
    tgt = int(B * scale); r = tgt / max(EM.size)
    em = EM.resize((int(EM.width * r), int(EM.height * r)), Image.LANCZOS)
    x = (B - em.width) // 2; y = (B - em.height) // 2 + (0 if small else 8)
    out.alpha_composite(em, (x, y))
    return out.resize((px, px), Image.LANCZOS)

build(1024).save(os.path.join(here, 'icon_1024.png'))
build(192).save(os.path.join(here, 'icon_192.png'))
sizes = (16, 24, 32, 48, 64, 128, 256)
frames = [build(s) for s in sizes]
frames[-1].save(os.path.join(here, 'icon.ico'), format='ICO', sizes=[(s, s) for s in sizes], append_images=frames[:-1])
pv = Image.new('RGBA', (sum(sizes) + 20 * (len(sizes) + 1), 300), (243, 243, 243, 255)); x = 20
for fr in frames: pv.paste(fr, (x, 280 - fr.height), fr); x += fr.width + 20
# 深色任务栏预览
pv2 = Image.new('RGBA', pv.size, (32, 32, 32, 255)); x = 20
for fr in frames: pv2.paste(fr, (x, 280 - fr.height), fr); x += fr.width + 20
both = Image.new('RGBA', (pv.width, 600)); both.paste(pv, (0, 0)); both.paste(pv2, (0, 300))
both.save(os.path.join(here, 'icon_preview.png'))
print('ok')
