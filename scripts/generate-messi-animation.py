#!/usr/bin/env python3
"""
generate-messi-animation.py — turns one photograph into an "alive photograph" GIF.

Nothing in the photo is warped or re-animated. Only the *camera*, the *light*
and the *depth of field* move, the way a slow cinematic insert shot would:

    phase            time    what changes                      pixels touched
    -------------    -----   -------------------------------   --------------
    1  still         0-8%    nothing                           none
    2  push-in       8-32%   zoom 1.0 -> 1.045, drift to the   all
                             kiss, background zooms slower
                             (parallax) and softens (focus)
    3  trophy light  34-60%  a warm highlight travels up the   trophy only
                             trophy, base -> crown
    4  film scan     61-80%  a faint light line crosses the    one stripe
                             frame left -> right
    5  return        82-100% everything eases back to rest     all

Phases 3 and 4 run while the camera is *holding*, so only a small region of each
frame changes. GIF stores just that changed rectangle, which is what keeps the
file small without dropping quality on the frames where everything moves.

Requirements:  Python 3.9+,  pip install pillow numpy
Usage:
    python scripts/generate-messi-animation.py
    python scripts/generate-messi-animation.py --width 520 --colors 128   # smaller file
    python scripts/generate-messi-animation.py --preview              # also writes a contact sheet

Coordinates for the trophy / subject below are fractions of the *cropped* photo,
tuned for assets/messi/messi-original.webp. If you swap the photo, adjust them
and run with --preview to check the masks (they are drawn on the contact sheet).
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_IN = ROOT / "assets" / "messi" / "messi-original.webp"
DEFAULT_OUT = ROOT / "assets" / "messi" / "messi-signature.gif"

# --- photo-specific tuning (fractions of the cropped image) -------------------
CROP = (0.005, 0.018, 0.965, 1.0)        # trims the black border on the top/right edges
FOCUS = (0.59, 0.27)                   # the kiss: where the camera drifts toward
TROPHY_BASE = (0.107, 0.535)              # green-banded base of the trophy
TROPHY_CROWN = (0.57, 0.157)            # top of the globe
TROPHY_HALF_WIDTH = 0.105                # how far the trophy extends across its axis
SUBJECT = [                              # ellipses (cx, cy, rx, ry) covering Messi + trophy
    (0.70, 0.58, 0.31, 0.60),            # head, torso, shirt
    (0.32, 0.50, 0.26, 0.54),            # trophy + both arms
]

# --- motion tuning ------------------------------------------------------------
ZOOM_MAX = 0.045          # 4.5% push-in: felt more than seen
PAN_MAX = 0.55            # fraction of the available margin used to drift toward FOCUS
BG_ZOOM_RATIO = 0.72      # background zooms at 72% of the subject -> depth
BG_SOFTEN = 1.4           # px of extra blur on the background at full push (rack focus)
LIGHT_STRENGTH = 0.42     # peak strength of the trophy highlight
SCAN_STRENGTH = 0.055     # peak brightness lift of the film scan line
BREATH = 0.018            # exposure lift at full push
VIGNETTE = 0.20
GRAIN = 0.0               # optional static film grain (std-dev, 0-255); costs ~0.4 MB per unit
BG_CLEAN = 1.6            # px blur on the (already blurry) crowd to strip compression noise


def smooth(x: float) -> float:
    x = min(max(x, 0.0), 1.0)
    return x * x * x * (x * (x * 6 - 15) + 10)  # smootherstep


def ramp(t: float, a: float, b: float) -> float:
    return smooth((t - a) / (b - a))


def bump(t: float, a: float, b: float) -> float:
    """0 -> 1 -> 0 between a and b, eased (sine)."""
    if t <= a or t >= b:
        return 0.0
    return math.sin(math.pi * (t - a) / (b - a)) ** 2


def envelope(t: float) -> dict:
    push = ramp(t, 0.08, 0.32) * (1 - ramp(t, 0.82, 1.0))
    return {
        "push": push,
        "light_pos": ramp(t, 0.35, 0.59),     # 0 = base, 1 = crown
        "light_amp": bump(t, 0.34, 0.60),
        "scan_pos": ramp(t, 0.61, 0.80),      # 0 = left, 1 = right
        "scan_amp": bump(t, 0.61, 0.80),
    }


def ellipse_mask(w: int, h: int, ellipses, feather: float) -> Image.Image:
    m = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(m)
    for cx, cy, rx, ry in ellipses:
        d.ellipse([(cx - rx) * w, (cy - ry) * h, (cx + rx) * w, (cy + ry) * h], fill=255)
    return m.filter(ImageFilter.GaussianBlur(feather))


def trophy_geometry(w: int, h: int):
    """Per-pixel coordinate along the trophy axis (0 base..1 crown) and a soft trophy mask."""
    bx, by = TROPHY_BASE[0] * w, TROPHY_BASE[1] * h
    cx, cy = TROPHY_CROWN[0] * w, TROPHY_CROWN[1] * h
    ax, ay = cx - bx, cy - by
    length = math.hypot(ax, ay)
    ux, uy = ax / length, ay / length
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    rx, ry = xx - bx, yy - by
    along = (rx * ux + ry * uy) / length               # 0..1 along the trophy
    across = np.abs(-rx * uy + ry * ux) / (TROPHY_HALF_WIDTH * w)
    mask = np.exp(-(across ** 2) * 1.6) * np.clip(1.15 - np.abs(along - 0.5) * 2, 0, 1) ** 0.6
    return along, mask.astype(np.float32)


def affine(src: Image.Image, out_w: int, out_h: int, zoom: float, pan: tuple[float, float]) -> Image.Image:
    """Camera: scale the full photo to the output, zoom by `zoom` around centre + pan (source px)."""
    sw, sh = src.size
    s = sw / out_w / zoom
    cx, cy = sw / 2 + pan[0], sh / 2 + pan[1]
    data = (s, 0, cx - s * out_w / 2, 0, s, cy - s * out_h / 2)
    return src.transform((out_w, out_h), Image.AFFINE, data, resample=Image.BICUBIC)


def build_frames(photo: Image.Image, width: int, fps: int, seconds: float):
    sw, sh = photo.size
    # The crowd is already out of focus; smoothing its compression noise is
    # invisible but makes every full-motion frame far cheaper to encode.
    if BG_CLEAN:
        crowd = ImageOps.invert(ellipse_mask(sw, sh, SUBJECT, feather=sw * 0.03))
        photo = Image.composite(photo.filter(ImageFilter.GaussianBlur(BG_CLEAN)), photo, crowd)
    out_w = width
    out_h = round(width * sh / sw / 2) * 2
    n = round(fps * seconds)

    base = np.asarray(photo, dtype=np.float32) / 255.0
    along, tmask = trophy_geometry(sw, sh)
    luma = base @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    warm = np.clip((base[..., 0] - base[..., 2]) * 2.2, 0, 1)        # gold reflects warm
    tmask = tmask * (0.25 + 0.75 * luma ** 1.4) * (0.4 + 0.6 * warm)
    soft_photo = photo.filter(ImageFilter.GaussianBlur(BG_SOFTEN))

    subj = np.asarray(ellipse_mask(out_w, out_h, SUBJECT, feather=out_w * 0.045), dtype=np.float32)[..., None] / 255
    yy, xx = np.mgrid[0:out_h, 0:out_w].astype(np.float32)
    r = np.hypot((xx - out_w / 2) / (out_w / 2), (yy - out_h / 2) / (out_h / 2)) / math.sqrt(2)
    vignette = (1 - VIGNETTE * r ** 2.2)[..., None]
    grain = np.random.default_rng(10).normal(0, GRAIN / 255, (out_h, out_w, 1)).astype(np.float32)

    # drift toward FOCUS, never further than the zoom margin allows
    fx, fy = (FOCUS[0] - 0.5) * sw, (FOCUS[1] - 0.5) * sh
    margin_x = sw / 2 * (1 - 1 / (1 + ZOOM_MAX))
    margin_y = sh / 2 * (1 - 1 / (1 + ZOOM_MAX))
    pan_x = max(-margin_x, min(margin_x, fx)) * PAN_MAX
    pan_y = max(-margin_y, min(margin_y, fy)) * PAN_MAX

    frames = []
    for i in range(n):
        e = envelope(i / n)
        p = e["push"]

        # 1. light on the trophy, applied in photo space so it sticks to the object
        src = photo
        if e["light_amp"] > 1e-3:
            centre = -0.15 + 1.3 * e["light_pos"]
            band = np.exp(-((along - centre) / 0.085) ** 2)
            h = (band * tmask * LIGHT_STRENGTH * e["light_amp"])[..., None]
            tint = np.array([1.0, 0.92, 0.76], dtype=np.float32)
            lit = 1 - (1 - base) * (1 - h * tint)                      # screen blend
            src = Image.fromarray((lit * 255 + 0.5).clip(0, 255).astype(np.uint8))

        # 2. camera: subject and background move at different rates -> parallax
        zoom = 1 + ZOOM_MAX * p
        fg = affine(src, out_w, out_h, zoom, (pan_x * p, pan_y * p))
        if p > 1e-3:
            bg_src = Image.blend(photo, soft_photo, min(1.0, p)) if BG_SOFTEN else photo
            bg = affine(bg_src, out_w, out_h, 1 + ZOOM_MAX * p * BG_ZOOM_RATIO,
                        (pan_x * p * BG_ZOOM_RATIO, pan_y * p * BG_ZOOM_RATIO))
            a = np.asarray(fg, dtype=np.float32) / 255
            b = np.asarray(bg, dtype=np.float32) / 255
            img = a * subj + b * (1 - subj)
        else:
            img = np.asarray(fg, dtype=np.float32) / 255

        # 3. exposure breath, film scan, vignette, grain
        img = img * (1 + BREATH * p)
        if e["scan_amp"] > 1e-3:
            sx = (-0.1 + 1.2 * e["scan_pos"]) * out_w
            line = np.exp(-((xx - sx) / (out_w * 0.012)) ** 2) + 0.35 * np.exp(-((xx - sx) / (out_w * 0.07)) ** 2)
            img = img + (SCAN_STRENGTH * e["scan_amp"] * line)[..., None] * (0.6 + 0.4 * img)
        img = img * vignette + grain
        frames.append(Image.fromarray((img * 255 + 0.5).clip(0, 255).astype(np.uint8)))
    return frames


def quantize_all(frames, colors: int, dither: bool):
    """One shared palette for every frame: unchanged pixels stay identical between frames."""
    picks = frames[:: max(1, len(frames) // 8)]
    w, h = frames[0].size
    sheet = Image.new("RGB", (w, h * len(picks)))
    for k, f in enumerate(picks):
        sheet.paste(f, (0, h * k))
    # Median-cut drifts small saturated areas (gold, the green band) toward their
    # neighbours, so refine an octree palette with a few rounds of k-means.
    seed = sheet.quantize(colors=colors, method=Image.Quantize.FASTOCTREE)
    centres = np.array(seed.getpalette()[: colors * 3], dtype=np.float32).reshape(-1, 3)
    px = np.asarray(sheet, dtype=np.float32).reshape(-1, 3)
    px = px[np.random.default_rng(7).choice(len(px), min(len(px), 120_000), replace=False)]
    for _ in range(14):
        labels = np.concatenate([
            np.argmin(((chunk[:, None, :] - centres[None]) ** 2).sum(-1), axis=1)
            for chunk in np.array_split(px, 12)
        ])
        for k in range(len(centres)):
            members = px[labels == k]
            if len(members):
                centres[k] = members.mean(0)
    palette = Image.new("P", (1, 1))
    flat = np.clip(centres + 0.5, 0, 255).astype(np.uint8).ravel().tolist()
    palette.putpalette(flat + [0] * (768 - len(flat)))
    mode = Image.Dither.FLOYDSTEINBERG if dither else Image.Dither.NONE
    return [f.quantize(palette=palette, dither=mode) for f in frames]


def contact_sheet(frames, photo: Image.Image, path: Path):
    picks = [frames[round(k * (len(frames) - 1) / 7)] for k in range(8)]
    w, h = picks[0].size
    tw, th = w // 2, h // 2
    sheet = Image.new("RGB", (tw * 4, th * 3), "#07090C")
    for k, f in enumerate(picks):
        sheet.paste(f.convert("RGB").resize((tw, th)), ((k % 4) * tw, (k // 4) * th))
    # masks overlay so the tuning constants can be checked
    guide = photo.resize((tw, th)).convert("RGB")
    d = ImageDraw.Draw(guide)
    for cx, cy, rx, ry in SUBJECT:
        d.ellipse([(cx - rx) * tw, (cy - ry) * th, (cx + rx) * tw, (cy + ry) * th], outline="#5CC8FF")
    d.line([TROPHY_BASE[0] * tw, TROPHY_BASE[1] * th, TROPHY_CROWN[0] * tw, TROPHY_CROWN[1] * th], fill="#FFD27A", width=2)
    d.ellipse([FOCUS[0] * tw - 4, FOCUS[1] * th - 4, FOCUS[0] * tw + 4, FOCUS[1] * th + 4], fill="#FF5C5C")
    sheet.paste(guide, (0, th * 2))
    sheet.save(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", type=Path, default=DEFAULT_IN)
    ap.add_argument("--output", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--width", type=int, default=600)
    ap.add_argument("--fps", type=int, default=10)
    ap.add_argument("--seconds", type=float, default=8.0)
    ap.add_argument("--colors", type=int, default=192)
    ap.add_argument("--dither", action="store_true", help="Floyd-Steinberg dithering (smoother, larger file)")
    ap.add_argument("--preview", action="store_true", help="also write <output>-preview.png")
    args = ap.parse_args()

    photo = Image.open(args.input).convert("RGB")
    w, h = photo.size
    photo = photo.crop((round(CROP[0] * w), round(CROP[1] * h), round(CROP[2] * w), round(CROP[3] * h)))

    frames = build_frames(photo, args.width, args.fps, args.seconds)
    indexed = quantize_all(frames, args.colors, args.dither)

    frame_ms = round(1000 / args.fps)
    # Pillow merges identical consecutive frames and stores only the changed
    # rectangle of each frame (disposal=1 keeps the previous frame underneath).
    indexed[0].save(
        args.output, save_all=True, append_images=indexed[1:],
        duration=frame_ms, loop=0, disposal=1, optimize=False,
    )
    if args.preview:
        contact_sheet(frames, photo, args.output.with_name(args.output.stem + "-preview.png"))

    size = args.output.stat().st_size / 1e6
    print(f"{args.output.name}: {len(frames)} frames, {frames[0].size[0]}x{frames[0].size[1]}, "
          f"{len(frames) * frame_ms / 1000:.1f}s loop, {size:.2f} MB")


if __name__ == "__main__":
    main()
