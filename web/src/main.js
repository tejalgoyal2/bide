import * as THREE from 'three';
import * as SunCalc from 'suncalc';
import { createWorld, shared, EXAG } from './world.js';
import { createControls } from './controls.js';
import { createSky } from './sky.js';
import { createBuses, delayColor, occupancyColor, occupancyLabel } from './buses.js';
import { createNetwork } from './network.js';
import { createLabels } from './labels.js';
import { createWeather } from './weather.js';
import { createOutages } from './outages.js';
import { createAmbient } from './ambient.js';
import { createRoadworks } from './roadworks.js';
import { createBuildings } from './buildings.js';
import { createWind } from './wind.js';
import { createQuakes } from './quakes.js';
import { createFocus } from './focus.js';
import { createStreets } from './streets.js';
import { createNews } from './news.js';
import { createEggs } from './eggs.js';

const $ = (id) => document.getElementById(id);
document.body.classList.add('loading');

const [map, transit] = await Promise.all([
  fetch('/data/map.json').then((r) => r.json()),
  fetch('/data/transit.json').then((r) => r.json()),
]);

const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); // tuned live by adapt()
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 20, 300000);

const world = await createWorld(scene, map);
const sky = createSky(scene);
const controls = createControls(camera, canvas, (x, y) => world.heightAt(x, y) * EXAG * shared.uRise.value);
const buses = createBuses(scene, transit, world, $('tags'));
const network = createNetwork(scene, transit);
const labels = createLabels($('labels'), world.heightAt);
const weather = createWeather(scene, showConditions);
const ambient = createAmbient(scene, world);
const buildings = createBuildings(scene, world);
const wind = createWind(scene, world.surfaceY);
const focus = createFocus(scene, world, $('pins'));
const streets = createStreets($('streets'), world.surfaceY);
const news = createNews($('news-pins'), $('news-ticker'), world.surfaceY);
const eggs = createEggs(scene, $('eggs'), world.surfaceY);
const quakes = createQuakes(scene, world.surfaceY, (list) => {
  const day = list.filter((q) => Date.now() - q.time < 86400e3).length;
  $('n-quake').textContent = list.length ? ` · ${day ? `${day} today` : `${list.length} this week`}` : ' · quiet week';
  $('n-quake').title = `${list.length} in the past week within 250 km`;
});
const roadworks = createRoadworks(scene, world.surfaceY, (ev) => ($('n-road').textContent = ev.length ? ` · ${ev.length}` : ''));
const outages = createOutages(scene, world.surfaceY, (list) => {
  const homes = list.reduce((s, o) => s + o.out, 0);
  $('n-out').textContent = list.length ? ` · ${homes.toLocaleString()} out` : ' · none now';
  $('n-out').title = list.map((o) => `${o.place}, ${o.area}: ${o.out} customers (${o.cause})`).join('\n');
});

// --- time -----------------------------------------------------------------
// The dial drives the light and the activity columns. Buses are always live.
const TZ = 'America/Vancouver';
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function victoriaClock(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { hour: +parts.hour + +parts.minute / 60, weekday: parts.weekday };
}
const dayTypeOf = (wd) => (wd === 'Sat' ? 'saturday' : wd === 'Sun' ? 'sunday' : 'weekday');
const fmtHour = (h) => {
  const H = Math.floor(h) % 24, M = Math.floor((h % 1) * 60);
  return `${((H + 11) % 12) + 1}:${String(M).padStart(2, '0')} ${H < 12 ? 'am' : 'pm'}`;
};

const time = { live: true, hour: victoriaClock().hour, day: dayTypeOf(victoriaClock().weekday), playing: false };
function dateForHour(h) {
  const now = victoriaClock();
  return new Date(Date.now() + (h - now.hour) * 3600e3);
}

$('dial-ticks').innerHTML = ['12a', '6a', '12p', '6p', '12a'].map((t) => `<span>${t}</span>`).join('');
function setHour(h, { live = false } = {}) {
  time.hour = ((h % 24) + 24) % 24;
  time.live = live;
  $('live').classList.toggle('on', live);
  document.body.classList.toggle('scrubbing', !live);
  $('dial-head').style.left = `${(time.hour / 24) * 100}%`;
  $('dial-time').textContent = fmtHour(time.hour);
  $('day-type').textContent = `${{ weekday: 'Weekday', saturday: 'Saturday', sunday: 'Sunday' }[time.day]} timetable · buses stay live`;
  network.setTime(time.day, time.hour);
}
setHour(time.hour, { live: true });

