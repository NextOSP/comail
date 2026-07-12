#!/usr/bin/env python3
"""Comail app icon: a gradient CIRCLE, palette-driven.

Approach (pure Pillow):
  * A multi-point *mesh* gradient (several blended colour fields) rather than a
    flat linear ramp — reads as "designed", not "AI default".
  * Fine film grain to kill banding and add texture.
  * Palettes lean monochromatic/duotone (intentional, brand-like) instead of
    the overused purple->pink->orange sunset.

Usage: python3 make_icon.py [palette_name]   (default: cobalt)
"""
import sys, math
from PIL import Image, ImageDraw, ImageFilter, ImageChops

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

def vgrad(w, h, top, bot):
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=lerp(top, bot, y / (h - 1)))
    return img

def blob(mesh, color, bx, by, rad, strength):
    m = Image.new("L", mesh.size, 0)
    ImageDraw.Draw(m).ellipse([bx - rad, by - rad, bx + rad, by + rad], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(rad * 0.55))
    m = m.point(lambda v: int(v * strength))
    return Image.composite(Image.new("RGB", mesh.size, color), mesh, m)

# ---- palettes: (top, bot, [(color,fx,fy,frad,strength)...], halo, bg, lift) ----
PALETTES = {
    # electric cobalt -> cyan, cool & techy
    "cobalt": dict(
        top=(37, 99, 235), bot=(34, 211, 238),
        blobs=[((30, 64, 175), .30, .24, .55, .85), ((59, 130, 246), .80, .22, .45, .70),
               ((37, 99, 235), .26, .60, .48, .70), ((103, 232, 249), .80, .82, .50, .85),
               ((186, 240, 255), .60, .70, .20, .5)],
        halo=(22, 60, 120), bg=(8, 12, 22), lift=(220, 245, 255)),
    # deep teal -> emerald, fresh
    "emerald": dict(
        top=(13, 92, 99), bot=(52, 211, 153),
        blobs=[((14, 116, 110), .30, .24, .55, .85), ((6, 95, 70), .26, .60, .48, .75),
               ((110, 231, 183), .80, .82, .50, .85), ((34, 211, 238), .80, .22, .42, .55),
               ((200, 255, 235), .60, .70, .20, .5)],
        halo=(16, 80, 70), bg=(7, 16, 14), lift=(225, 255, 245)),
    # molten amber -> deep orange, warm & editorial (single warm family)
    "amber": dict(
        top=(253, 196, 90), bot=(154, 52, 18),
        blobs=[((251, 191, 36), .30, .22, .52, .85), ((249, 115, 22), .70, .55, .50, .8),
               ((124, 45, 18), .80, .84, .50, .85), ((255, 231, 160), .30, .30, .30, .55)],
        halo=(120, 60, 20), bg=(20, 12, 6), lift=(255, 240, 210)),
    # crimson -> rose, bold
    "crimson": dict(
        top=(244, 63, 94), bot=(136, 19, 55),
        blobs=[((251, 113, 133), .30, .24, .55, .85), ((225, 29, 72), .70, .40, .5, .8),
               ((76, 5, 25), .80, .84, .50, .85), ((253, 164, 175), .30, .28, .28, .55)],
        halo=(110, 22, 44), bg=(18, 8, 12), lift=(255, 225, 228)),
    # graphite -> steel blue, ultra-restrained / premium
    "slate": dict(
        top=(90, 108, 140), bot=(20, 28, 44),
        blobs=[((120, 140, 175), .30, .22, .55, .8), ((70, 90, 130), .75, .78, .5, .8),
               ((160, 180, 210), .32, .30, .26, .5)],
        halo=(50, 66, 96), bg=(9, 11, 16), lift=(210, 224, 245)),
}

def build_icon(pal, N=1024, SS=3):
    SIZE = N * SS
    R = int(0.14 * SIZE)
    mesh = vgrad(SIZE, SIZE, pal["top"], pal["bot"])
    for color, fx, fy, fr, st in pal["blobs"]:
        mesh = blob(mesh, color, SIZE * fx, SIZE * fy, SIZE * fr, st)
    mesh = mesh.filter(ImageFilter.GaussianBlur(SIZE * 0.02))
    lift = Image.new("L", mesh.size, 0)
    ImageDraw.Draw(lift).ellipse([SIZE * .16, SIZE * .02, SIZE * .84, SIZE * .5], fill=52)
    lift = lift.filter(ImageFilter.GaussianBlur(SIZE * 0.10))
    mesh = Image.composite(Image.new("RGB", mesh.size, pal["lift"]), mesh, lift)

    bg = Image.new("RGB", (SIZE, SIZE), pal["bg"])
    halo = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(halo).ellipse([SIZE * .14, SIZE * .14, SIZE * .86, SIZE * .86], fill=110)
    halo = halo.filter(ImageFilter.GaussianBlur(SIZE * 0.08))
    bg = Image.composite(Image.new("RGB", (SIZE, SIZE), pal["halo"]), bg, halo)

    cx = cy = SIZE * 0.5
    cr = SIZE * 0.365
    cmask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(cmask).ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=255)
    cmask = cmask.filter(ImageFilter.GaussianBlur(SS * 0.8))
    comp = bg.copy()
    comp.paste(mesh, (0, 0), cmask)

    grain = Image.effect_noise((SIZE, SIZE), 26).convert("RGB")
    comp = Image.blend(comp, ImageChops.overlay(comp, grain), 0.055)

    tile = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(tile).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=R, fill=255)
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(comp, (0, 0), tile)
    return out.resize((N, N), Image.LANCZOS)

if __name__ == "__main__":
    name = sys.argv[1] if len(sys.argv) > 1 else "cobalt"
    path = __file__.rsplit("/", 1)[0] + "/../app-icon.png"
    build_icon(PALETTES[name]).save(path)
    print("wrote", path, "palette:", name)
