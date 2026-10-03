#!/usr/bin/env python3
"""
generate-hero-art.py: turns assets/hero/player-original.png into the animated
pixel-art profile card used in the hero (assets/hero/player.gif).

Pipeline
  1. isolate   GrabCut separates the player and ball from the energy sphere,
               seeded with ellipses tuned for this image (coordinates below).
  2. pixelate  everything is resampled to a low "logical" resolution and mapped
               onto one shared palette with Bayer 4x4 ordered dithering.
  3. animate   one seamless loop, layered back to front:
                 - stage: the arena (player inpainted out) drifts 1 px: parallax
                 - sphere: hex lines breathe, and an energy arc sweeps around it
                 - sparks: two layers of pixels rise off the floor
                 - sprite: player + ball, the ball's glow pulses
                 - scan: one bright line passes top to bottom
  4. finish    nearest-neighbour upscale, CRT row shading, HUD corner brackets,
               exact palette, delta-encoded GIF.

The player is never redrawn or warped; every sprite pixel is sampled from the image.

Requirements:  Python 3.9+,  pip install pillow numpy opencv-python-headless
Usage:         python scripts/generate-hero-art.py [--scale 2] [--preview]
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "hero" / "player-original.png"
OUT = ROOT / "assets" / "hero" / "player.gif"

# ---- tuned for player-original.png (245 x 295), in source pixels -------------
CROP = (0, 2, 245, 295)
SPHERE = (133, 140, 93)                          # cx, cy, r
BALL = (184, 265, 17)                            # cx, cy, r
FG_PROBABLE = [(137, 185, 46, 112), (184, 265, 21, 21)]
FG_SURE = [(137, 92, 9, 12), (138, 160, 20, 32), (126, 238, 9, 34), (150, 238, 9, 34), (184, 265, 12, 12)]
BG_SURE_RECTS = [(0, 0, 245, 68), (0, 0, 84, 295), (206, 0, 245, 295), (168, 68, 206, 240)]
FLOOR_Y = 258

# ---- card --------------------------------------------------------------------
CARD_W, CARD_H = 360, 430
ACCENT = np.array([92, 200, 255], np.float32)    # #5CC8FF
PALETTE_SIZE = 48
FPS, SECONDS = 10, 6.0
BAYER = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], np.float32) / 16 - 0.47


def isolate(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    mask = np.full((h, w), cv2.GC_PR_BGD, np.uint8)
    for cx, cy, rx, ry in FG_PROBABLE:
        cv2.ellipse(mask, (cx, cy), (rx, ry), 0, 0, 360, cv2.GC_PR_FGD, -1)
    for x0, y0, x1, y1 in BG_SURE_RECTS:
        mask[y0:y1, x0:x1] = cv2.GC_BGD
    for cx, cy, rx, ry in FG_SURE:
        cv2.ellipse(mask, (cx, cy), (rx, ry), 0, 0, 360, cv2.GC_FGD, -1)
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    cv2.grabCut(cv2.cvtColor(img, cv2.COLOR_RGB2BGR), mask, None, bgd, fgd, 8, cv2.GC_INIT_WITH_MASK)
    fg = ((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD)).astype(np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    return fg.astype(np.float32)


def kmeans(px: np.ndarray, k: int, seed: int = 3) -> np.ndarray:
    rng = np.random.default_rng(seed)
    px = px[rng.choice(len(px), min(len(px), 30_000), replace=False)].astype(np.float32)
    order = np.argsort(px @ np.array([0.3, 0.59, 0.11], np.float32))
    c = px[order[np.linspace(0, len(px) - 1, k).astype(int)]].copy()
    for _ in range(20):
        lab = np.argmin(((px[:, None] - c[None]) ** 2).sum(-1), 1)
        for j in range(k):
            m = px[lab == j]
            if len(m):
                c[j] = m.mean(0)
    return c


def map_palette(img: np.ndarray, pal: np.ndarray, dither: float) -> np.ndarray:
    h, w = img.shape[:2]
    t = np.tile(BAYER, (h // 4 + 1, w // 4 + 1))[:h, :w, None] * dither
    flat = (img + t).reshape(-1, 3)
    idx = np.argmin(((flat[:, None] - pal[None]) ** 2).sum(-1), 1)
    return pal[idx].reshape(h, w, 3)


def build(scale: int):
    src = np.asarray(Image.open(SRC).convert("RGB"))
    alpha = isolate(src)
    x0, y0, x1, y1 = CROP
    lw, lh = CARD_W // scale, CARD_H // scale
    f = lw / (x1 - x0)                                                   # source px -> logical px

    def L(img, interp=cv2.INTER_AREA):
        return cv2.resize(img[y0:y1, x0:x1], (lw, lh), interpolation=interp)

    # stage without the player: inpaint at source resolution, then downsample
    hole = cv2.dilate(alpha.astype(np.uint8), np.ones((5, 5), np.uint8))
    stage_src = cv2.inpaint(src, hole, 5, cv2.INPAINT_TELEA)
    pad = 2                                                              # room for parallax drift
    stage = cv2.resize(stage_src[y0:y1, x0:x1], (lw + 2 * pad, lh + 2 * pad), interpolation=cv2.INTER_AREA).astype(np.float32)
    sprite = L(src).astype(np.float32)
    a = L(alpha) > 0.5

    # one palette for everything: image colours + brighter energy variants
    base = np.concatenate([stage.reshape(-1, 3), sprite[a]])
    pal = kmeans(base, PALETTE_SIZE)
    pal = np.vstack([pal, np.clip(pal * 1.3 + 25, 0, 255), [[235, 252, 255]]])
    pal = np.unique(pal.round(), axis=0).astype(np.float32)

    # geometry in logical space
    scx, scy, sr = (SPHERE[0] - x0) * f + pad, (SPHERE[1] - y0) * f + pad, SPHERE[2] * f
    yy, xx = np.mgrid[0:lh + 2 * pad, 0:lw + 2 * pad].astype(np.float32)
    dist = np.hypot(xx - scx, yy - scy)
    ang = np.arctan2(yy - scy, xx - scx)
    lum = stage @ np.array([0.3, 0.59, 0.11], np.float32)
    hexlines = (dist < sr * 1.04) & (lum > np.percentile(lum[dist < sr], 70))
    rim = np.exp(-((dist - sr) / 2.2) ** 2)

    bcx, bcy, br = (BALL[0] - x0) * f, (BALL[1] - y0) * f, BALL[2] * f
    ys, xs = np.mgrid[0:lh, 0:lw].astype(np.float32)
    ball = (np.hypot(xs - bcx, ys - bcy) < br) & a
    floor = (FLOOR_Y - y0) * f

    rng = np.random.default_rng(10)
    n = round(FPS * SECONDS)
    sparks = [(rng.uniform(lw * 0.12, lw * 0.9), rng.uniform(0, 1), cyc, rng.uniform(0.25, 1.0))
              for cyc in (1, 1, 1, 2, 2) for _ in range(9)]

    frames = []
    for i in range(n):
        p = i / n
        s = stage.copy()
        # sphere: breathing hex lines + an arc of energy sweeping around the rim
        breath = 0.5 + 0.5 * math.sin(2 * math.pi * p * 2)
        sweep = np.cos(ang - 2 * math.pi * p) ** 14 * ((np.cos(ang - 2 * math.pi * p) > 0))
        energy = hexlines * (0.08 + 0.18 * breath) + (rim * 0.38 + hexlines * 0.32) * sweep
        s = s * (1 + energy[..., None] * 0.9) + energy[..., None] * ACCENT * 0.35
        dx = round(math.sin(2 * math.pi * p))                           # parallax: 1 px drift
        img = s[pad: pad + lh, pad + dx: pad + dx + lw].copy()

        # sparks rising off the floor
        for (sx, ph, cyc, bright) in sparks:
            q = (p * cyc + ph) % 1
            y = floor - q * floor * 0.75
            x = sx + 2 * math.sin(2 * math.pi * (q * 2 + ph))
            fade = math.sin(math.pi * q) * bright
            xi, yi = int(x), int(y)
            if 0 <= xi < lw and 0 <= yi < lh:
                img[yi, xi] = img[yi, xi] * (1 - fade) + np.array([210, 245, 255]) * fade

        # sprite on top; the ball glows on the beat
        spr = sprite.copy()
        glow = 0.5 + 0.5 * math.sin(2 * math.pi * (p * 2 - 0.25))
        spr[ball] = np.clip(spr[ball] * (1 + 0.25 * glow) + ACCENT * 0.12 * glow, 0, 255)
        img[a] = spr[a]

        # scan line
        if 0.55 < p < 0.85:
            sy = int((p - 0.55) / 0.3 * (lh + 6)) - 3
            for d, g in ((0, 1.0), (-1, 0.4), (1, 0.4)):
                if 0 <= sy + d < lh:
                    img[sy + d] = img[sy + d] * (1 + 0.35 * g) + ACCENT * 0.08 * g
        frames.append(map_palette(np.clip(img, 0, 255), pal, dither=18.0))
    return frames


def finish(frames, scale: int):
    W, H = CARD_W, CARD_H
    hud = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(hud)
    acc = (92, 200, 255, 255)
    for (x, y, sx, sy) in ((6, 6, 1, 1), (W - 7, 6, -1, 1), (6, H - 7, 1, -1), (W - 7, H - 7, -1, -1)):
        d.line([(x, y), (x + sx * 18, y)], fill=acc, width=2)
        d.line([(x, y), (x, y + sy * 18)], fill=acc, width=2)
    try:
        font = ImageFont.truetype("consolab.ttf", 11)
    except OSError:
        font = ImageFont.load_default()
    d.rectangle([14, 14, 106, 30], fill=(7, 9, 12, 255))
    d.text((19, 16), "PLAYER // SX", font=font, fill=(200, 230, 245, 255))
    hud_np = np.asarray(hud, np.float32)
    hud_a = (hud_np[..., 3:4] > 127).astype(np.float32)                  # hard edges keep the palette small
    inks = np.array([acc[:3], (200, 230, 245), (7, 9, 12)], np.float32)   # snap anti-aliased text to its inks
    nearest_ink = np.argmin(((hud_np[..., None, :3] - inks) ** 2).sum(-1), -1)
    hud_np = np.concatenate([inks[nearest_ink], hud_np[..., 3:4]], -1)

    rows = np.ones((H, 1, 1), np.float32)
    if scale > 1:
        rows[scale - 1:: scale] = 0.82                                    # CRT row shading

    out = []
    for fr in frames:
        big = np.repeat(np.repeat(fr, scale, 0), scale, 1)[:H, :W] * rows
        big = big * (1 - hud_a) + hud_np[..., :3] * hud_a
        out.append(np.clip(big + 0.5, 0, 255).astype(np.uint8))

    colours = np.unique(np.concatenate([o.reshape(-1, 3) for o in out]), axis=0)
    assert len(colours) <= 256, f"{len(colours)} colours; lower PALETTE_SIZE"
    pimg = Image.new("P", (1, 1))
    flat = colours.ravel().tolist()
    pimg.putpalette(flat + [0] * (768 - len(flat)))
    return [Image.fromarray(o).quantize(palette=pimg, dither=Image.Dither.NONE) for o in out], len(colours)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scale", type=int, default=2, help="screen pixels per art pixel")
    ap.add_argument("--output", type=Path, default=OUT)
    ap.add_argument("--preview", action="store_true", help="also write a contact sheet PNG next to the output")
    args = ap.parse_args()

    frames = build(args.scale)
    gif, ncol = finish(frames, args.scale)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    gif[0].save(args.output, save_all=True, append_images=gif[1:], duration=round(1000 / FPS),
                loop=0, disposal=1, optimize=False)
    if args.preview:
        picks = [gif[round(k * (len(gif) - 1) / 3)].convert("RGB") for k in range(4)]
        sheet = Image.new("RGB", (CARD_W * 4, CARD_H))
        for k, fr in enumerate(picks):
            sheet.paste(fr, (k * CARD_W, 0))
        sheet.save(args.output.with_name(args.output.stem + "-preview.png"))
    print(f"{args.output.name}: {len(gif)} frames, {CARD_W}x{CARD_H}, {ncol} colours, "
          f"{args.output.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