const dial = $('dial');
const dialTo = (e) => {
  const r = dial.getBoundingClientRect();
  setHour(Math.max(0, Math.min(23.99, ((e.clientX - r.left) / r.width) * 24)));
};
dial.addEventListener('pointerdown', (e) => {
  dial.setPointerCapture(e.pointerId);
  time.playing = false;
  $('play').classList.remove('on');
  dialTo(e);
});
dial.addEventListener('pointermove', (e) => e.buttons && dialTo(e));
$('live').onclick = () => {
  const c = victoriaClock();
  time.day = dayTypeOf(c.weekday);
  time.playing = false;
  $('play').classList.remove('on');
  setHour(c.hour, { live: true });
};
$('play').onclick = () => {
  time.playing = !time.playing;
  $('play').classList.toggle('on', time.playing);
  $('play').textContent = time.playing ? '❚❚' : '▶';
  if (time.playing) time.live = false;
  $('live').classList.toggle('on', false);
};

// --- layers and legend ---------------------------------------------------
const LEGENDS = {
  route: () => 'Each route in its own colour',
  crowding: () =>
    [0, 1, 2, 3].map((o) => `<span><i style="background:${occupancyColor(o)}"></i>${occupancyLabel(o)}</span>`).join(''),
  lateness: () =>
    [
      [-120, 'Early'], [0, 'On time'], [200, '2–5 min late'], [400, '5–10 late'], [700, '10+ late'],
    ].map(([d, t]) => `<span><i style="background:${delayColor(d)}"></i>${t}</span>`).join(''),
};
function setMode(m) {
  buses.setMode(m);
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('legend').innerHTML = LEGENDS[m]();
}
$('mode').onclick = (e) => e.target.dataset.mode && setMode(e.target.dataset.mode);
setMode('lateness');
$('t-network').onchange = (e) => network.setVisible(e.target.checked);
$('t-weather').onchange = (e) => weather.setEnabled(e.target.checked);
$('t-life').onchange = (e) => ambient.setEnabled(e.target.checked);
$('t-bldg').onchange = (e) => buildings.setEnabled(e.target.checked);
$('t-wind').onchange = (e) => wind.setEnabled(e.target.checked);
$('t-quake').onchange = (e) => quakes.setEnabled(e.target.checked);
$('t-streets').onchange = (e) => streets.setEnabled(e.target.checked);
$('t-news').onchange = (e) => news.setEnabled(e.target.checked);

// Turning the map: buttons, a compass that points north (tap it to face
// north again), Q and E on a keyboard; right-drag or a two-finger twist too.
const turn = (by) => controls.flyTo({ azimuth: controls.state.azimuth + by }, 700);
$('rot-l').onclick = () => turn(-Math.PI / 4);
$('rot-r').onclick = () => turn(Math.PI / 4);
$('compass').onclick = () => {
  const a = controls.state.azimuth;
  controls.flyTo({ azimuth: a - Math.atan2(Math.sin(a), Math.cos(a)) }, 900);
};
addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey) return;
  if (e.key === 'q' || e.key === 'Q') turn(-Math.PI / 8);
  if (e.key === 'e' || e.key === 'E') turn(Math.PI / 8);
  if (e.key === 'n' || e.key === 'N') $('compass').click();
});
// Psst: the logo's dot calls the orcas.
document.querySelector('#brand .wordmark').addEventListener('click', () => {
  eggs.orcas();
  controls.flyTo({ x: -1300, z: 5900, dist: 2600, polar: 1.0, azimuth: 0.15 }, 2600);
});
$('t-road').onchange = (e) => roadworks.setEnabled(e.target.checked);
$('t-out').onchange = (e) => outages.setEnabled(e.target.checked);
$('layers-toggle').onclick = () => {
  const open = $('layers').classList.toggle('open');
  $('layers-toggle').setAttribute('aria-expanded', open);
  if (open) $('layer-list').open = true;
};
$('t-labels').onchange = (e) => ($('labels').style.display = e.target.checked ? '' : 'none');
// Home: looking north over the Inner Harbour, downtown and on up the peninsula.
const HOME = { x: -900, z: 2500, dist: 7000, polar: 0.95, azimuth: 0.32 };
$('home').onclick = () => {
  controls.state.follow = null;
  controls.flyTo(HOME, 2200);
};

