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
  const W = 720, H = 430, A = '#5CC8FF';
  const s = stats(days);

  // weekly totals, newest bucket ending on the last day of data
  const weeks = [];
  for (let end = days.length; end > 0 && weeks.length < 52; end -= 7) {
    const chunk = days.slice(Math.max(0, end - 7), end);
    weeks.unshift({ start: chunk[0].date, count: chunk.reduce((a, d) => a + d.count, 0) });
  }
  const cx0 = 32, cx1 = W - 32, cy0 = 200, cy1 = 318;
  const peak = Math.max(1, ...weeks.map(w => w.count));
  const px = i => cx0 + (i / (weeks.length - 1)) * (cx1 - cx0);
  const py = c => cy1 - (c / peak) * (cy1 - cy0);
  const pts = weeks.map((w, i) => `${px(i).toFixed(1)},${py(w.count).toFixed(1)}`);
  const line = `M${pts.join('L')}`;
  const area = `${line}L${cx1},${cy1}L${cx0},${cy1}Z`;
  const pi = weeks.findIndex(w => w.count === peak);
  let months = '', lastM = -1;
  weeks.forEach((w, i) => {
    const m = new Date(w.start + 'T00:00:00Z').getUTCMonth();
    if (m !== lastM && i > 0 && i < weeks.length - 2) {
      months += `<text x="${px(i).toFixed(1)}" y="${cy1 + 20}" class="mono" font-size="10" fill="#4F5A69" letter-spacing="1" text-anchor="middle">${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][m]}</text>`;
    }
    lastM = m;
  });

  // language share by bytes, top 4 + rest
  const totalBytes = languages.reduce((a, [, b]) => a + b, 0) || 1;
  const top = languages.slice(0, 4);
  const rest = languages.slice(4).reduce((a, [, b]) => a + b, 0);
  if (rest) top.push(['Other', rest]);
  const shades = [A, '#8A94A3', '#5B6675', '#3E4957', '#2A3544'];
  let bx = 32, bar = '', legend = '', lx = 32;
  top.forEach(([name, bytes], i) => {
    const w = Math.max(3, (bytes / totalBytes) * (W - 64));
    bar += `<rect x="${bx.toFixed(1)}" y="374" width="${(w - 3).toFixed(1)}" height="8" rx="4" fill="${shades[i]}"${i === 0 ? ' filter="url(#glow)"' : ''}/>`;
    bx += w;
    const label = `${name} ${((bytes / totalBytes) * 100).toFixed(1)}%`;
    legend += `<rect x="${lx}" y="398" width="8" height="8" rx="2" fill="${shades[i]}"/><text x="${lx + 14}" y="406" class="mono" font-size="11.5" fill="#9AA6B4" letter-spacing=".6">${esc(label)}</text>`;
    lx += 30 + label.length * 7.6;
  });

  const tiles = [
    ['PUBLIC REPOS', repos.length, ''],
    ['CONTRIBUTIONS · 12 MO', fmt(s.total), ''],
    ['ACTIVE DAYS', s.active, ''],
    ['LONGEST STREAK', s.longest, ' days'],
  ].map(([label, value, unit], i) => {
    const x = 24 + i * 172;
    return `<rect x="${x}" y="70" width="162" height="84" rx="12" fill="#0A0E14" stroke="#16212C"/>` +
      `<rect x="${x + 14}" y="70" width="28" height="2" fill="${A}"/>` +
      `<text x="${x + 14}" y="96" class="mono" font-size="9.5" fill="#5B6675" letter-spacing="1.6">${label}</text>` +
      `<text x="${x + 14}" y="136" class="sans" font-size="34" font-weight="800" fill="#EEF1F5">${value}<tspan font-size="14" font-weight="400" fill="#5B6675">${unit}</tspan></text>`;
  }).join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
  <title id="t">Developer telemetry for ${esc(USER)}</title>
  <desc id="d">${repos.length} public repositories. ${fmt(s.total)} contributions in the last year across ${s.active} active days, longest streak ${s.longest} days, busiest week ${peak}. Languages by bytes: ${top.map(([n, b]) => `${n} ${((b / totalBytes) * 100).toFixed(1)}%`).join(', ')}. Synced ${synced}.</desc>
  <defs>
    <clipPath id="frame"><rect width="${W}" height="${H}" rx="16"/></clipPath>
    <clipPath id="chart"><rect x="${cx0}" y="${cy0 - 20}" width="${cx1 - cx0}" height="${cy1 - cy0 + 20}"/></clipPath>
    <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${A}" stop-opacity=".35"/><stop offset="1" stop-color="${A}" stop-opacity="0"/></linearGradient>
    <linearGradient id="cursor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${A}" stop-opacity="0"/><stop offset=".5" stop-color="${A}" stop-opacity=".9"/><stop offset="1" stop-color="${A}" stop-opacity="0"/></linearGradient>
    <filter id="glow" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <style>
    .sans{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter','Helvetica Neue',Arial,sans-serif}
    .mono{font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace}
    .pulse{animation:pulse 2.4s ease-in-out infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
    .scan{animation:scan 9s linear infinite}
    @keyframes scan{0%{transform:translateX(0);opacity:0}5%{opacity:1}95%{opacity:1}100%{transform:translateX(${cx1 - cx0}px);opacity:0}}
    @media (prefers-reduced-motion:reduce){*{animation:none!important}.scan{opacity:0}}
  </style>
  <g clip-path="url(#frame)">
    <rect width="${W}" height="${H}" fill="#07090C"/>
    <circle class="pulse" cx="36" cy="38" r="4" fill="${A}"/>
    <text x="48" y="42" class="mono" font-size="11.5" font-weight="700" fill="${A}" letter-spacing="2">LIVE</text>
    <text x="${W - 32}" y="42" class="mono" font-size="11" fill="#5B6675" letter-spacing="1.6" text-anchor="end">SYNCED ${esc(synced)} · GITHUB API</text>
    ${tiles}
    <text x="32" y="186" class="mono" font-size="10" fill="#5B6675" letter-spacing="1.8">WEEKLY ACTIVITY · 52 WEEKS</text>
    <text x="${W - 32}" y="186" class="mono" font-size="10" fill="#5B6675" letter-spacing="1.8" text-anchor="end">PEAK ${peak} / WEEK</text>
    ${[0.25, 0.5, 0.75].map(f => `<path d="M${cx0} ${(cy1 - f * (cy1 - cy0)).toFixed(1)}H${cx1}" stroke="#111922" stroke-dasharray="2 5"/>`).join('')}
    <path d="M${cx0} ${cy1}H${cx1}" stroke="#1A2530"/>
    <g clip-path="url(#chart)">
      <path d="${area}" fill="url(#fill)"/>
      <path d="${line}" fill="none" stroke="${A}" stroke-width="2" stroke-linejoin="round" filter="url(#glow)"/>
      <rect class="scan" x="${cx0}" y="${cy0 - 20}" width="1.5" height="${cy1 - cy0 + 20}" fill="url(#cursor)"/>
    </g>
    <circle cx="${px(pi).toFixed(1)}" cy="${py(peak).toFixed(1)}" r="4.5" fill="#07090C" stroke="${A}" stroke-width="2"/>
    ${months}
    <text x="32" y="362" class="mono" font-size="10" fill="#5B6675" letter-spacing="1.8">LANGUAGES · BY BYTES ACROSS PUBLIC REPOS</text>
    ${bar}
    ${legend}
  </g>
  <rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="15.5" fill="none" stroke="#16202B"/>
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
