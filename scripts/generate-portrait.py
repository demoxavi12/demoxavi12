#!/usr/bin/env python3
"""
generate-portrait.py: turns the GitHub avatar into line art the profile draws in.

    python scripts/generate-portrait.py            # use assets/portrait/avatar.png
    python scripts/generate-portrait.py --refresh  # download the current avatar first
    python scripts/generate-portrait.py --preview  # also write portrait-preview.png

Output: assets/portrait/portrait.svg, a standalone static drawing. Every <path>
carries a layer class and a data-t value (0..1, its place in the drawing order);
scripts/generate-telemetry.mjs reads them and turns that order into animation.

Layers, drawn in this order:
  guide    construction geometry: the frame ring, horizon and axis guides
  shape    long silhouette and structure edges
  tone     iso-luminance contour lines that carry the shading
  detail   short edges and texture

Nothing is invented: every line is traced from the avatar's own edges and tones.

Requirements: Python 3.9+, pip install numpy opencv-python-headless
"""
from __future__ import annotations

import argparse
import base64
import math
import urllib.request
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "assets" / "portrait"
AVATAR = DIR / "avatar.png"
OUT = DIR / "portrait.svg"
AVATAR_URL = "https://avatars.githubusercontent.com/u/184986591?v=4&s=460"

SIZE = 400                 # drawing box in the profile, px
WORK = 460                 # analysis resolution
CIRCLE = (230, 230, 196)   # usable disc inside the avatar's own ring (cx, cy, r at WORK px)
HORIZON_Y = 182           # ridgeline height in the avatar
SUN = (365, 155)          # sun centre
FIGURE_SEEDS = [(180, 150, 28, 35), (150, 230, 30, 40), (200, 280, 45, 25), (255, 325, 20, 10), (290, 265, 12, 10)]


def load(refresh: bool) -> np.ndarray:
    DIR.mkdir(parents=True, exist_ok=True)
    if refresh or not AVATAR.exists():
        req = urllib.request.Request(AVATAR_URL, headers={"User-Agent": "demoxavi12-profile"})
        AVATAR.write_bytes(urllib.request.urlopen(req, timeout=30).read())
    img = cv2.imdecode(np.frombuffer(AVATAR.read_bytes(), np.uint8), cv2.IMREAD_COLOR)
    return cv2.resize(img, (WORK, WORK), interpolation=cv2.INTER_AREA)


def disc_mask(inset: int = 0) -> np.ndarray:
    m = np.zeros((WORK, WORK), np.uint8)
    cv2.circle(m, CIRCLE[:2], CIRCLE[2] - inset, 255, -1)
    return m


def polylines(binary: np.ndarray, eps: float, min_len: float, closed_ok: bool = True):
    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    out = []
    for c in contours:
        if cv2.arcLength(c, closed_ok) < min_len:
            continue
        a = cv2.approxPolyDP(c, eps, closed_ok)[:, 0, :].astype(np.float32)
        if len(a) >= 2:
            out.append(a)
    return out


def figure_mask(img: np.ndarray) -> np.ndarray:
    """GrabCut the hooded figure out of the scene (seeds tuned for this avatar)."""
    m = np.full((WORK, WORK), cv2.GC_BGD, np.uint8)
    m[90:355, 65:320] = cv2.GC_PR_BGD
    cv2.ellipse(m, (175, 215), (95, 115), 0, 0, 360, cv2.GC_PR_FGD, -1)
    for cx, cy, rx, ry in FIGURE_SEEDS:
        cv2.ellipse(m, (cx, cy), (rx, ry), 0, 0, 360, cv2.GC_FGD, -1)
    bgd, fgd = np.zeros((1, 65)), np.zeros((1, 65))
    cv2.grabCut(img, m, None, bgd, fgd, 8, cv2.GC_INIT_WITH_MASK)
    fg = ((m == cv2.GC_FGD) | (m == cv2.GC_PR_FGD)).astype(np.uint8) * 255
    n, lab, st, _ = cv2.connectedComponentsWithStats(fg)
    if n > 1:
        fg = ((lab == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])) * 255).astype(np.uint8)
    return cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))


def length(l: np.ndarray) -> float:
    return float(np.linalg.norm(np.diff(l, axis=0), axis=1).sum()) if len(l) > 1 else 0.0