// --- conditions -------------------------------------------------------------
const hm = (t) => new Date(t).toLocaleTimeString('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const MOON = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full moon', 'waning gibbous', 'last quarter', 'waning crescent'];
function showConditions(s) {
  if (s.weather) {
    const w = s.weather;
    $('weather').textContent = `${w.temp}°${Math.abs(w.feels - w.temp) >= 2 ? ` (feels ${w.feels}°)` : ''} · ${w.text}`;
    $('c-wind').textContent = `${w.wind} km/h from the ${w.from}${w.gust >= w.wind + 10 ? `, gusts ${w.gust}` : ''}`;
  }
  if (s.aqhi) {
    const v = Math.max(1, Math.round(s.aqhi.v));
    const word = v <= 3 ? 'Low risk' : v <= 6 ? 'Moderate risk' : v <= 10 ? 'High risk' : 'Very high risk';
    $('c-air').textContent = `${word} · AQHI ${v}`;
    $('c-air').className = v <= 3 ? 'ok' : v <= 6 ? 'meh' : 'bad';
  } else if (s.air) {
    $('c-air').textContent = `US AQI ${s.air.aqi}`;
  }
  if (s.tide) {
    const t = s.tide;
    $('c-tide').textContent = `${t.v.toFixed(1)} m, ${t.rising ? 'rising' : 'falling'}${t.turn ? ` · ${t.turn.high ? 'high' : 'low'} at ${hm(t.turn.t)}` : ''}`;
  }
  if (s.sea) {
    const e = s.sea;
    $('c-sea').textContent = `${e.h.toFixed(1)} m waves from the ${e.from} · ${Math.round(e.temp)}°C water`;
  }
  const now = new Date(), sc = SunCalc.getTimes(now, 48.43, -123.37);
  const next = now < sc.sunrise ? `rises ${hm(sc.sunrise)}` : now < sc.sunset ? `sets ${hm(sc.sunset)}` : `rises ${hm(SunCalc.getTimes(new Date(+now + 86400e3), 48.43, -123.37).sunrise)}`;
  $('c-sun').textContent = next;
  const ph = SunCalc.getMoonIllumination(now);
  $('c-moon').textContent = `${MOON[Math.round(ph.phase * 8) % 8]}, ${Math.round(ph.fraction * 100)}% lit`;
  // An Environment Canada warning in force for Greater Victoria.
  const wn = s.warnings?.[0];
  $('warn').hidden = !wn;
  if (wn) {
    $('warn').className = `warn ${wn.colour || 'yellow'}`;
    const body = (wn.text || '').split('\n\n').slice(0, 2).join(' ').replace(/\s+/g, ' ');
    $('warn').innerHTML = `<b>${esc(wn.name[0].toUpperCase() + wn.name.slice(1))}</b> <span>until ${hm(wn.until)} ${new Date(wn.until).toDateString() !== now.toDateString() ? 'tomorrow' : ''}</span><p>${esc(body)} <i>Environment Canada</i></p>`;
  }
}
setInterval(() => showConditions(weather.state), 60e3); // sun, moon and countdowns move on
$('warn').onclick = () => $('warn').setAttribute('aria-expanded', $('warn').getAttribute('aria-expanded') !== 'true');

// --- the recorder, for the scoreboard teaser ------------------------------
async function loadStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    const first = s.vehicles.first ? new Date(s.vehicles.first * 1000) : null;
    const since = first ? first.toLocaleDateString('en-CA', { timeZone: TZ, month: 'short', day: 'numeric' }) : 'today';
    const hours = first ? (Date.now() / 1000 - s.vehicles.first) / 3600 : 0;
    const days = hours / 24;

    $('score-progress').innerHTML =
      `Recording since <b>${since}</b>: <b>${s.vehicles.n.toLocaleString()}</b> snapshots of every bus position and ` +
      `<b>${s.tripUpdates.n.toLocaleString()}</b> snapshots of BC Transit's predictions so far ` +
      `(${hours < 48 ? Math.round(hours) + ' hours' : Math.round(days) + ' days'} of data).`;
  } catch { /* the teaser just stays quiet */ }
}
loadStatus();
setInterval(loadStatus, 60000);
$('score-open').onclick = () => $('score').classList.remove('hidden');
$('score').querySelector('.close').onclick = () => $('score').classList.add('hidden');
// The guide: what everything on the map is. Offered once to first-time visitors.
const openGuide = (on = true) => $('guide').classList.toggle('hidden', !on);
$('guide-open').onclick = () => openGuide();
$('guide').querySelector('.close').onclick = () => openGuide(false);
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  if (e.key === '?') openGuide($('guide').classList.contains('hidden'));
  if (e.key === 'Escape') { openGuide(false); $('score').classList.add('hidden'); $('alerts').classList.add('hidden'); }
});
try {
  if (!localStorage.getItem('bide-guided')) {
    setTimeout(() => $('guide-hint').classList.add('on'), 6000);
    setTimeout(() => $('guide-hint').classList.remove('on'), 16000);
    localStorage.setItem('bide-guided', '1');
  }
} catch { /* private mode: no hint */ }
$('guide-hint').onclick = () => { $('guide-hint').classList.remove('on'); openGuide(); };

