#!/usr/bin/env python3
"""Comail app icon: a dimensional, beveled metallic HEXAGON (bolt head, top view).

Crafted look with pure Pillow:
  * Rich deep-blue studio gradient tile with a soft radial glow + vignette.
  * A brushed-steel hexagon extruded for thickness, with six chamfer facets
    lit per-edge (top-left light source), a glossy specular sweep, an inner
    bevel and a soft cast shadow.
Rendered at 4x supersampling -> 1024x1024.
"""
import math
from PIL import Image, ImageDraw, ImageFilter

SS = 4
N = 1024
SIZE = N * SS
R = int(0.14 * SIZE)

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

def ramp(t, stops):
    t = max(0.0, min(1.0, t))
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]
        t1, c1 = stops[i + 1]
        if t <= t1:
            return lerp(c0, c1, (t - t0) / (t1 - t0) if t1 > t0 else 0)
    return stops[-1][1]

def vgrad(w, h, top, bot):
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=lerp(top, bot, y / (h - 1)))
    return img

def hexagon(cx, cy, r, rot=0.0):
    pts = []
    for k in range(6):
        a = math.radians(60 * k + rot)
        pts.append((cx + r * math.cos(a), cy - r * math.sin(a)))
    return pts

# ---------------- background tile ----------------
bg = vgrad(SIZE, SIZE, (23, 62, 140), (8, 24, 66))          # deep blue studio
# soft radial glow behind the hex
glow = Image.new("L", (SIZE, SIZE), 0)
gd = ImageDraw.Draw(glow)
gcx, gcy, gr = SIZE * 0.5, SIZE * 0.42, SIZE * 0.42
gd.ellipse([gcx - gr, gcy - gr, gcx + gr, gcy + gr], fill=130)
glow = glow.filter(ImageFilter.GaussianBlur(SIZE * 0.10))
bg = Image.composite(Image.new("RGB", (SIZE, SIZE), (70, 120, 210)), bg, glow)
# vignette
vig = Image.new("L", (SIZE, SIZE), 0)
vd = ImageDraw.Draw(vig)
vd.rectangle([0, 0, SIZE, SIZE], fill=110)
vd.ellipse([-SIZE * 0.2, -SIZE * 0.2, SIZE * 1.2, SIZE * 1.2], fill=0)
vig = vig.filter(ImageFilter.GaussianBlur(SIZE * 0.14))
bg = Image.composite(Image.new("RGB", (SIZE, SIZE), (4, 12, 34)), bg, vig)

icon = bg.convert("RGBA")

# ---------------- hexagon geometry ----------------
cx, cy = SIZE * 0.5, SIZE * 0.47
r = SIZE * 0.34                 # circumradius (vertex)
rot = 30                        # flat-top hexagon
th = int(SIZE * 0.055)          # extrusion thickness
outer = hexagon(cx, cy, r, rot)

# ---------------- cast shadow ----------------
sh = Image.new("L", (SIZE, SIZE), 0)
sd = ImageDraw.Draw(sh)
sd.polygon(hexagon(cx, cy + th, r * 1.02, rot), fill=150)
sh = sh.filter(ImageFilter.GaussianBlur(SIZE * 0.035))
shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
shadow.putalpha(sh.point(lambda v: int(v * 0.85)))
icon = Image.alpha_composite(icon, shadow)

draw = ImageDraw.Draw(icon)

# ---------------- extruded side (thickness) ----------------
side = hexagon(cx, cy + th, r, rot)
side_grad_top = (66, 80, 108)
side_grad_bot = (30, 40, 62)
# fill the union of the two hexes bottom band with a dark gradient
side_mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(side_mask).polygon(side, fill=255)
side_fill = vgrad(SIZE, SIZE, side_grad_top, side_grad_bot)
icon.paste(side_fill, (0, 0), side_mask)
draw = ImageDraw.Draw(icon)

# ---------------- top face: chamfer facets ----------------
STEEL = [(0.00, (44, 56, 80)), (0.30, (96, 112, 142)),
         (0.55, (150, 168, 198)), (0.78, (212, 222, 240)),
         (0.92, (240, 246, 253)), (1.00, (255, 255, 255))]
