#!/usr/bin/env python3
"""Generates the PWA icons. Drawn, not downloaded: no external assets, no
licence questions, and the mark stays crisp at 192px.

Mark: a filled form sheet with a green tick that doubles as the "sathi" check,
on the app's deep-green ground.
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "icons")
os.makedirs(OUT, exist_ok=True)

GREEN = (15, 81, 50)
GREEN_LIGHT = (28, 122, 74)
CREAM = (250, 248, 240)
INK = (16, 22, 30)
SAFFRON = (222, 122, 26)


def draw_icon(size, padding_ratio=0.16, rounded=True, bg=GREEN):
    S = size * 4  # supersample
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if rounded:
        d.rounded_rectangle([0, 0, S, S], radius=int(S * 0.22), fill=bg)
    else:
        d.rectangle([0, 0, S, S], fill=bg)

    # form sheet
    pad = S * padding_ratio
    sheet = [pad, pad * 0.86, S - pad, S - pad * 0.86]
    d.rounded_rectangle(sheet, radius=int(S * 0.035), fill=CREAM)
    # folded corner
    fold = S * 0.10
    d.polygon(
        [(sheet[2] - fold, sheet[1]), (sheet[2], sheet[1]), (sheet[2], sheet[1] + fold)],
        fill=(226, 222, 210),
    )

    # text lines
    lx = sheet[0] + S * 0.06
    lw = (sheet[2] - sheet[0]) * 0.56
    ly = sheet[1] + S * 0.10
    for i in range(4):
        w = lw * (1.0 if i % 2 == 0 else 0.78)
        d.rounded_rectangle(
            [lx, ly, lx + w, ly + S * 0.032],
            radius=int(S * 0.016),
            fill=(178, 184, 192) if i > 1 else (120, 128, 138),
        )
        ly += S * 0.075

    # field boxes
    bx = lx
    by = ly + S * 0.015
    for i in range(2):
        d.rounded_rectangle(
            [bx, by, bx + lw * 0.9, by + S * 0.048], radius=int(S * 0.012), outline=(150, 156, 166), width=max(2, int(S * 0.008))
        )
        by += S * 0.075

    # the tick ("sathi" check) bottom-right, saffron ring + green check
    cx, cy, r = S * 0.72, S * 0.74, S * 0.155
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=SAFFRON)
    d.ellipse([cx - r * 0.86, cy - r * 0.86, cx + r * 0.86, cy + r * 0.86], fill=CREAM)
    pts = [
        (cx - r * 0.46, cy + r * 0.02),
        (cx - r * 0.10, cy + r * 0.38),
        (cx + r * 0.50, cy - r * 0.36),
    ]
    d.line(pts, fill=GREEN_LIGHT, width=max(3, int(S * 0.030)), joint="curve")

    return img.resize((size, size), Image.LANCZOS)


def main():
    draw_icon(192).save(os.path.join(OUT, "icon-192.png"))
    draw_icon(512).save(os.path.join(OUT, "icon-512.png"))
    # maskable: safe zone is the inner 80%, so pad more and use the full square
    draw_icon(512, padding_ratio=0.22, rounded=False).save(
        os.path.join(OUT, "icon-maskable-512.png")
    )
    # apple touch icon + favicon
    draw_icon(180).save(os.path.join(OUT, "apple-touch-icon.png"))
    draw_icon(32).save(os.path.join(OUT, "favicon-32.png"))
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