// --- the scoreboard ---------------------------------------------------------
const mmss = (s) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`);
const dayName = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });

// Mean error by lead time, one line per predictor.
// The scoreboard. One question per row: for predictions made this far
// ahead, how far off was BC Transit, and how far off was bide? Lower is
// better; each row says who was closer and by how much.
const short = (s) => (s >= 3600 ? `${Math.round(s / 3600)} h` : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
function chart(buckets, k) {
  const W = 560, rowH = 34, L = 112, R = 148, T = 22;
  const H = T + rowH * buckets.length + 18;
  const vals = buckets.flatMap((b) => [b.official.mae, b[k].mae]);
  // Never let one wild value flatten the rest: the axis stops at twice BC Transit's worst.
  const cap = Math.max(...buckets.map((b) => b.official.mae)) * 2;
  const max = Math.min(cap, Math.max(...vals)) * 1.06;
  const x = (v) => L + (W - L - R) * Math.min(1, v / max);
  const ticks = [0, 60, 120, 180, 240, 300, 360, 480, 600].filter((v) => v <= max).filter((v, i, a) => a.length < 6 || i % 2 === 0);
  const grid = ticks.map((v) => `<line x1="${x(v)}" x2="${x(v)}" y1="${T - 6}" y2="${H - 18}" class="g"/><text x="${x(v)}" y="${H - 4}" text-anchor="middle">${v / 60} min</text>`).join('');
  const rows = buckets.map((b, i) => {
    const y = T + rowH * i + rowH / 2, o = b.official.mae, m = b[k].mae, gap = o - m;
    const win = Math.abs(gap) < Math.max(3, o * 0.02) ? 'tie' : gap > 0 ? 'bide' : 'bct';
    const verdict = win === 'tie' ? 'level' : `${win === 'bide' ? 'bide' : 'BC Transit'} closer by ${short(Math.abs(gap))}`;
    const off = m > max ? ' ›' : '';
    return `<g class="row ${win}">
      <text x="0" y="${y + 4}" class="lbl">${b.lo}–${b.hi} min ahead</text>
      <line x1="${x(Math.min(o, m))}" x2="${x(Math.max(o, m))}" y1="${y}" y2="${y}" class="bar"/>
      <circle cx="${x(o)}" cy="${y}" r="5.5" class="bct"/><circle cx="${x(m)}" cy="${y}" r="5.5" class="us"/>
      <text x="${W - R + 10}" y="${y + 4}" class="verdict">${verdict}${off}</text>
    </g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Average miss by lead time">
      <text x="${L}" y="10" class="cap">Average miss · lower is better</text>${grid}${rows}</svg>
    <div class="key"><span><i class="bct"></i>BC Transit's own prediction</span><span><i class="us"></i>${k === 'bide' ? 'bide' : 'bide+'}</span></div>`;
}