# light direction (screen coords, y down); top-left, mostly from top
L = (-0.45, -1.0)
Ln = math.hypot(*L)
L = (L[0] / Ln, L[1] / Ln)

bw = r * 0.20                    # bevel / chamfer width
inner = hexagon(cx, cy, r - bw, rot)

# base fill of the whole top face (mid steel) so facet seams are covered
top_mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(top_mask).polygon(outer, fill=255)
icon.paste(vgrad(SIZE, SIZE, (200, 212, 234), (150, 166, 192)), (0, 0), top_mask)
draw = ImageDraw.Draw(icon)

# draw the six chamfer facets as quads (outer edge -> inner edge)
for k in range(6):
    ox0, oy0 = outer[k]
    ox1, oy1 = outer[(k + 1) % 6]
    ix1, iy1 = inner[(k + 1) % 6]
    ix0, iy0 = inner[k]
    mx = (ox0 + ox1) / 2 - cx
    my = (oy0 + oy1) / 2 - cy
    mn = math.hypot(mx, my) or 1
    facing = (mx / mn) * L[0] + (my / mn) * L[1]     # -1..1 (1 = toward light)
    b = 0.5 + 0.5 * facing
    col = ramp(0.15 + 0.85 * b, STEEL)
    draw.polygon([(ox0, oy0), (ox1, oy1), (ix1, iy1), (ix0, iy0)], fill=col + (255,))

# inner flat face: bright brushed gradient
inner_mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(inner_mask).polygon(inner, fill=255)
icon.paste(vgrad(SIZE, SIZE, (236, 243, 252), (176, 192, 216)), (0, 0), inner_mask)
draw = ImageDraw.Draw(icon)

# brushed concentric rings on the inner face (subtle)
rings = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
rd = ImageDraw.Draw(rings)
for i in range(1, 7):
    rr = (r - bw) * (i / 7.0)
    shade = 255 if i % 2 else 235
    rd.ellipse([cx - rr, cy - rr * 0.98, cx + rr, cy + rr * 0.98],
               outline=(shade, shade, shade, 22), width=max(2, int(SIZE * 0.004)))
rings.putalpha(rings.getchannel("A").filter(ImageFilter.GaussianBlur(SS)))
inner_only = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
inner_only.paste(rings, (0, 0), inner_mask)
icon = Image.alpha_composite(icon, inner_only)
draw = ImageDraw.Draw(icon)

# glossy specular sweep across the top-left of the inner face
gloss = Image.new("L", (SIZE, SIZE), 0)
gld = ImageDraw.Draw(gloss)
gld.ellipse([cx - r * 0.9, cy - r * 1.05, cx + r * 0.2, cy - r * 0.05], fill=120)
gloss = gloss.filter(ImageFilter.GaussianBlur(SIZE * 0.03))
gloss_layer = Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 0))
gloss_layer.putalpha(gloss)
clip = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
clip.paste(gloss_layer, (0, 0), top_mask)
icon = Image.alpha_composite(icon, clip)
draw = ImageDraw.Draw(icon)

# crisp bright rim on the top-left outer edges, thin dark rim bottom-right
for k in range(6):
    x0, y0 = outer[k]
    x1, y1 = outer[(k + 1) % 6]
    mx = (x0 + x1) / 2 - cx
    my = (y0 + y1) / 2 - cy
    mn = math.hypot(mx, my) or 1
    facing = (mx / mn) * L[0] + (my / mn) * L[1]
    if facing > 0.15:
        draw.line([(x0, y0), (x1, y1)], fill=(255, 255, 255, 210),
                  width=max(2, int(SIZE * 0.006)))
    elif facing < -0.3:
        draw.line([(x0, y0), (x1, y1)], fill=(20, 30, 50, 150),
                  width=max(2, int(SIZE * 0.004)))

# ---------------- round the tile & export ----------------
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=R, fill=255)
out_img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
out_img.paste(icon, (0, 0), mask)

final = out_img.resize((N, N), Image.LANCZOS)
out = __file__.rsplit("/", 1)[0] + "/../app-icon.png"
final.save(out)
print("wrote", out)
