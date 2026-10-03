# Profile assets — how this README is built

Everything the profile shows is a file in this repository. There are no
third-party stats widgets, no external fonts and no JavaScript in `README.md`.

```
.
├── README.md                          the profile
├── README-assets.md                   this file
├── .github/workflows/telemetry.yml    daily telemetry refresh
├── assets/
│   ├── system/   hero.svg  status.svg  timeline.svg  footer.svg
│   ├── tech/     constellation.svg
│   ├── projects/ pulseops.svg  realtime-chat.svg  nist-fc.svg  ecommerce.svg
│   ├── generated/telemetry.svg        written by scripts/generate-telemetry.mjs
│   └── messi/    messi-original.webp  messi-signature.gif
└── scripts/
    ├── generate-messi-animation.py
    └── generate-telemetry.mjs
```

## Setup

1. Create a public repository named exactly **`demoxavi12`** (GitHub shows its
   README on your profile).
2. Copy this folder into it and push to the default branch.
3. Repository → **Settings → Actions → General → Workflow permissions** → choose
   **Read and write permissions** (the telemetry job commits the refreshed SVG).
4. **Actions → telemetry → Run workflow** once to confirm it works. After that it
   runs daily at 03:17 UTC and only commits when the numbers change.

## Design system

| Token       | Value     | Use                                    |
|-------------|-----------|----------------------------------------|
| background  | `#07090C` | every panel                            |
| hairline    | `#141B24` | dividers, frames                       |
| text        | `#EEF1F5` | names, numbers                         |
| secondary   | `#8A94A3` | subtitles, status                      |
| dim         | `#4F5A69` | mono labels                            |
| accent      | `#5CC8FF` | the only colour; signals and state     |

Type is the platform's own system sans and monospace stack, so nothing depends
on a web font loading. Every panel is a self-contained dark "screen", which is
why the page reads the same on GitHub's light and dark themes.

Motion, all CSS inside the SVG files, all slow, all switched off under
`prefers-reduced-motion`:

| Where         | Motion                                   | Why it's there                         |
|---------------|------------------------------------------|----------------------------------------|
| hero          | orbit, scanline, cursor, status pulse    | the "system is running" first read     |
| status        | BUILD → LEARN → SHIP → REPEAT steps      | it's a loop, so it loops               |
| constellation | signals travel core → clusters           | shows it's a connected system          |
| chat card     | one message walks the persist→ack path   | that ordering *is* the feature         |
| e-commerce    | order status steps through its lifecycle | same lifecycle the admin drives        |
| build log     | ring on NOW                              | marks the present                      |
| Messi         | GIF micro-animation                      | the signature piece                    |

## Telemetry

`node scripts/generate-telemetry.mjs` (Node 18+, no installs).

- Repositories and languages: GitHub REST API, public non-fork repos you own.
  Language share is by bytes, as GitHub reports it.
- Contributions: GraphQL `contributionCalendar` when `GITHUB_TOKEN` is set (in
  the Action); otherwise the public contributions page (local runs).
- Each square has a `<title>` with its date and count.

## The Messi animation

```bash
pip install pillow numpy
python scripts/generate-messi-animation.py            # → assets/messi/messi-signature.gif
python scripts/generate-messi-animation.py --preview  # + contact sheet with the masks drawn on
```

The photo is never warped. Only the camera, the light and the depth of field
move, in five phases over an 8-second loop:

1. **Still** (0.6 s): the exact photograph.
2. **Push-in** (1.9 s): a 4.5% zoom drifting toward the kiss. The background
   layer zooms at 72% of the subject's rate, which reads as depth (parallax), and
   softens slightly, like a focus pull.
3. **Trophy light** (2.1 s): a warm highlight travels up the trophy from the
   base to the globe. It's a screen blend weighted by the trophy's own brightness
   and warmth, so it only catches the gold.
4. **Film scan** (1.5 s): a faint light line crosses the frame.
5. **Return** (1.4 s): everything eases back to frame one, so the loop is seamless.

Size: 600×382, 10 fps, 4.3 MB. Two choices keep it small without visible loss:

- Phases 3 and 4 happen while the camera holds still, so GIF stores only the
  rectangle that changed (the trophy, then a thin stripe).
- One 192-colour palette is shared by every frame, fitted with k-means to the
  actual pixels so the gold and the green band keep their true colour. Because
  the palette is shared, unchanged pixels stay identical between frames.

Smaller file: `--width 520 --colors 128` (about 3 MB). To use a different photo,
change the fractions at the top of the script (`CROP`, `FOCUS`, `TROPHY_*`,
`SUBJECT`) and check them with `--preview`.

## GitHub compatibility notes

- Only HTML that GitHub's sanitizer keeps: `p`/`div` with `align`, `img` with
  `width`/`alt`, `a`, `code`, `sub`, `b`, `br`, `details`/`summary`. The README
  was rendered through GitHub's Markdown API to confirm this.
- SVGs are referenced as images (`<img src="assets/…svg">`). GitHub serves them
  with scripts disabled, but CSS animation inside them plays. No `<script>`,
  `foreignObject` or external references are used.
- Easter egg: `/secret/mode` under the hero links to `#10--signature`, the anchor
  GitHub generates for the heading `10 — SIGNATURE`. The `<details>` block under
  the photo is the second layer, and it explains why the sections jump from 07 to 10.
- Text inside the SVGs scales with the image. Everything a reader needs (links,
  email) is real Markdown, and every image has full alt text.