async function loadScores() {
  try {
    const days = await (await fetch('/api/scores')).json();
    if (!days.length) return;
    const d = days[0];
    const o = d.overall;
    const partial = d.partialFrom
      ? ` (from ${new Date(d.partialFrom * 1000).toLocaleTimeString('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })})`
      : '';
    // Show whichever of bide's two models did better that day; call it
    // ahead only when it is clearly ahead, by at least 1%.
    const label = { bide: 'bide', bidePlus: 'bide+' };
    const k = ['bide', 'bidePlus'].sort((a, b) => o[a].mae - o[b].mae)[0];
    const ahead = o[k].mae < o.official.mae * 0.99, behind = o[k].mae > o.official.mae * 1.01;
    const stat = (name, v, cls) => `<div class="stat-big ${cls}"><span>${name}</span><b>${mmss(v.mae)}</b><small>average miss · within a minute ${Math.round(v.within60)}% of the time</small></div>`;
    const history = days.slice(0, 7).map((x) => {
      const kk = ['bide', 'bidePlus'].sort((a, b) => x.overall[a].mae - x.overall[b].mae)[0];
      const w = x.overall[kk].mae < x.overall.official.mae * 0.99;
      return `<li><span>${dayName(x.date)}</span><span>BC Transit ${short(x.overall.official.mae)}</span><span class="${w ? 'won' : ''}">${label[kk]} ${short(x.overall[kk].mae)}</span></li>`;
    }).join('');
    $('score-body').innerHTML = `
      <p class="headline">${dayName(d.date)}${partial}: ${ahead
        ? `${label[k]} beat BC Transit's own arrival times, missing by <em>${mmss(o[k].mae)}</em> on average against ${mmss(o.official.mae)}.`
        : behind
          ? `BC Transit's own arrival times were closer, missing by <em>${mmss(o.official.mae)}</em> on average; ${label[k]} missed by ${mmss(o[k].mae)}.`
          : `${label[k]} and BC Transit finished level, both missing by about <em>${mmss(o.official.mae)}</em> on average.`}</p>
      <div class="stat-pair">${stat('BC Transit', o.official, 'bct')}${stat(label[k], o[k], 'us')}</div>
      ${d.feedClockOffset > 0.5
        ? `<p class="note">BC Transit's feed ran on the wrong clock that day, an hour out with no delays reported. bide spotted it from where the buses actually were and corrected for it.</p>`
        : d.feedClockOffset > 0.01 && o.officialFixed
          ? `<p class="note">For ${Math.max(1, Math.round(d.feedClockOffset * 100))}% of the day's updates BC Transit's feed was an hour out, which inflates its average. With its clock put right it would have missed by ${mmss(o.officialFixed.mae)}; ${label[k]} was ${o[k].mae < o.officialFixed.mae * 0.99 ? 'still closer' : o[k].mae > o.officialFixed.mae * 1.01 ? 'then behind' : 'then level'}.</p>`
          : ''}
      ${chart(d.buckets, k)}
      <h3 class="score-h">Every day so far</h3>
      <ul class="days">${history}</ul>
      <p class="muted small">${d.events.toLocaleString()} predictions checked against ${d.arrivals.toLocaleString()} real arrivals on ${d.trips.toLocaleString()} trips. A new day is scored every morning.</p>`;
    $('score-method').textContent = d.method;
    $('s-recorded').textContent = ahead
      ? `${dayName(d.date)}: ${label[k]} ${short(o[k].mae)} vs BC Transit ${short(o.official.mae)}`
      : `${dayName(d.date)}: BC Transit ${short(o.official.mae)}, ${label[k]} ${short(o[k].mae)}`;
  } catch (e) {
    console.warn('scores', e);
  }
}
loadScores();
setInterval(loadScores, 30 * 60e3);

// --- Victoria right now, and service alerts ---------------------------------
async function loadNow() {
  try {
    const w = weather.state.weather;
    const q = w ? `?weather=${encodeURIComponent(`${w.temp}°C, ${w.text}, wind ${w.wind} km/h`)}` : '';
    const n = await (await fetch('/api/now' + q)).json();
    $('now').textContent = n?.text || '';
  } catch { /* the line is optional */ }
}
setTimeout(loadNow, 2500);
setInterval(loadNow, 5 * 60e3);

async function loadAlerts() {
  try {
    const alerts = (await (await fetch('/api/alerts')).json()).filter((a) => a.header || a.description);
    const chip = $('alerts-open');
    chip.hidden = !alerts.length;
    chip.textContent = `${alerts.length} service alert${alerts.length === 1 ? '' : 's'}`;
    $('alerts-list').innerHTML = alerts.map((a) => `
      <div class="alert">
        <b>${esc(a.header || a.effect || 'Alert')}</b>
        ${a.routes.length ? `<span class="routes">Routes ${a.routes.map((r) => esc(r.replace('-VIC', ''))).join(', ')}</span>` : ''}
        <p>${esc(a.description.trim().slice(0, 600))}</p>
      </div>`).join('');
  } catch { /* stay quiet */ }
}
loadAlerts();
setInterval(loadAlerts, 5 * 60e3);
$('alerts-open').onclick = () => $('alerts').classList.remove('hidden');
$('alerts').querySelector('.close').onclick = () => $('alerts').classList.add('hidden');

// --- picking --------------------------------------------------------------
let selected = null;
const proj = new THREE.Vector3();
function busAtScreen(x, y, radius = 26) {
  let best = null, bd = radius;
  for (const b of buses.list) {
    proj.copy(b.screen).project(camera);
    if (proj.z > 1) continue;
    const sx = ((proj.x + 1) / 2) * innerWidth, sy = ((1 - proj.y) / 2) * innerHeight;
    const d = Math.hypot(sx - x, sy - y);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}
// Next stops: BC Transit's prediction beside bide's, live from /api/trip.
const stopName = new Map(transit.stops.map((st) => [st[0], st[1]]));
const stopAt = new Map(transit.stops.map((st) => [st[0], st]));
let tripData = null, tripTimer = 0;
async function loadTrip() {
  clearTimeout(tripTimer);
  const b = selected;
  if (!b?.tripId) return;
  tripTimer = setTimeout(loadTrip, 20_000);
  try {
    const sent = Date.now() / 1000;
    const d = await (await fetch('/api/trip?id=' + encodeURIComponent(b.tripId))).json();
    if (selected !== b) return;
    tripData = d && { ...d, trip: b.tripId, skew: d.now - sent };
  } catch { /* keep the last answer */ }
  renderTrip();
}
const fmtMin = (t, now) => {
  const m = Math.round((t - now) / 60);
  return m <= 0 ? 'now' : `${m} min`;
};
const DATE_FMT = { month: 'short', day: 'numeric', timeZone: 'UTC' };
function renderTrip() {
  const d = tripData;
  $('b-next').hidden = !d?.stops?.length;
  if (!d?.stops?.length) { focus.setStops([]); return; }
  const now = Date.now() / 1000 + d.skew;
  const key = d.model.best === 'bide' ? 'bide' : 'plus';
  $('b-model').textContent = key === 'bide' ? 'bide' : 'bide+';
  const shown = d.stops.filter((st) => Math.max(st.official, st[key]) > now - 60).slice(0, 4);
  focus.setStops(shown.filter((st) => stopAt.has(st.id)).map((st) => ({ x: stopAt.get(st.id)[2], y: stopAt.get(st.id)[3], label: fmtMin(st[key], now) })));
  $('b-stops').innerHTML = shown
    .map((st) => {
      const diff = Math.round((st[key] - st.official) / 60);
      const tag = diff && Math.abs(diff) < 30 ? `<i class="${diff > 0 ? 'later' : 'sooner'}">${diff > 0 ? '+' : '−'}${Math.abs(diff)}</i>` : '';
      const name = (stopName.get(st.id) || `Stop ${st.seq}`).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      return `<li><span title="${name}">${name}</span><span>${fmtMin(st.official, now)}</span><b>${fmtMin(st[key], now)}${tag}</b></li>`;
    })
    .join('');
  const m = d.model, name = key === 'bide' ? 'bide' : 'bide+';
  const day = m.from ? new Date(m.from + 'T00:00:00Z').toLocaleDateString('en-CA', DATE_FMT) : '';
  $('b-note').textContent =
    (d.off ? `BC Transit's feed clock is ${Math.abs(d.off / 3600)} h out right now; ${name} corrects it. ` : '') +
    (m.from ? `${name} uses settings learned on ${day}${m.mae ? `, when it was off by ${(m.mae[m.best] / 60).toFixed(1)} min on average (BC Transit: ${(m.mae.official / 60).toFixed(1)})` : ''}.` : '');
}

