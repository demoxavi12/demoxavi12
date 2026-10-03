#!/usr/bin/env node
/**
 * generate-telemetry.mjs — renders assets/generated/telemetry.svg from real GitHub data.
 *
 * No dependencies, no third-party stats service. Node 18+ (built-in fetch).
 *
 *   node scripts/generate-telemetry.mjs                # uses GITHUB_TOKEN if set
 *   GITHUB_USER=someone node scripts/generate-telemetry.mjs
 *
 * Data sources
 *   repos + languages   GitHub REST API (public, non-fork repos owned by the user)
 *   contributions       GraphQL contributionCalendar when GITHUB_TOKEN is set (CI),
 *                       otherwise the public contributions page (local runs)
 *
 * Every number on the card is computed from those responses. Nothing is estimated.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USER = process.env.GITHUB_USER || 'demoxavi12';
const TOKEN = process.env.GITHUB_TOKEN || '';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'assets/generated/telemetry.svg');

const headers = { 'User-Agent': `${USER}-profile-telemetry`, Accept: 'application/vnd.github+json' };
if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

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
  const data = await json('https://api.github.com/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables: { login: USER } }),
  });
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data.user.contributionsCollection.contributionCalendar.weeks
    .flatMap(w => w.contributionDays)
    .map(d => ({ date: d.date, count: d.contributionCount }));
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

function stats(days) {
  let total = 0, active = 0, longest = 0, run = 0;
  for (const d of days) {
    total += d.count;
    if (d.count > 0) { active++; run++; longest = Math.max(longest, run); } else run = 0;
  }
  return { total, active, longest };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fmt = n => n.toLocaleString('en-US');

function render({ repos, languages, days, synced }) {
  const W = 880, H = 400;
  const s = stats(days);
  const cell = 12, gap = 3, x0 = 40, y0 = 196;

  // heatmap: columns are weeks starting on Sunday, like GitHub's own graph
  const first = new Date(days[0].date + 'T00:00:00Z');
  const offset = first.getUTCDay();
  const max = Math.max(1, ...days.map(d => d.count));
  const ramp = ['#10161E', '#123A50', '#1B5F82', '#2D8FC0', '#5CC8FF'];
  const level = c => (c === 0 ? 0 : Math.min(4, 1 + Math.floor((c / max) * 3.999)));
  let cells = '', months = '', lastMonth = -1, lastLabelWeek = -9;
  days.forEach((d, i) => {
    const k = i + offset, wk = Math.floor(k / 7), dow = k % 7;
    const x = x0 + wk * (cell + gap), y = y0 + dow * (cell + gap);
    cells += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5" fill="${ramp[level(d.count)]}"><title>${d.date}: ${d.count}</title></rect>`;
    const m = new Date(d.date + 'T00:00:00Z').getUTCMonth();
    if (dow === 0 && m !== lastMonth && wk - lastLabelWeek >= 3 && wk < 51) {
      months += `<text x="${x}" y="${y0 - 10}" class="mono" font-size="9.5" fill="#4F5A69" letter-spacing="1">${'JFMAMJJASOND'[m]}${['AN', 'EB', 'AR', 'PR', 'AY', 'UN', 'UL', 'UG', 'EP', 'CT', 'OV', 'EC'][m]}</text>`;
      lastMonth = m;
      lastLabelWeek = wk;
    }
  });

  // language share by bytes, top 4 + rest
  const totalBytes = languages.reduce((a, [, b]) => a + b, 0) || 1;
  const top = languages.slice(0, 4);
  const rest = languages.slice(4).reduce((a, [, b]) => a + b, 0);
  if (rest) top.push(['Other', rest]);
  const shades = ['#5CC8FF', '#8A94A3', '#5B6675', '#3E4957', '#2A3544'];
  let bx = x0, bar = '', legend = '', lx = x0;
  const barW = W - 80;
  top.forEach(([name, bytes], i) => {
    const w = Math.max(2, (bytes / totalBytes) * barW);
    bar += `<rect x="${bx.toFixed(1)}" y="342" width="${(w - 2).toFixed(1)}" height="6" rx="3" fill="${shades[i]}"/>`;
    bx += w;
    const pct = ((bytes / totalBytes) * 100).toFixed(1);
    const label = `${name} ${pct}%`;
    legend += `<circle cx="${lx + 4}" cy="370" r="3.5" fill="${shades[i]}"/><text x="${lx + 14}" y="374" class="mono" font-size="11" fill="#8A94A3" letter-spacing=".8">${esc(label)}</text>`;
    lx += 26 + label.length * 7.4;
  });

  const stat = (x, label, value) =>
    `<text x="${x}" y="98" class="mono" font-size="10" fill="#4F5A69" letter-spacing="1.8">${label}</text>` +
    `<text x="${x}" y="136" class="sans" font-size="30" font-weight="700" fill="#EEF1F5">${value}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
  <title id="t">Developer telemetry for ${esc(USER)}</title>
  <desc id="d">${repos.length} public repositories. ${fmt(s.total)} contributions in the last year across ${s.active} active days, longest streak ${s.longest} days. Languages by bytes: ${top.map(([n, b]) => `${n} ${((b / totalBytes) * 100).toFixed(1)}%`).join(', ')}. Synced ${synced}.</desc>
  <defs><clipPath id="frame"><rect width="${W}" height="${H}" rx="16"/></clipPath></defs>
  <style>
    .sans{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter','Helvetica Neue',Arial,sans-serif}
    .mono{font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace}
    .pulse{animation:pulse 2.6s ease-in-out infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
    @media (prefers-reduced-motion:reduce){*{animation:none!important}}
  </style>
  <g clip-path="url(#frame)">
    <rect width="${W}" height="${H}" fill="#07090C"/>
    <text x="40" y="42" class="mono" font-size="11" fill="#5B6675" letter-spacing="1.6">sx://telemetry</text>
    <circle class="pulse" cx="${Math.round(840 - (7 + synced.length) * 8.25 - 12)}" cy="38" r="3.5" fill="#5CC8FF"/>
    <text x="840" y="42" class="mono" font-size="11" fill="#8A94A3" letter-spacing="1.6" text-anchor="end">SYNCED ${esc(synced)}</text>
    <path d="M40 62H840" stroke="#141B24"/>
    ${stat(40, 'PUBLIC REPOS', repos.length)}
    ${stat(240, 'CONTRIBUTIONS · 12 MO', fmt(s.total))}
    ${stat(480, 'ACTIVE DAYS', s.active)}
    ${stat(660, 'LONGEST STREAK', `${s.longest}<tspan font-size="14" fill="#5B6675" font-weight="400"> days</tspan>`)}
    ${months}
    ${cells}
    <text x="40" y="330" class="mono" font-size="10" fill="#4F5A69" letter-spacing="1.8">LANGUAGES · BY BYTES ACROSS PUBLIC REPOS</text>
    ${bar}
    ${legend}
  </g>
  <rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="15.5" fill="none" stroke="#161D27"/>
</svg>
`;
}

const repos = await getRepos();
const languages = await getLanguages(repos);
let days;
try {
  days = TOKEN ? await getContributionsGraphQL() : await getContributionsPage();
} catch (err) {
  console.warn(`primary contribution source failed (${err.message}); trying fallback`);
  days = TOKEN ? await getContributionsPage() : await getContributionsGraphQL();
}
const synced = new Date().toISOString().slice(0, 10);
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, render({ repos, languages, days, synced }));
console.log(`telemetry.svg: ${repos.length} repos, ${days.length} days, ${stats(days).total} contributions, synced ${synced}`);
