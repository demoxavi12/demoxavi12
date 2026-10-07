# How this profile is built

The profile is one animated interface, `assets/generated/profile.svg`, that
"boots up" the way the reference reel does, plus a stacked version for phones
and a row of links. `README.md` only assembles those images. There is no
JavaScript, no third-party stats service, and no external font anywhere.

```
README.md                         the profile: interface + connect icons
README-assets.md                  this file
.github/workflows/telemetry.yml   daily re-render from live GitHub data
assets/
  generated/profile.svg           desktop interface, 880 px   (generated)
  generated/profile-mobile.svg    stacked interface, 420 px   (generated)
  portrait/avatar.png             the GitHub avatar, source of the portrait
  portrait/portrait.svg           line art traced from it     (generated)
  connect/*.svg                   GitHub, LinkedIn, Portfolio, LeetCode, Email
scripts/
  generate-portrait.py            avatar -> portrait.svg
  generate-profile.mjs            GitHub data + portrait -> profile*.svg
```

## Run it

```bash
pip install numpy opencv-python-headless       # portrait only
python scripts/generate-portrait.py --refresh  # re-download the avatar and trace it
node scripts/generate-profile.mjs              # fetch live data, render both SVGs
node scripts/generate-profile.mjs --cached     # re-render from the last fetch (.cache/)
```

Without a token the GitHub API allows 60 requests an hour. A render uses about
a dozen, so use `--cached` while you are tweaking the design.

Preview: open `assets/generated/profile.svg` in a browser. To freeze a moment,
open the browser console on that tab and run
`document.getAnimations().forEach(a => { a.pause(); a.currentTime = 4000 })`
(4000 = 4 s into the loop).

## The boot sequence (16 s loop)

| Time       | What happens                                                            |
|------------|-------------------------------------------------------------------------|
| 0.0–0.9 s  | power-on sweep; `[ ok ]` init lines tick in; status reads BOOTING      |
| 0.9–1.9 s  | `swaraj@github ~ $ ./contributions.sh` types out                        |
| 2.1–4.7 s  | contribution grid fills left to right behind a glowing wavefront; each cell flashes bright and settles to its real shade |
| 2.4–3.0 s  | `$ whoami` types out                                                    |
| 3.0–8.2 s  | the portrait draws itself: dashed construction guides → glowing silhouette → scene lines → hatching → the duotone render fades in under a scan line, with particles drifting off it |
| 3.2–4.0 s  | name, role and bio slide in                                             |
| 3.7–5.3 s  | six stat tiles appear and their numbers count up                       |
| 4.7–6.1 s  | contributions-per-month bars grow left to right; the peak glows         |
| 5.9 s      | language share appears                                                  |
| 6.3–8.6 s  | `$ cat stack.txt` types, then the stack types out                       |
| 9.0 s      | status flips to ● ONLINE; the status bar appears                        |
| 9–15.3 s   | hold on the finished profile                                            |
| 15.3–16 s  | fade out, loop                                                          |

Every element's resting style is its finished state. So a viewer that does
not animate, or has reduced motion turned on, sees the complete profile and
never a blank one.

## The portrait

`generate-portrait.py` traces the avatar. It never invents anything:

- **silhouette:** GrabCut separates the hooded figure from the scene, and its
  outline becomes the main glowing line.
- **folds:** Canny edges inside the figure.
- **hatching:** engraving-style strokes, only in the figure's shadows,
  crossed where they are darkest.
- **scene:** sparse edges for the ridgelines, clouds and rocks.
- **guides:** the frame ring, the horizon and the sun.
- **render:** a green duotone of the avatar, embedded as a small JPEG, that
  fades in last.

Each path is tagged with its layer and a top-to-bottom order (`data-t`).
`generate-profile.mjs` turns that order into the drawing animation. The
seed coordinates at the top of the script (figure ellipses, horizon, sun) are
tuned for the current avatar. If you change the avatar, re-tune them and run
it again.

## Data

Every number comes from GitHub. Repositories and languages use the REST API
(public, non-fork, non-archived repos). Contributions use the GraphQL calendar
in CI and the public contributions page locally. Derived values:

- **current streak:** consecutive active days up to today. Today may still be
  empty, so it can start from yesterday.
- **best day:** the single day with the most contributions.
- **heatmap shades:** quartiles of the active days, the way GitHub shades them.
- **phone layout:** the last 26 weeks of the grid. The total is still the full year.

The Action runs daily (and on demand). It only commits when the numbers
change, not when just the sync date does. It needs **Settings → Actions →
General → Workflow permissions → Read and write**.

## GitHub limits that shaped this

- No JavaScript in a README. All motion is CSS `@keyframes` inside the SVGs,
  which GitHub serves as images; image SVGs still run CSS animations.
- One animation clock per image. The interface is a single SVG so every phase
  stays in sync. The connect icons are separate images, so they can't join
  the boot timeline; they only have a slow glow.
- Links can't sit inside an SVG image, so the clickable icons live outside it,
  in the README.
- `<picture>` with `media="(max-width: 600px)"` serves the stacked layout on
  narrow screens. The GitHub mobile app may still show the desktop SVG, scaled
  down.
- Text in an SVG image uses the viewer's system fonts (SF Mono, Consolas,
  Menlo…), so letter widths vary a little. The typing covers allow for that.
- GitHub caches images through its camo proxy, so a new render can take a few
  minutes to show up.