function select(b) {
  if (b !== selected) { tripData = null; $('b-next').hidden = true; }
  selected = b;
  $('bus').classList.toggle('hidden', !b);
  document.body.classList.toggle('has-bus', !!b);
  const r = b && buses.routes[b.route];
  focus.set(b, r?.color ?? '#e07a5f');
  buses.setSelected(b);
  if (!b) { controls.state.follow = null; return; }
  $('b-route').textContent = r?.short ?? '?';
  $('b-route').style.background = r?.color ?? '#777';
  $('b-route').style.color = r?.text ?? '#fff';
  $('b-headsign').textContent = b.headsign || r?.name || 'Bus';
  $('b-name').textContent = r ? r.name : '';
  $('b-follow').textContent = 'Follow this bus';
  refreshCard();
  loadTrip();
}
function refreshCard() {
  if (!selected) return;
  const b = selected;
  $('b-occ').textContent = occupancyLabel(b.occ);
  $('b-occ').style.color = occupancyColor(b.occ);
  // The delay seen at the last stop the bus reached, else BC Transit's figure.
  const seen = tripData?.passed && selected.tripId === tripData.trip ? tripData.passed.delay : null;
  const d = seen ?? buses.delayOf(b);
  $('b-delay').textContent =
    d == null ? 'no prediction yet' : Math.abs(d) < 60 ? 'on time' : `${Math.round(Math.abs(d) / 60)} min ${d > 0 ? 'late' : 'early'}`;
  $('b-delay').style.color = delayColor(d);
  $('b-age').textContent = b.vts ? `${Math.max(0, Math.round(Date.now() / 1000 - b.vts))} s ago` : '–';
  renderTrip();
}
setInterval(refreshCard, 1000);
controls.state.onTap = (x, y) => { if (!eggs.tap(x, y)) select(busAtScreen(x, y)); };
$('bus').querySelector('.close').onclick = () => select(null);
$('b-follow').onclick = () => {
  if (!selected) return;
  const on = controls.state.follow !== selected;
  controls.state.follow = on ? selected : null;
  $('b-follow').textContent = on ? 'Stop following' : 'Follow this bus';
  if (on) controls.flyTo({ dist: Math.min(controls.state.dist, 2200), polar: 1.0 }, 1600);
};