def open_edges(edges: np.ndarray, min_len: float, eps: float):
    """Trace 1-px Canny edges as open strokes (each contour walks out and back, keep one way)."""
    out = []
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    for c in contours:
        pts = c[:, 0, :]
        half = pts[: max(2, len(pts) // 2 + 1)]
        a = cv2.approxPolyDP(half.reshape(-1, 1, 2), eps, False)[:, 0, :].astype(np.float32)
        if len(a) >= 2 and length(a) >= min_len:
            out.append(a)
    return out


def hatch(region: np.ndarray, angle_deg: float, spacing: float, min_len: float = 5):
    """Straight hatch strokes at one angle, clipped to a region mask."""
    th = math.radians(angle_deg)
    yy, xx = np.mgrid[0:WORK, 0:WORK].astype(np.float32)
    u = xx * math.cos(th) + yy * math.sin(th)
    v = -xx * math.sin(th) + yy * math.cos(th)
    on = (np.abs(v - np.round(v / spacing) * spacing) < 0.55) & (region > 0)
    n, lab = cv2.connectedComponents(on.astype(np.uint8), connectivity=8)
    out = []
    flat_lab, flat_u = lab.ravel(), u.ravel()
    order = np.argsort(flat_lab, kind="stable")
    bounds = np.searchsorted(flat_lab[order], np.arange(1, n + 1))
    for k in range(1, n):
        idx = order[bounds[k - 1]: bounds[k]]
        if len(idx) < min_len:
            continue
        i0, i1 = idx[np.argmin(flat_u[idx])], idx[np.argmax(flat_u[idx])]
        p0 = np.array([i0 % WORK, i0 // WORK], np.float32)
        p1 = np.array([i1 % WORK, i1 // WORK], np.float32)
        if np.linalg.norm(p1 - p0) >= min_len:
            out.append(np.stack([p0, p1]))
    return out


def guides():
    cx, cy, r = CIRCLE
    ring = [np.array([[cx + r * math.cos(a), cy + r * math.sin(a)] for a in np.linspace(-math.pi / 2, 1.5 * math.pi, 97)], np.float32)]
    arc = [np.array([[cx + (r + 9) * math.cos(a), cy + (r + 9) * math.sin(a)] for a in np.linspace(-2.3, 0.5, 40)], np.float32)]
    horizon = [np.array([[cx - r * 0.97, HORIZON_Y], [cx + r * 0.97, HORIZON_Y]], np.float32)]
    sx, sy = SUN
    sun = [np.array([[sx + 11 * math.cos(a), sy + 11 * math.sin(a)] for a in np.linspace(0, 2 * math.pi, 33)], np.float32)]
    rays = [np.array([[sx + 17 * math.cos(a), sy + 17 * math.sin(a)], [sx + 25 * math.cos(a), sy + 25 * math.sin(a)]], np.float32)
            for a in np.linspace(math.pi, 2 * math.pi, 7)]
    return ring + arc + horizon + sun + rays


def build(img: np.ndarray):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    disc = disc_mask(10)
    fig = figure_mask(img)
    fig_in = cv2.erode(fig, np.ones((5, 5), np.uint8))
    scene = cv2.bitwise_and(disc, cv2.bitwise_not(cv2.dilate(fig, np.ones((7, 7), np.uint8))))

    # shape: the figure's silhouette plus its strongest inner folds
    outline, _ = cv2.findContours(fig, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    shape = [cv2.approxPolyDP(c, 0.9, True)[:, 0, :].astype(np.float32) for c in outline if len(c) > 40]
    shape = [np.vstack([s_, s_[:1]]) for s_ in shape]
    smooth = cv2.bilateralFilter(gray, 9, 35, 9)
    folds = cv2.Canny(smooth, 40, 110) & fig_in
    shape += open_edges(folds, 22, 1.1)

    # tone: engraving-style hatching inside the figure, denser where it is darker
    lum = cv2.GaussianBlur(gray, (0, 0), 2.5)
    mid = ((lum < 112) & (fig_in > 0)).astype(np.uint8) * 255
    dark = ((lum < 62) & (fig_in > 0)).astype(np.uint8) * 255
    tone = hatch(mid, -38, 4.6) + hatch(dark, 52, 4.2)

    # detail: the scene, ridgelines, cloud banks and rocks, kept sparse
    sc = cv2.Canny(cv2.bilateralFilter(gray, 9, 50, 9), 45, 120) & scene
    detail = open_edges(sc, 30, 1.5)
    return {"guide": guides(), "shape": shape, "tone": tone, "detail": detail}


def order(lines):
    # top to bottom, left to right: the drawing builds the way the eye reads it
    keys = [(float(l[:, 1].min()), float(l[:, 0].min())) for l in lines]
    idx = sorted(range(len(lines)), key=lambda i: keys[i])
    n = max(1, len(lines) - 1)
    return [(lines[i], k / n) for k, i in enumerate(idx)]


def to_d(pts: np.ndarray, scale: float) -> str:
    p = pts * scale
    return "M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in p)


def underlay(img: np.ndarray) -> str:
    """Duotone of the avatar for the final 'rendered' state, embedded as JPEG."""
    small = cv2.resize(img, (SIZE, SIZE), interpolation=cv2.INTER_AREA)
    g = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
    g = np.clip((g - 0.12) * 1.25, 0, 1) ** 1.1
    dark, light = np.array([23, 17, 13], np.float32), np.array([120, 231, 126], np.float32)  # BGR: #0d1117 -> #7ee787
    duo = dark + (light - dark) * g[..., None]
    m = np.zeros((SIZE, SIZE), np.float32)
    cv2.circle(m, (SIZE // 2, SIZE // 2), int(CIRCLE[2] * SIZE / WORK) - 2, 1.0, -1)
    m = cv2.GaussianBlur(m, (0, 0), 3)[..., None]
    duo = duo * m + np.array([23, 17, 13], np.float32) * (1 - m)
    ok, buf = cv2.imencode(".jpg", duo.astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 72])
    return base64.b64encode(buf.tobytes()).decode()


def write_svg(layers, img: np.ndarray):
    s = SIZE / WORK
    style = {"guide": 'stroke="#2EA043" stroke-opacity=".55" stroke-width="1" stroke-dasharray="3 5"',
             "shape": 'stroke="#E6EDF3" stroke-width="1.35"',
             "tone": 'stroke="#7EE787" stroke-opacity=".55" stroke-width=".8"',
             "detail": 'stroke="#C9D1D9" stroke-opacity=".7" stroke-width=".8"'}
    parts = []
    counts = {}
    for name, lines in layers.items():
        ordered = order(lines)
        counts[name] = len(ordered)
        paths = "\n".join(f'    <path class="{name}" data-t="{t:.3f}" pathLength="1" d="{to_d(l, s)}"/>' for l, t in ordered)
        parts.append(f'  <g class="layer-{name}" fill="none" stroke-linecap="round" stroke-linejoin="round" {style[name]}>\n{paths}\n  </g>')
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" width="{SIZE}" height="{SIZE}" role="img" aria-label="Line-art portrait traced from the GitHub avatar: a hooded figure sitting on a mountain ridge at sunrise">
  <rect width="{SIZE}" height="{SIZE}" fill="#0D1117"/>
  <!--UNDERLAY-START--><image class="underlay" href="data:image/jpeg;base64,{underlay(img)}" width="{SIZE}" height="{SIZE}" opacity=".32"/><!--UNDERLAY-END-->
  <!--ART-START-->
{chr(10).join(parts)}
  <!--ART-END-->
</svg>
'''
    OUT.write_text(svg, encoding="utf-8")
    return counts


def preview(layers):
    canvas = np.full((WORK, WORK, 3), (23, 17, 13), np.uint8)
    col = {"guide": (64, 160, 46), "tone": (126, 231, 126), "detail": (217, 209, 201), "shape": (243, 237, 230)}
    for name in ("guide", "tone", "detail", "shape"):
        for l in layers[name]:
            cv2.polylines(canvas, [l.astype(np.int32)], False, col[name], 1, cv2.LINE_AA)
    cv2.imwrite(str(DIR / "portrait-preview.png"), canvas)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="download the current GitHub avatar first")
    ap.add_argument("--preview", action="store_true")
    args = ap.parse_args()
    img = load(args.refresh)
    layers = build(img)
    counts = write_svg(layers, img)
    if args.preview:
        preview(layers)
    print(f"portrait.svg: {counts}, {OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
