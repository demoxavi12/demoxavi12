#!/usr/bin/env node
/**
 * generate-profile.mjs: renders the animated profile interface from real GitHub data.
 *
 *   node scripts/generate-profile.mjs            # uses GITHUB_TOKEN when set (CI)
 *
 * Writes
 *   assets/generated/profile.svg          desktop interface (880 px)
 *   assets/generated/profile-mobile.svg   stacked interface for phones (420 px)
 *
 * The profile boots once, in the order of the reference reel, then stops:
 *   init log -> ./contributions.sh types -> heatmap fills left to right ->
 *   whoami -> portrait draws itself (guides, silhouette, scene, hatching, render) ->
 *   stats count up -> monthly bars grow -> stack types -> ONLINE -> final frame, held.
 *
 * Every element's resting style is its final state, so a viewer that does not
 * animate (or prefers reduced motion) sees the finished profile, never a blank one.
 *
 * Data: GitHub REST (repos, languages, profile) and contributions from GraphQL
 * (with a token) or the public contributions page (without). Nothing is estimated.
 * The portrait comes from assets/portrait/portrait.svg (scripts/generate-portrait.py).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const USER = process.env.GITHUB_USER || 'demoxavi12';
const TOKEN = process.env.GITHUB_TOKEN || '';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'assets/generated');
const PORTRAIT = resolve(ROOT, 'assets/portrait/portrait.svg');

const ROLE = 'FULL STACK WEB DEVELOPER';
const STACK = ['React', 'TypeScript', 'Node.js', 'Express', 'MongoDB', 'Redis', 'Socket.IO', 'Java', 'Tailwind CSS'];

const headers = { 'User-Agent': `${USER}-profile`, Accept: 'application/vnd.github+json' };
if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

// ---------------------------------------------------------------- data ------
async function json(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

async function getRepos() {
  const repos = await json(`https://api.github.com/users/${USER}/repos?per_page=100&type=owner`);
  return repos.filter(r => !r.fork && !r.archived);
}

async function getLanguages(repos) {
  const totals = {};
  for (const r of repos) {
    const langs = await json(r.languages_url);
    for (const [lang, bytes] of Object.entries(langs)) totals[lang] = (totals[lang] || 0) + bytes;
  }
  return Object.entries(totals).sort((a, b) => b[1] - a[1]);
}

async function getContributionsGraphQL() {
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{
    weeks{contributionDays{date contributionCount}}}}}}`;
  const data = await json('https://api.github.com/graphql', { method: 'POST', body: JSON.stringify({ query, variables: { login: USER } }) });
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data.user.contributionsCollection.contributionCalendar.weeks
    .flatMap(w => w.contributionDays).map(d => ({ date: d.date, count: d.contributionCount }));
}

async function getContributionsPage() {
  const res = await fetch(`https://github.com/users/${USER}/contributions`, { headers: { 'User-Agent': headers['User-Agent'] } });
  if (!res.ok) throw new Error(`${res.status} contributions page`);
  const html = await res.text();
  const counts = {};
  for (const m of html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    const n = m[2].match(/^(\d[\d,]*) contribution/);
    counts[m[1]] = n ? Number(n[1].replace(/,/g, '')) : 0;
  }
  const days = [];
  for (const m of html.matchAll(/<td[^>]*data-date="(\d{4}-\d{2}-\d{2})"[^>]*id="([^"]+)"[^>]*>/g)) {
    days.push({ date: m[1], count: counts[m[2]] ?? 0 });
  }
  if (!days.length) throw new Error('could not parse contributions page');
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

function summarize(days) {
  let total = 0, active = 0, longest = 0, run = 0, best = days[0];
  for (const d of days) {
    total += d.count;
    if (d.count > best.count) best = d;
    if (d.count > 0) { active++; run++; longest = Math.max(longest, run); } else run = 0;
  }
  // current streak: today may still be empty, so it can start from yesterday
  let i = days.length - 1, current = 0;
  if (days[i].count === 0) i--;
  while (i >= 0 && days[i].count > 0) { current++; i--; }
  // last 12 calendar months, oldest first
  const months = new Map();
  for (const d of days) {
    const k = d.date.slice(0, 7);
    months.set(k, (months.get(k) || 0) + d.count);
  }
  const monthly = [...months.entries()].slice(-12).map(([k, c]) => ({ key: k, count: c }));
  return { total, active, longest, current, best, monthly };
}

// ------------------------------------------------------------ portrait ------
async function loadPortrait() {
  const svg = await readFile(PORTRAIT, 'utf8');
  const underlay = (svg.match(/href="(data:image\/jpeg;base64,[^"]+)"/) || [])[1] || '';
  const paths = [...svg.matchAll(/<path class="(\w+)" data-t="([\d.]+)" pathLength="1" d="([^"]+)"\/>/g)]
    .map(m => ({ layer: m[1], t: Number(m[2]), d: m[3] }));
  return { underlay, paths, size: Number((svg.match(/viewBox="0 0 (\d+)/) || [])[1] || 400) };
}

// ----------------------------------------------------------- animation ------
// One timeline of T seconds, played a single time (iteration-count 1, fill-mode
// both). Each helper returns a class whose keyframes hold the element in its
// *initial* state until `start`, play, then rest in the final state, where it
// stays once the timeline ends. Nothing restarts and nothing keeps moving.
const T = 10;   // one boot sequence; every animation runs once and holds its last frame
const pc = s => Math.max(0, Math.min(100, (s / T) * 100)).toFixed(2);
const q = s => Math.round(s * 20) / 20;
const EASE = 'cubic-bezier(.2,.7,.2,1)';

function animator() {
  const rules = new Map();
  const add = (name, keyframes, extra = '') => {
    if (!rules.has(name)) rules.set(name, `@keyframes ${name}{${keyframes}}.${name}{animation:${name} ${T}s linear 1 both${extra}}`);
    return name;
  };
  const id = (...a) => a.map(x => String(q(x)).replace('.', '_')).join('-');
  return {
    // fade (and optional rise) in at s
    show(s, dur = 0.35, rise = 0) {
      s = q(s);
      const from = rise ? `opacity:0;transform:translateY(${rise}px)` : 'opacity:0';
      const to = rise ? 'opacity:1;transform:translateY(0)' : 'opacity:1';
      return add(`v${id(s, dur, rise)}`, `0%,${pc(s)}%{${from};animation-timing-function:${EASE}}${pc(s + dur)}%,100%{${to}}`);
    },
    // visible only between a and b (default hidden): count-up steps, boot status
    win(a, b) {
      a = q(a); b = q(b);
      return add(`w${id(a, b)}`, `0%,${pc(a)}%{opacity:0}${pc(a + 0.01)}%,${pc(b)}%{opacity:1}${pc(b + 0.01)}%,100%{opacity:0}`, ';opacity:0');
    },
    // stroke draws in (paths use pathLength="1" and stroke-dasharray:1)
    draw(s, dur) {
      s = q(s); dur = q(Math.max(0.1, dur));
      return add(`d${id(s, dur)}`, `0%,${pc(s)}%{stroke-dashoffset:1;opacity:0;animation-timing-function:${EASE}}${pc(s + 0.05)}%{opacity:1}${pc(s + dur)}%,100%{stroke-dashoffset:0;opacity:1}`);
    },
    // bar grows from its baseline
    grow(s, dur = 0.6) {
      s = q(s);
      return add(`g${id(s, dur)}`, `0%,${pc(s)}%{transform:scaleY(0);animation-timing-function:${EASE}}${pc(s + dur)}%,100%{transform:scaleY(1)}`);
    },
    // heatmap cell: invisible, flashes bright as the wave passes, settles to its level
    cell(s, level, fill) {
      s = q(s);
      return add(`c${id(s)}l${level}`, `0%,${pc(s)}%{opacity:0;fill:${C.flash}}${pc(s + 0.08)}%{opacity:1;fill:${level ? C.flash : C.indigo}}${pc(s + 0.7)}%,100%{opacity:1;fill:${fill}}`);
    },
    // typing: a cover slides right in character steps, revealing the text
    type(s, dur, chars, width) {
      s = q(s); dur = q(dur);
      return add(`t${id(s, dur)}x${Math.round(width)}`,
        `0%,${pc(s)}%{opacity:1;transform:translateX(0);animation-timing-function:steps(${chars},end)}${pc(s + dur)}%{opacity:1;transform:translateX(${width}px)}${pc(s + dur + 0.25)}%,100%{opacity:0;transform:translateX(${width}px)}`, ';opacity:0');
    },
    // a bright line sweeping down a box once
    sweep(s, dur, dist) {
      s = q(s);
      return add(`s${id(s, dur)}y${Math.round(dist)}`, `0%,${pc(s)}%{opacity:0;transform:translateY(0)}${pc(s + 0.05)}%{opacity:1}${pc(s + dur - 0.05)}%{opacity:1}${pc(s + dur)}%,100%{opacity:0;transform:translateY(${dist}px)}`, ';opacity:0');
    },
    css: () => [...rules.values()].join('\n'),
  };
}

// ---------------------------------------------------------------- grain -----
// A small seeded noise tile, PNG-encoded by hand (zlib only). A filter like
// feTurbulence would be recomputed on every animation frame; a tile is not.
function noiseTile(size = 96, alpha = 14, seed = 7) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) / 4294967296);
  const raw = Buffer.alloc(size * (1 + size * 2));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 2)] = 0;
    for (let i = 0; i < size; i++) {
      const o = y * (1 + size * 2) + 1 + i * 2;
      raw[o] = 255;                                   // white grain…
      raw[o + 1] = Math.floor(rnd() * alpha);         // …at a few % opacity
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xFFFFFFFF; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 4;   // 8-bit grey + alpha
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
const GRAIN = noiseTile();

// --------------------------------------------------------------- render -----
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = n => n.toLocaleString('en-US');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = iso => { const d = new Date(iso + 'T00:00:00Z'); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const C = {
  bg: '#0C0B12', panel: '#08070D', chrome: '#14121D', line: '#1E1A2B', border: '#2B2640',
  text: '#ECE9F5', sub: '#A6A1B8', dim: '#6F6985',
  violet: '#8B5CF6', glow: '#B79CFF', indigo: '#6366F1', cyan: '#7DD3FC', flash: '#E6DDFF',
  // activity shades: violet-tinted, still read as a GitHub contribution graph
  levels: ['#17141F', '#2B1D57', '#4A2E9C', '#7A4FE6', '#B79CFF'],
};
const MONO_W = 0.62;  // generous monospace advance (em), so covers always clear the text

function render(layout, data) {
  const { W, mobile } = layout;
  const A = animator();
  const out = [];
  const add = s => out.push(s);
  let y = 0;
  const text = (x, yy, s, o = {}) =>
    `<text x="${x}" y="${yy}"${o.mono !== false ? ' class="mono"' : ' class="sans"'} font-size="${o.size || 11}"${o.weight ? ` font-weight="${o.weight}"` : ''} fill="${o.fill || C.sub}"${o.ls ? ` letter-spacing="${o.ls}"` : ''}${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.cls ? ` class="${o.cls}${o.mono !== false ? ' mono' : ' sans'}"` : ''}>${s}</text>`;

  // prompt line that types itself
  const prompt = (x, yy, cmd, start, speed = 0.045) => {
    const size = mobile ? 12 : 13;
    const cx = x + 18 * size * 0.575;
    const cw = cmd.length * size * MONO_W + 8;
    const dur = Math.max(0.3, cmd.length * speed + 0.15);
    add(`<g class="${A.show(start - 0.18, 0.08)}"><text x="${x}" y="${yy}" class="mono" font-size="${size}"><tspan fill="${C.violet}" font-weight="700">swaraj@github</tspan><tspan fill="${C.dim}"> ~ $</tspan></text>` +
      `<text x="${cx}" y="${yy}" class="mono" font-size="${size}" fill="${C.text}">${esc(cmd)}</text>` +
      `<g class="${A.type(start, dur, cmd.length, cw)}"><rect x="${cx - 1}" y="${yy - size}" width="${cw + 4}" height="${size + 6}" fill="${C.bg}"/><rect x="${cx - 1}" y="${yy - size + 1}" width="${size * 0.55}" height="${size + 2}" fill="${C.glow}"/></g></g>`);
    return start + dur;
  };

  // ---- window chrome ---------------------------------------------------------
  add(`<rect x=".5" y=".5" width="${W - 1}" height="__H__" rx="12" fill="${C.bg}" stroke="${C.border}"/>`);
  add(`<path d="M1 38H${W - 1}" stroke="${C.border}"/><path d="M12.5 1H${W - 12.5}A11.5 11.5 0 0 1 ${W - 1} 12.5V38H1V12.5A11.5 11.5 0 0 1 12.5 1Z" fill="${C.chrome}"/>`);
  [0, 1, 2].forEach(i => add(`<circle cx="${20 + i * 14}" cy="19" r="4.5" fill="${i === 2 ? C.violet : C.border}"/>`));
  add(text(66, 23, `${USER} / README.md`, { size: 11, fill: C.sub, ls: 0.5 }));
  const statusX = W - 20;
  add(`<g class="${A.win(0, 9)}">${text(statusX, 23, 'BOOTING', { size: 10.5, fill: C.dim, ls: 1.6, anchor: 'end' })}</g>`);
  add(`<g class="${A.show(9, 0.2)}"><circle cx="${statusX - 62}" cy="19.5" r="3.5" fill="${C.violet}"/>${text(statusX, 23, 'ONLINE', { size: 10.5, fill: C.violet, ls: 1.6, anchor: 'end', weight: 700 })}</g>`);
  y = 38;

  // ---- phase 2: init log ------------------------------------------------------
  const log = [
    ['init', 'profile.sys'],
    ['fetch', `contributions · ${data.days.length} days`],
    ['fetch', `repositories · ${data.repos.length}`],
  ];
  const lx = 24;
  if (mobile) {
    log.forEach(([a, b], i) => add(`<g class="${A.show(0.25 + i * 0.25, 0.15)}">${text(lx, 62 + i * 15, `<tspan fill="${C.violet}">[ ok ]</tspan> ${a} ${esc(b)}`, { size: 10, fill: C.dim })}</g>`));
    y = 62 + 3 * 15 + 6;
  } else {
    log.forEach(([a, b], i) => add(`<g class="${A.show(0.25 + i * 0.25, 0.15)}">${text(lx + i * 250, 62, `<tspan fill="${C.violet}">[ ok ]</tspan> ${a} ${esc(b)}`, { size: 10.5, fill: C.dim })}</g>`));
    y = 74;
  }

  // ---- phase 3: contribution grid --------------------------------------------
  y += 24;
  const afterP1 = prompt(lx, y, './contributions.sh', 0.95);
  const weeksShown = mobile ? 26 : 53;
  const days = data.days;
  const firstDow = new Date(days[0].date + 'T00:00:00Z').getUTCDay();
  const allCols = Math.ceil((days.length + firstDow) / 7);
  const startCol = Math.max(0, allCols - weeksShown);
  const gx0 = mobile ? 50 : 72;
  const step = (W - 24 - gx0) / weeksShown;
  const cell = step - (mobile ? 3 : 3.2);
  const gy0 = y + 32;
  const nz = days.map(d => d.count).filter(c => c > 0).sort((a, b) => a - b);
  const qv = f => nz[Math.min(nz.length - 1, Math.floor(f * nz.length))] ?? 1;
  const [q1, q2, q3] = [qv(0.25), qv(0.5), qv(0.75)];
  const level = c => (c === 0 ? 0 : c <= q1 ? 1 : c <= q2 ? 2 : c <= q3 ? 3 : 4);
  const waveStart = afterP1 + 0.15, waveDur = 2.6;
  let cells = '', months = '', lastM = -1, lastC = -9;
  days.forEach((d, i) => {
    const k = i + firstDow, col = Math.floor(k / 7) - startCol, dow = k % 7;
    if (col < 0) return;
    const x = gx0 + col * step, yy = gy0 + dow * step, lv = level(d.count);
    const s = waveStart + (col / weeksShown) * waveDur + dow * 0.012;
    cells += `<rect class="${A.cell(s, lv, C.levels[lv])}" x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" rx="2" fill="${C.levels[lv]}"><title>${d.count} on ${d.date}</title></rect>`;
    const m = new Date(d.date + 'T00:00:00Z').getUTCMonth();
    if (dow === 0 && m !== lastM && col - lastC >= 3 && col < weeksShown - 1) {
      months += text(x.toFixed(1), gy0 - 8, MON[m], { size: 9.5, fill: C.dim });
      lastM = m; lastC = col;
    }
  });
  add(`<g class="${A.show(afterP1, 0.3)}">${months}${[[1, 'Mon'], [3, 'Wed'], [5, 'Fri']].map(([r, t]) => text(gx0 - 8, (gy0 + r * step + cell - 1).toFixed(1), t, { size: 9, fill: C.dim, anchor: 'end' })).join('')}</g>`);
  // the wavefront: a glowing column that leads the fill
  const gridH = 7 * step;
  add(`<rect class="wave" x="${gx0 - 6}" y="${gy0 - 4}" width="6" height="${gridH + 4}" fill="url(#wave)" style="animation:wave ${T}s linear 1 both;opacity:0"/>`);
  add(cells);
  y = gy0 + gridH + 18;
  const capAt = waveStart + waveDur - 0.2;
  add(`<g class="${A.show(capAt, 0.3)}">${text(gx0, y, `<tspan fill="${C.text}" font-weight="700">${fmt(data.s.total)}</tspan> contributions in the last year${mobile ? ' · 26 weeks shown' : ''}`, { size: 10.5, fill: C.sub })}` +
    (mobile ? '' : `${text(W - 24 - 5 * 13 - 8, y, 'Less', { size: 9, fill: C.dim, anchor: 'end' })}${C.levels.map((c, i) => `<rect x="${W - 24 - (5 - i) * 13 + 1}" y="${y - 9}" width="10" height="10" rx="2" fill="${c}"/>`).join('')}`) + `</g>`);

  // ---- phase 4: whoami + portrait --------------------------------------------
  y += 40;
  const p2 = 2.35;
  const afterP2 = prompt(lx, y, 'whoami', p2, 0.08);
  y += 18;
  const pSize = mobile ? W - 48 : 372;
  const px0 = mobile ? 24 : 24, py0 = y;
  const ps = pSize / data.portrait.size;
  const art0 = afterP2 + 0.05;
  // frame + brackets
  add(`<g class="${A.show(art0, 0.3)}"><rect x="${px0}" y="${py0}" width="${pSize}" height="${pSize}" rx="10" fill="${C.panel}" stroke="${C.line}"/>` +
    [[0, 0, 1, 1], [pSize, 0, -1, 1], [0, pSize, 1, -1], [pSize, pSize, -1, -1]].map(([dx, dy, sx, sy]) =>
      `<path d="M${px0 + dx + sx * 2} ${py0 + dy + sy * 18}V${py0 + dy + sy * 2}H${px0 + dx + sx * 18}" fill="none" stroke="${C.violet}" stroke-width="2"/>`).join('') +
    text(px0 + 14, py0 + 20, 'avatar.png → lineart', { size: 9.5, fill: C.dim }) + `</g>`);
  // the drawing: layers in construction order
  const plan = { guide: [art0 + 0.1, 0.9, 0.7], shape: [art0 + 0.5, 1.9, 0.75], detail: [art0 + 1.1, 2.4, 0.5], tone: [art0 + 1.7, 2.5, 0.35] };
  let art = '';
  const style = {
    guide: `stroke="${C.indigo}" stroke-opacity=".7" stroke-width="1" stroke-dasharray="3 5"`,
    shape: `stroke="${C.text}" stroke-width="${(1.4 / ps).toFixed(2)}"`,
    detail: `stroke="#CFCAE0" stroke-opacity=".5" stroke-width="${(0.85 / ps).toFixed(2)}"`,
    tone: `stroke="${C.glow}" stroke-opacity=".45" stroke-width="${(0.8 / ps).toFixed(2)}"`,
  };
  const renderDone = art0 + 4.3;
  // underlay renders in after the lines (the "final illustration")
  // soft violet light behind the figure, rising with the guides
  art += `<circle cx="${data.portrait.size / 2}" cy="${data.portrait.size / 2}" r="${data.portrait.size * 0.5}" fill="url(#halo)" class="${A.show(art0 + 0.2, 1.2)}"/>`;
  art += `<image href="${data.portrait.underlay}" width="${data.portrait.size}" height="${data.portrait.size}" opacity=".26" class="${A.show(renderDone, 0.9)}"/>`;
  for (const layer of ['guide', 'detail', 'tone', 'shape']) {
    const [s0, span, dur] = plan[layer];
    const ps_ = data.portrait.paths.filter(p => p.layer === layer);
    const body = ps_.map(p => `<path class="${A.draw(s0 + p.t * span, dur)}" pathLength="1" d="${p.d}"/>`).join('');
    const guideStyle = layer === 'guide' ? '' : ' stroke-dasharray="1"';
    art += `<g fill="none" stroke-linecap="round" stroke-linejoin="round" ${style[layer].replace('stroke-dasharray="3 5"', '')}${guideStyle}${layer === 'shape' ? ' filter="url(#glow)"' : ''}>${body}</g>`;
  }
  add(`<g clip-path="url(#pclip)"><g transform="translate(${px0} ${py0}) scale(${ps.toFixed(4)})">${art}</g>` +
    // scan line passes as the render completes
    `<rect class="${A.sweep(renderDone - 0.2, 1.1, pSize)}" x="${px0}" y="${py0 - 2}" width="${pSize}" height="3" fill="${C.glow}" opacity=".0" filter="url(#glow)"/></g>`);
  // particles drifting off the drawing while it builds
  let parts = '';
  for (let i = 0; i < 14; i++) {
    const a = (i * 137.5) % 360, r = pSize * (0.18 + ((i * 53) % 30) / 100);
    const cx = px0 + pSize / 2 + Math.cos(a * Math.PI / 180) * r, cy = py0 + pSize / 2 + Math.sin(a * Math.PI / 180) * r;
    parts += `<circle class="${A.win(art0 + 0.6 + (i % 7) * 0.45, art0 + 2.2 + (i % 7) * 0.45)}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${i % 3 ? 1.2 : 1.8}" fill="${C.glow}"/>`;
  }
  add(parts);
  add(`<defs><clipPath id="pclip"><rect x="${px0 + 1}" y="${py0 + 1}" width="${pSize - 2}" height="${pSize - 2}" rx="9"/></clipPath></defs>`);

  // ---- identity + telemetry column ---------------------------------------------
  const rx = mobile ? 24 : px0 + pSize + 28;
  const rw = W - 24 - rx;
  let ry = mobile ? py0 + pSize + 44 : py0 + 34;
  const id0 = afterP2 + 0.2;
  add(`<g class="${A.show(id0, 0.5, 8)}">${text(rx - 2, ry, esc(data.name.toUpperCase()), { size: mobile ? 30 : 34, weight: 800, fill: C.text, mono: false, ls: 0.5 })}</g>`);
  ry += mobile ? 24 : 26;
  add(`<g class="${A.show(id0 + 0.2, 0.4)}">${text(rx, ry, ROLE, { size: 11.5, fill: C.violet, ls: 2.6, weight: 700 })}</g>`);
  ry += mobile ? 24 : 26;
  add(`<g class="${A.show(id0 + 0.4, 0.4)}">${text(rx, ry, esc(data.bio), { size: mobile ? 13.5 : 14.5, fill: C.sub, mono: false })}</g>`);
  ry += mobile ? 22 : 22;

  // stats: values count up
  const cols = mobile ? 2 : 3, gap = 10, tw = (rw - gap * (cols - 1)) / cols, th = 60;
  const tiles = [
    ['CONTRIBUTIONS', data.s.total, 'last year'],
    ['ACTIVE DAYS', data.s.active, 'last year'],
    ['BEST DAY', data.s.best.count, shortDate(data.s.best.date)],
    ['CURRENT STREAK', data.s.current, 'days'],
    ['LONGEST STREAK', data.s.longest, 'days'],
    ['REPOSITORIES', data.repos.length, 'public'],
  ];
  const st0 = id0 + 0.5;
  tiles.forEach(([label, value, unit], i) => {
    const x = rx + (i % cols) * (tw + gap), yy = ry + Math.floor(i / cols) * (th + gap);
    const s = st0 + i * 0.12;
    let digits = '';
    const steps = 9;
    for (let k = 0; k < steps; k++) {
      const v = Math.round(value * (1 - Math.pow(1 - k / steps, 2.2)));
      digits += `<text x="${x + 12}" y="${yy + 44}" class="sans ${A.win(s + k * 0.11, s + (k + 1) * 0.11)}" font-size="${mobile ? 22 : 24}" font-weight="800" fill="${C.text}">${fmt(v)}</text>`;
    }
    digits += `<g class="${A.show(s + steps * 0.11, 0.01)}"><text x="${x + 12}" y="${yy + 44}" class="sans" font-size="${mobile ? 22 : 24}" font-weight="800" fill="${C.text}">${fmt(value)}<tspan class="mono" font-size="9.5" font-weight="400" fill="${C.dim}" dx="6">${esc(unit)}</tspan></text></g>`;
    add(`<g class="${A.show(s - 0.05, 0.25, 6)}"><rect x="${x}" y="${yy}" width="${tw}" height="${th}" rx="8" fill="${C.panel}" stroke="${C.line}"/><rect x="${x + 12}" y="${yy}" width="20" height="2" fill="${C.violet}"/>${text(x + 12, yy + 20, label, { size: 9, fill: C.dim, ls: 1.3 })}</g>${digits}`);
  });
  ry += Math.ceil(tiles.length / cols) * (th + gap) + 18;

  // monthly bars grow left to right
  const bars0 = st0 + 1.0;
  const mpeak = Math.max(1, ...data.s.monthly.map(m => m.count));
  const bh = mobile ? 70 : 64, bgap = 6, bw = (rw - bgap * 11) / 12;
  add(`<g class="${A.show(bars0 - 0.1, 0.3)}">${text(rx, ry, 'CONTRIBUTIONS / MONTH', { size: 9, fill: C.dim, ls: 1.3 })}${text(rx + rw, ry, `peak ${fmt(mpeak)}`, { size: 9, fill: C.dim, anchor: 'end' })}</g>`);
  ry += 10;
  data.s.monthly.forEach((m, i) => {
    const h = Math.max(2, (m.count / mpeak) * bh), x = rx + i * (bw + bgap);
    const peak = m.count === mpeak;
    add(`<rect class="${A.grow(bars0 + i * 0.08, 0.55)} bar" x="${x.toFixed(1)}" y="${(ry + bh - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${peak ? C.glow : m.count ? C.levels[3] : C.levels[1]}"${peak ? ' filter="url(#glow)"' : ''}/>`);
    add(`<g class="${A.show(bars0 + i * 0.08, 0.2)}">${text((x + bw / 2).toFixed(1), ry + bh + 14, MON[Number(m.key.slice(5)) - 1][0], { size: 9, fill: peak ? C.glow : C.dim, anchor: 'middle' })}</g>`);
  });
  ry += bh + 46;

  // languages
  const lang0 = bars0 + 1.2;
  const totalBytes = data.languages.reduce((a, [, b]) => a + b, 0) || 1;
  const top = data.languages.slice(0, 3);
  const rest = data.languages.slice(3).reduce((a, [, b]) => a + b, 0);
  if (rest) top.push(['Other', rest]);
  const shades = [C.violet, C.indigo, C.cyan, '#4A4560'];
  let bx = rx, lbar = '', legend = '', lgx = rx, lgy = 0;
  const labelY = ry - 12;
  top.forEach(([name, bytes], i) => {
    const w = Math.max(3, (bytes / totalBytes) * rw);
    lbar += `<rect x="${bx.toFixed(1)}" y="${ry}" width="${(w - 2).toFixed(1)}" height="6" rx="3" fill="${shades[i]}"/>`;
    bx += w;
    const label = `${name} ${((bytes / totalBytes) * 100).toFixed(1)}%`;
    const lw = 22 + label.length * 6.4;
    if (lgx + lw - 12 > rx + rw) { lgx = rx; lgy += 18; }        // wrap on narrow layouts
    legend += `<circle cx="${lgx + 4}" cy="${ry + 21 + lgy}" r="3.5" fill="${shades[i]}"/>${text(lgx + 12, ry + 25 + lgy, esc(label), { size: 10, fill: C.sub })}`;
    lgx += lw;
  });
  ry += lgy;
  add(`<g class="${A.show(lang0, 0.4)}">${text(rx, labelY, 'LANGUAGES · BY BYTES', { size: 9, fill: C.dim, ls: 1.3 })}${lbar}${legend}</g>`);
  ry += 34;

  // ---- stack --------------------------------------------------------------------
  y = Math.max(py0 + pSize, ry) + 36;
  const p3 = lang0 + 0.4;
  const afterP3 = prompt(lx, y, 'cat stack.txt', p3);
  y += 26;
  const lines = mobile ? [STACK.slice(0, 4), STACK.slice(4)] : [STACK];
  let t0 = afterP3 + 0.1;
  lines.forEach((ln, i) => {
    const s = ln.join('  ·  ');
    const size = mobile ? 12.5 : 13.5;
    add(`<g class="${A.show(t0 - 0.02, 0.02)}"><text x="${lx}" y="${y}" class="mono" font-size="${size}" fill="${C.text}">${ln.map(esc).join(`<tspan fill="${C.violet}">  ·  </tspan>`)}</text>`);
    const w = s.length * size * MONO_W + 10;
    const dur = s.length * 0.018;
    add(`<g class="${A.type(t0, dur, s.length, w)}"><rect x="${lx - 2}" y="${y - size}" width="${w + 6}" height="${size + 6}" fill="${C.bg}"/><rect x="${lx - 2}" y="${y - size + 1}" width="${size * 0.55}" height="${size + 2}" fill="${C.glow}"/></g></g>`);
    t0 += dur + 0.05;
    y += 22;
  });

  // ---- status bar -------------------------------------------------------------
  y += 8;
  add(`<path d="M1 ${y}H${W - 1}" stroke="${C.line}"/>`);
  y += 22;
  const synced = `synced ${data.synced} · github api`;
  add(`<g class="${A.show(9, 0.3)}">${text(lx, y, `<tspan fill="${C.violet}">●</tspan> ready · ${data.repos.length} repos · ${fmt(data.s.total)} contributions`, { size: 10, fill: C.dim })}` +
    (mobile ? text(lx, y + 16, synced, { size: 10, fill: C.dim }) : text(W - 24, y, synced, { size: 10, fill: C.dim, anchor: 'end' })) + `</g>`);
  const H = y + (mobile ? 32 : 16);

  const desc = `${data.name}, ${ROLE.toLowerCase()}. ${data.bio} ${fmt(data.s.total)} contributions in the last year over ${data.s.active} active days; best day ${data.s.best.count} on ${data.s.best.date}; current streak ${data.s.current}, longest ${data.s.longest} days; ${data.repos.length} public repositories. Stack: ${STACK.join(', ')}. Portrait: line art traced from the GitHub avatar, a hooded figure on a mountain ridge at sunrise.`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(data.name)} · GitHub profile</title>
<desc id="d">${esc(desc)}</desc>
<defs>
<clipPath id="win"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="11"/></clipPath>
<filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<pattern id="scan" width="4" height="3" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#FFFFFF" opacity=".022"/></pattern>
<pattern id="grain" width="96" height="96" patternUnits="userSpaceOnUse"><image href="${GRAIN}" width="96" height="96"/></pattern>
<linearGradient id="power" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.glow}" stop-opacity="0"/><stop offset=".5" stop-color="${C.glow}" stop-opacity=".22"/><stop offset="1" stop-color="${C.glow}" stop-opacity="0"/></linearGradient>
<radialGradient id="halo"><stop offset="0" stop-color="${C.violet}" stop-opacity=".32"/><stop offset=".6" stop-color="${C.indigo}" stop-opacity=".1"/><stop offset="1" stop-color="${C.indigo}" stop-opacity="0"/></radialGradient>
<linearGradient id="wave" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.glow}" stop-opacity="0"/><stop offset="1" stop-color="${C.glow}" stop-opacity=".9"/></linearGradient>
</defs>
<style>
.mono{font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace}
.sans{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif}
.bar{transform-box:fill-box;transform-origin:50% 100%}
.power{opacity:0;animation:power ${T}s linear 1 both}
@keyframes power{0%{opacity:1;transform:translateY(0)}${pc(0.9)}%{opacity:1;transform:translateY(${H + 60}px)}${pc(0.95)}%,100%{opacity:0;transform:translateY(${H + 60}px)}}
@keyframes wave{0%,${pc(waveStart)}%{opacity:0;transform:translateX(0)}${pc(waveStart + 0.05)}%{opacity:1}${pc(waveStart + waveDur)}%{opacity:1;transform:translateX(${(weeksShown * step).toFixed(1)}px)}${pc(waveStart + waveDur + 0.3)}%,100%{opacity:0;transform:translateX(${(weeksShown * step).toFixed(1)}px)}}
${A.css()}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<g>
${out.join('\n').replace('__H__', H - 1)}
<g clip-path="url(#win)"><rect width="${W}" height="${H}" fill="url(#scan)"/><rect width="${W}" height="${H}" fill="url(#grain)"/><rect class="power" y="-60" width="${W}" height="60" fill="url(#power)"/></g>
</g>
</svg>
`;
  return svg;
}

// ----------------------------------------------------------------- main -----
// --cached reuses the last live fetch (.cache/, git-ignored), handy while iterating
// on the design without spending the 60/hour unauthenticated API budget.
const CACHE = resolve(ROOT, '.cache/profile-data.json');
let profile, repos, languages, days;
if (process.argv.includes('--cached')) {
  ({ profile, repos, languages, days } = JSON.parse(await readFile(CACHE, 'utf8')));
} else {
  [profile, repos] = await Promise.all([json(`https://api.github.com/users/${USER}`), getRepos()]);
  languages = await getLanguages(repos);
  try {
    days = TOKEN ? await getContributionsGraphQL() : await getContributionsPage();
  } catch (err) {
    console.warn(`primary contribution source failed (${err.message}); trying fallback`);
    days = TOKEN ? await getContributionsPage() : await getContributionsGraphQL();
  }
  await mkdir(dirname(CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify({ profile: { name: profile.name, bio: profile.bio }, repos: repos.map(r => ({ name: r.name })), languages, days }));
}
const data = {
  name: profile.name || USER,
  bio: (profile.bio || '').split('•').pop().trim() || 'Building, learning, and shipping.',
  repos, languages, days, s: summarize(days),
  portrait: await loadPortrait(),
  synced: new Date().toISOString().slice(0, 10),
};
await mkdir(OUT_DIR, { recursive: true });
for (const [file, layout] of [['profile.svg', { W: 880, mobile: false }], ['profile-mobile.svg', { W: 420, mobile: true }]]) {
  const svg = render(layout, data);
  await writeFile(resolve(OUT_DIR, file), svg);
  console.log(`${file}: ${(svg.length / 1024).toFixed(0)} KB`);
}
console.log(`data: ${repos.length} repos, ${days.length} days, ${data.s.total} contributions, best ${data.s.best.count} on ${data.s.best.date}, current streak ${data.s.current}`);
