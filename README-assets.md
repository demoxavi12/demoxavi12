# Profile assets: how this README is built

Everything the profile shows is a file in this repository. There are no
third-party stats widgets, no icon fonts, no external fonts and no JavaScript
in `README.md`.

```
.
├── README.md                          the profile
├── README-assets.md                   this file
├── .github/workflows/telemetry.yml    daily telemetry refresh
├── assets/
│   ├── hero/       player-original.png  player.gif  identity.svg
│   ├── labels/     stack · log · exploring · telemetry · connect (.svg)
│   ├── tech/       constellation.svg
│   ├── system/     build-log.svg
│   ├── exploring/  dsa · backend · ai · product (.svg)
│   ├── generated/  telemetry.svg        written by scripts/generate-telemetry.mjs
│   └── connect/    github · linkedin · leetcode · portfolio · mail (.svg)
└── scripts/
    ├── generate-hero-art.py
    └── generate-telemetry.mjs
```

## Setup

The profile repo is `demoxavi12/demoxavi12`. For the telemetry to refresh:
**Settings → Actions → General → Workflow permissions → Read and write**, then
**Actions → telemetry → Run workflow** once. It then runs daily at 03:17 UTC and
only commits when the numbers change.

## Composition

Energy steps down as you scroll:

| Section             | Intensity | Motion                                                        |
|---------------------|-----------|---------------------------------------------------------------|
| hero                | ★★★★★     | pixel-art loop · scrolling grid · particles · light streaks · name shine · orbit |
| tech constellation  | ★★★★      | data flowing along edges · particles travel to each core node · halos · core wave |
| engineering log     | ★★★       | a comet runs down the timeline · NOW ring                     |
| currently exploring | ★★★       | status pulse · an edge glint                                  |
| telemetry           | ★★★       | chart scan cursor · LIVE pulse                                |
| connect             | ★★        | slow halo breathing                                           |
| footer              | ★         | text only                                                     |

The hero is two images: `player.gif` (360 px) and `identity.svg` (450 px). Side by
side they total 810 px, which fits GitHub's ~831 px profile column on wide
screens. On laptops and phones they wrap, and the art stacks above the name.
The exploring cards (280 px) wrap the same way: 2×2 on desktop, one column on phones.

Colour tokens: background `#07090C`, hairline `#16202B`, text `#EEF1F5`,
secondary `#8A94A3`, and the single accent `#5CC8FF`. Labels that sit directly
on GitHub's page background use `#6B8196`, which reads on both themes. Every
animation is CSS or SMIL inside the SVG, and all of it stops under `prefers-reduced-motion`.

## Hero art: `scripts/generate-hero-art.py`

```bash
pip install pillow numpy opencv-python-headless
python scripts/generate-hero-art.py --preview   # → assets/hero/player.gif (+ preview sheet)
```

1. **Isolate:** GrabCut separates the player and ball from the energy sphere,
   seeded with ellipses tuned to this image.
2. **Pixelate:** the image is resampled to 180×215 art pixels and mapped to one
   shared ~97-colour palette with Bayer ordered dithering. It's then upscaled ×2
   with nearest-neighbour and given CRT row shading.
3. **Animate (6 s loop, 10 fps):**
   - the arena (player inpainted out) drifts 1 px behind him (parallax)
   - the sphere's hex lines breathe, and an energy arc sweeps around it
   - two layers of sparks rise off the floor
   - the ball's glow pulses
   - one scan line passes
4. **Encode:** the exact palette (190 colours) is shared by every frame, and
   frames are delta-encoded. Result: 3.4 MB.

The player is never redrawn or warped; every sprite pixel comes from the image.
Tuning constants (sphere, ball, segmentation seeds) sit at the top of the script.

## Telemetry: `scripts/generate-telemetry.mjs`

`node scripts/generate-telemetry.mjs` (Node 18+, no installs).

- Repos and languages: GitHub REST API, public non-fork repos. Language share
  is by bytes.
- Contributions: GraphQL `contributionCalendar` with `GITHUB_TOKEN` (in the
  Action), or the public contributions page (local runs).
- Weekly activity is the last 52 weeks summed from those days. It's used instead
  of a heatmap because GitHub already shows the heatmap right under the README.

## GitHub compatibility

- The only HTML used is what GitHub keeps: `p align="center"`, `img` with
  `width`/`alt`, `a`, `br`, `sub`, `code`. The README was rendered through
  GitHub's Markdown API to confirm this.
- SVGs are loaded as images, so scripts never run, but their CSS/SMIL animation plays.
- Brand glyphs (GitHub, LinkedIn, LeetCode) are from Simple Icons (CC0),
  embedded as paths in the icon SVGs.