// Hovering a column says what it means.
const ago = (t) => {
  const m = (Date.now() - t) / 60e3;
  return m < 60 ? `${Math.round(m)} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
function quakeAtScreen(x, y) {
  const v = new THREE.Vector3();
  let best = null, bd = 22;
  for (const q of quakes.list) {
    v.set(q.x, q.on ? world.surfaceY(q.x, q.y) : 0, -q.y).project(camera);
    if (v.z > 1) continue;
    const d = Math.hypot(((v.x + 1) / 2) * innerWidth - x, ((1 - v.y) / 2) * innerHeight - y);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}
canvas.addEventListener('pointermove', (e) => {
  const tip = $('tooltip');
  if (e.buttons) { tip.style.opacity = 0; return; }
  const b = busAtScreen(e.clientX, e.clientY);
  let g, w;
  const egg = !b && eggs.hover(e.clientX, e.clientY);
  canvas.style.cursor = b || egg ? 'pointer' : '';
  if (egg) { tip.style.opacity = 0; return; }
  const q = !b && quakeAtScreen(e.clientX, e.clientY);
  if (b) {
    const r = buses.routes[b.route];
    tip.innerHTML = `<b>${r?.short ?? ''}</b> ${b.headsign || r?.name || ''}`;
  } else if (q) {
    tip.innerHTML = `<b class="tip-kind">M${q.mag.toFixed(1)} earthquake · ${ago(q.time)}</b><br>` +
      `<span class="tip-text">${q.km} km ${q.bearing} of Victoria, ${q.depth} km deep${q.place ? ` · ${esc(q.place)}` : ''}</span>`;
  } else if (roadworks.visible && (g = controls.groundAt(e.clientX, e.clientY)) && (w = roadworks.near(g.x, -g.z, Math.max(60, controls.state.dist / 60)))) {
    tip.innerHTML = `<b class="tip-kind">${esc(w.kind)}</b><br><span class="tip-text">${esc(w.text)}</span>`;
  } else if (network.visible) {
    g = controls.groundAt(e.clientX, e.clientY);
    const v = g && network.near(g.x, -g.z, Math.max(25, controls.state.dist / 400));
    if (!v || v < 0.5) { tip.style.opacity = 0; return; }
    tip.innerHTML = `<b>${Math.round(v)}</b> buses an hour scheduled here around ${fmtHour(time.hour)}`;
  } else { tip.style.opacity = 0; return; }
  tip.style.left = e.clientX + 'px';
  tip.style.top = e.clientY + 'px';
  tip.style.opacity = 1;
});
canvas.addEventListener('pointerleave', () => ($('tooltip').style.opacity = 0));

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// --- intro: the city rises out of the sea ---------------------------------
Object.assign(controls.state, { dist: 30000, polar: 0.12, azimuth: 0.9 });
controls.state.target.set(HOME.x, 0, HOME.z);
setTimeout(() => {
  $('veil').classList.add('gone');
  controls.flyTo(HOME, 5200);
}, 250);
const introStart = performance.now() + 250;
setTimeout(() => document.body.classList.remove('loading'), 2800);

// --- loop -----------------------------------------------------------------
const clock = new THREE.Clock();
const SMOKE = new THREE.Color('#c99a62');
let statT = 0, nightClass = null;
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;
  const k = Math.min(1, Math.max(0, (performance.now() - introStart) / 3600));
  shared.uRise.value = 1 - (1 - k) ** 3;

  if (time.playing) {
    time.hour += dt * 1.1;
    if (time.hour >= 24) time.hour -= 24;
    setHour(time.hour);
  } else if (time.live && Math.floor(t) % 20 === 0) {
    setHour(victoriaClock().hour, { live: true });
  }
  const sun = sky.set(time.live ? new Date() : dateForHour(time.hour));
  // Wildfire smoke: high fine-particle levels tint the haze amber.
  const pm = weather.state.air?.pm || 0;
  if (pm > 25) shared.uHaze.value.lerp(SMOKE, Math.min(0.45, (pm - 25) / 200));
  const isNight = sun.night > 0.5;
  if (isNight !== nightClass) {
    document.body.classList.toggle('night', isNight);
    nightClass = isNight;
  }

  const s = controls.state;
  const followPos = s.follow ? new THREE.Vector3(s.follow.x, 0, -s.follow.y) : null;
  controls.update(dt, followPos);
  const mpp = (2 * s.dist * Math.tan((camera.fov * Math.PI) / 360)) / innerHeight;
  shared.uTime.value = t;
  shared.uMpp.value = mpp;
  shared.uCamPos.value.copy(camera.position);
  shared.uFogDist.value = s.dist * 2.4 + 9000;
  sky.dome.position.copy(camera.position);

  buses.update(dt, mpp, camera, s.dist);
  network.update(dt);
  outages.update(dt, mpp, t);
  ambient.update(dt, mpp, t);
  buildings.update(dt, s.dist);
  wind.update(dt, s.target, s.dist, mpp);
  quakes.update(dt, mpp);
  focus.update(dt, camera, mpp);
  streets.update(camera, s.target, s.dist);
  news.update(camera, s.dist);
  eggs.update(dt, camera, s.dist, mpp);
  $('needle').style.transform = `rotate(${s.azimuth}rad)`;
  roadworks.update(dt, mpp);
  weather.update(s.target, s.dist);
  labels.update(camera, s.dist, shared.uRise.value);

  if (t - statT > 1) {
    statT = t;
    const st = buses.stats();
    $('s-buses').textContent = st.n || '–';
    $('s-standing').textContent = st.n ? st.standing : '–';
    $('s-late').textContent = st.withDelay ? st.late : '–';
    $('clock').textContent = new Date().toLocaleTimeString('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  }
  renderer.render(scene, camera);
  adapt(dt);
}

// Adaptive sharpness: if frames run slow for a couple of seconds (an older
// phone, a hot laptop), draw fewer pixels; if there's room again, more.
const maxDpr = Math.min(devicePixelRatio, 2);
let slow = 0, quick = 0, dpr = maxDpr;
function adapt(dt) {
  if (document.hidden) return;
  if (dt > 1 / 40) { slow += dt; quick = 0; } else { quick += dt; slow = Math.max(0, slow - dt * 0.5); }
  if (slow > 2 && dpr > 1) { dpr = Math.max(1, dpr - 0.25); renderer.setPixelRatio(dpr); slow = 0; }
  else if (quick > 8 && dpr < maxDpr) { dpr = Math.min(maxDpr, dpr + 0.25); renderer.setPixelRatio(dpr); quick = 0; }
}
renderer.setAnimationLoop(frame);

// ?at=8.5 opens the map at 8:30 am instead of now; handy for sharing a moment.
const at = new URLSearchParams(location.search).get('at');
if (at != null && !Number.isNaN(+at)) setHour(+at);
window.bide = { controls, setHour, time, buses, camera, scene, renderer, frame, select, eggs };
