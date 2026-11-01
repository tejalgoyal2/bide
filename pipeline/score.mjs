// The honest scoreboard, one service day at a time.
//
// 1. Pull the day's recorded snapshots from the recorder.
// 2. Work out when each bus actually reached each stop, from its reported
//    stop sequence and status (midpoint of the two reports either side of
//    reaching the stop; anything less certain than +/-45 s is dropped).
// 3. Every BC Transit prediction made before a bus arrived becomes an event:
//    (trip, stop, moment made, lead time). Three predictors answer every
//    event, so all are scored on exactly the same set:
//      official  BC Transit's own predicted time
//      schedule  the timetable (implied by the feed: predicted time - delay)
//      bide      bide's model, using only what was known at that moment
// 4. Score by lead time, hour and route, fit the model's parameters on this
//    day for use on the next, and post the result to the site.
//
// Usage: node pipeline/score.mjs --date 2026-11-01 [--dry]
// Env:   BIDE_KEY (required), BIDE_URL (default: the deployed site)
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeVehicles } from '../shared/gtfsrt.js';

const URL_BASE = process.env.BIDE_URL || 'https://bide.itejalgoyal.workers.dev';
const KEY = process.env.BIDE_KEY;
const TZ = 'America/Vancouver';
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true] : null)).filter(Boolean),
);
const DRY = !!args.dry;
const BUCKETS = [[0, 2], [2, 5], [5, 10], [10, 15], [15, 20], [20, 30]];
const DEFAULT_PARAMS = { rho: 0.95, gamma: 0.5, beta: 0, c: 0 };

if (!KEY) throw new Error('BIDE_KEY is not set');

// --- time ---------------------------------------------------------------------
function tzOffset(t) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t)).map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
}
function localTime(date, hour) {
  const [y, m, d] = date.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d, hour);
  t -= tzOffset(t);
  t = Date.UTC(y, m - 1, d, hour) - tzOffset(t);
  return t / 1000;
}
const localHour = (t) => new Date(t * 1000).toLocaleString('en-CA', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }) % 24;

const yesterday = () => new Date(Date.now() - 86400e3).toLocaleDateString('en-CA', { timeZone: TZ });
const DATE = args.date && args.date !== true ? args.date : yesterday();
// A service day runs 3 am to 3 am, so late-night trips stay with their day.
const FROM = Math.floor(localTime(DATE, 3));
const TO = Math.floor(FROM + 86400 + (localTime(DATE, 3) === localTime(DATE, 3) ? 0 : 0));

// --- fetching -----------------------------------------------------------------
async function exportRows(table) {
  const rows = [];
  let from = FROM;
  for (;;) {
    const res = await fetch(`${URL_BASE}/api/export?table=${table}&from=${from}&to=${TO}`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) throw new Error(`export ${table}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    let p = 0, n = 0, last = from;
    while (p < buf.length) {
      const ts = buf.readUInt32BE(p), len = buf.readUInt32BE(p + 4);
      rows.push({ ts, body: zlib.gunzipSync(buf.subarray(p + 8, p + 8 + len)) });
      p += 8 + len; n++; last = ts;
    }
    if (n < 2000) break;
    from = last + 1;
  }
  return rows;
}

async function previousParams() {
  try {
    const days = await (await fetch(`${URL_BASE}/api/scores`)).json();
    const prev = days.find((d) => d.date < DATE && d.params?.fitted);
    return prev ? { ...prev.params.fitted, from: prev.date } : { ...DEFAULT_PARAMS, from: 'defaults' };
  } catch {
    return { ...DEFAULT_PARAMS, from: 'defaults' };
  }
}

// --- 1. snapshots -------------------------------------------------------------
console.log(`service day ${DATE}: ${new Date(FROM * 1000).toISOString()} to ${new Date(TO * 1000).toISOString()}`);
const [vpRows, tuRows, prevParams] = await Promise.all([exportRows('vp'), exportRows('tu'), previousParams()]);
const params = args.params ? { ...JSON.parse(args.params), from: 'command line' } : prevParams;
console.log(`snapshots: ${vpRows.length} vehicle, ${tuRows.length} prediction; model params from ${params.from}`);
if (!vpRows.length || !tuRows.length) {
  console.log('nothing recorded for this day');
  process.exit(0);
}

// --- 2. observed arrivals -----------------------------------------------------
// Each vehicle report, deduplicated, with the first snapshot that carried it:
// that is when the information became known.
const obs = new Map(); // tripId -> [{t, seq, status, known}]
for (const row of vpRows) {
  for (const v of decodeVehicles(new Uint8Array(row.body)).vehicles) {
    if (!v.tripId || v.seq < 0 || !v.ts) continue;
    let list = obs.get(v.tripId);
    if (!list) obs.set(v.tripId, (list = []));
    const last = list[list.length - 1];
    if (last && last.t === v.ts) continue;
    list.push({ t: v.ts, seq: v.seq, status: v.status, known: row.ts, route: v.routeId });
  }
}

// Trip updates, expanded: per snapshot, per trip, [seq, time, delay] triples.
const sched = new Map(); // tripId -> Map(seq -> scheduled time)
const tripRoute = new Map();
const snapshots = tuRows.map((row) => {
  const trips = JSON.parse(row.body.toString());
  return {
    ts: row.ts,
    trips: trips.map(([tripId, route, , , , d]) => {
      tripRoute.set(tripId, route);
      let sm = sched.get(tripId);
      if (!sm) sched.set(tripId, (sm = new Map()));
      const stops = [];
      let s = 0, t = 0, dl = 0;
      for (let i = 0; i < d.length; i += 3) {
        s += d[i]; t += d[i + 1]; dl += d[i + 2];
        stops.push(s, t, dl);
        sm.set(s, t - dl);
      }
      return { tripId, stops };
    }),
  };
});

const arrivals = new Map(); // tripId -> Map(seq -> {A, unc, known})
for (const [tripId, list] of obs) {
  list.sort((a, b) => a.t - b.t);
  const seqs = [...(sched.get(tripId)?.keys() || [])].sort((a, b) => a - b);
  if (seqs.length < 2) continue;
  const m = new Map();
  for (const k of seqs.slice(1)) {
    const i = list.findIndex((o) => o.seq > k || (o.seq === k && o.status === 1));
    if (i <= 0) continue;
    const t1 = list[i - 1].t, t2 = list[i].t;
    if (t2 - t1 > 90) continue;
    m.set(k, { A: (t1 + t2) / 2, unc: (t2 - t1) / 2, known: list[i].known });
  }
  if (m.size) arrivals.set(tripId, m);
}
let nArr = 0;
for (const m of arrivals.values()) nArr += m.size;
console.log(`observed arrivals: ${nArr} at stops, over ${arrivals.size} trips`);

// --- 3. events ----------------------------------------------------------------
// Flat arrays keep a full day's millions of events cheap.
// The feed's clock. On 2026-11-01, when clocks fell back, BC Transit's feed
// shifted every timetable and prediction an hour into the future. Buses that
// were just seen at a stop reveal it: their apparent delay is about -1 h.
// Per snapshot, the median apparent delay of recently seen buses, rounded to
// whole hours, is the offset; bide removes it. Only past reports are used.
function clockOffset(snap) {
  const d = [];
  for (const { tripId } of snap.trips) {
    const arr = arrivals.get(tripId), sm = sched.get(tripId);
    if (!arr) continue;
    let pj = -1, pA = 0;
    for (const [seq, a] of arr) if (a.known <= snap.ts && seq > pj && sm.has(seq)) { pj = seq; pA = a.A; }
    if (pj >= 0 && snap.ts - pA < 600) d.push(pA - sm.get(pj));
  }
  if (d.length < 10) return 0;
  d.sort((a, b) => a - b);
  return Math.round(d[d.length >> 1] / 3600) * 3600;
}

let blank = 0, offsetSnaps = 0;
const ev = { A: [], made: [], official: [], sched: [], off: [], h: [], hour: [], route: [], prevA: [], prevSched: [], nextSched: [], has: [] };
for (const snap of snapshots) {
  const off = clockOffset(snap);
  if (off) offsetSnaps++;
  for (const { tripId, stops } of snap.trips) {
    const arr = arrivals.get(tripId);
    if (!arr) continue;
    const sm = sched.get(tripId);
    // What bide knew at this moment: the latest stop this trip was seen to reach.
    let pj = -1, pA = 0, pS = 0;
    for (const [seq, a] of arr) {
      if (a.known <= snap.ts && seq > pj && sm.has(seq)) { pj = seq; pA = a.A; pS = sm.get(seq); }
    }
    // The next stop's timetable time: if the bus hasn't got there by now, it
    // is at least (now - that time) late.
    let nS = 0, nSeq = Infinity;
    for (const [seq, t] of sm) if (seq > pj && seq < nSeq) { nSeq = seq; nS = t; }
    for (let i = 0; i < stops.length; i += 3) {
      const seq = stops[i], a = arr.get(seq);
      if (!a || a.unc > 45) continue;
      const h = a.A - snap.ts;
      if (h <= 0 || h > 1800) continue;
      if (pj >= seq) continue; // the bus was already known to be past this stop
      // A prediction with no usable time (BC Transit sometimes sends none)
      // drops the event for every predictor, and is counted.
      if (!stops[i + 1] || Math.abs(stops[i + 1] - a.A) > 3 * 3600) { blank++; continue; }
      ev.A.push(a.A); ev.made.push(snap.ts); ev.official.push(stops[i + 1]); ev.sched.push(stops[i + 1] - stops[i + 2]); ev.off.push(off);
      ev.h.push(h); ev.hour.push(localHour(a.A)); ev.route.push(tripRoute.get(tripId) || '?');
      ev.has.push(pj >= 0 ? 1 : 0); ev.prevA.push(pA); ev.prevSched.push(pS); ev.nextSched.push(nS);
    }
  }
}
const N = ev.A.length;
if (offsetSnaps) console.log(`feed clock off by whole hours in ${offsetSnaps} of ${snapshots.length} prediction snapshots`);
console.log(`events (prediction, then arrival, same set for every predictor): ${N}; dropped for a blank prediction: ${blank}`);

// bide v1: delay persistence with drift. The bus's current delay is the
// delay seen at the last stop it reached, or more if it still hasn't reached
// the next one. That delay carries forward, fading with scheduled time ahead
// (rho per 10 min when late, gamma when early, since early buses wait at
// timepoints), plus a drift of beta seconds per scheduled minute ahead, as
// buses tend to lose time along a trip. Never sooner than physically possible.
function bide(i, p) {
  const o = ev.off[i], s = ev.sched[i] + o, made = ev.made[i], ps = ev.prevSched[i] + o;
  const live = ev.nextSched[i] ? made - ev.nextSched[i] - o : -Infinity;
  if (!ev.has[i]) return Math.max(s + Math.max(0, live), made + 15);
  const d = Math.max(ev.prevA[i] - ps, live);
  const ahead = Math.max(0, s - ps);
  const k = (d >= 0 ? p.rho : p.gamma) ** (ahead / 600);
  return Math.max(s + d * k + (p.beta * ahead) / 60, ev.prevA[i] + 0.75 * ahead, made + 15);
}

// bide+: a blend of BC Transit's prediction, bide's own and the timetable.
// Each is turned into "seconds from now"; per band of BC Transit's lead time
// (known when the prediction is made), arrival = w0 + w1*official + w2*bide +
// w3*schedule, with weights learned on an earlier day (least absolute error).
// bide carries the bus's live delay, which BC Transit's figure underweights.
// Days fitted before the blend existed carry only c, a drift per lead minute.
const LEAD_BANDS = [120, 300, 600, 900, 1200, Infinity];
const band = (lead) => LEAD_BANDS.findIndex((b) => lead <= b);
function features(i, p) {
  const made = ev.made[i];
  return [1, Math.max(0, ev.official[i] + ev.off[i] - made), Math.max(0, bide(i, p) - made), ev.sched[i] + ev.off[i] - made];
}
function bidePlus(i, p) {
  const lead = Math.max(0, ev.official[i] + ev.off[i] - ev.made[i]);
  const w = p.w?.[band(lead)];
  if (!w) return Math.max(ev.official[i] + ev.off[i] + ((p.c || 0) * lead) / 60, ev.made[i] + 15);
  const x = features(i, p);
  return Math.max(ev.made[i] + w[0] * x[0] + w[1] * x[1] + w[2] * x[2] + w[3] * x[3], ev.made[i] + 15);
}

// Least absolute error by iteratively reweighted least squares.
function fitL1(X, y) {
  const k = X[0].length;
  let w = null;
  for (let it = 0; it < 12; it++) {
    const A = Array.from({ length: k }, () => new Float64Array(k + 1));
    for (let n = 0; n < X.length; n++) {
      const x = X[n];
      const r = w ? Math.abs(y[n] - x.reduce((s, v, j) => s + v * w[j], 0)) : 1;
      const q = 1 / Math.max(r, 10);
      for (let a = 0; a < k; a++) {
        for (let b = 0; b < k; b++) A[a][b] += q * x[a] * x[b];
        A[a][k] += q * x[a] * y[n];
      }
    }
    for (let a = 0; a < k; a++) A[a][a] += 1e-3; // a whisker of ridge for stability
    for (let c = 0; c < k; c++) {
      let piv = c;
      for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      for (let r = 0; r < k; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
      }
    }
    w = Array.from({ length: k }, (_, a) => A[a][k] / A[a][a]);
  }
  return w;
}

// --- 4. scoring ---------------------------------------------------------------
function stats(errs) {
  const n = errs.length;
  if (!n) return null;
  let ae = 0, se = 0, b = 0, w = 0;
  const abs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const e = errs[i], a = Math.abs(e);
    ae += a; se += e * e; b += e; if (a <= 60) w++;
    abs[i] = a;
  }
  abs.sort();
  const r = (x) => Math.round(x * 10) / 10;
  return { n, mae: r(ae / n), rmse: r(Math.sqrt(se / n)), bias: r(b / n), within60: r((100 * w) / n), p90: r(abs[Math.floor(n * 0.9)]) };
}

function score(filter, p) {
  const out = { official: [], schedule: [], bide: [], bidePlus: [] };
  for (let i = 0; i < N; i++) {
    if (!filter(i)) continue;
    out.official.push(ev.official[i] - ev.A[i]);
    out.schedule.push(ev.sched[i] - ev.A[i]);
    out.bide.push(bide(i, p) - ev.A[i]);
    out.bidePlus.push(bidePlus(i, p) - ev.A[i]);
  }
  return { official: stats(out.official), schedule: stats(out.schedule), bide: stats(out.bide), bidePlus: stats(out.bidePlus) };
}

const buckets = BUCKETS.map(([lo, hi]) => ({ lo, hi, ...score((i) => ev.h[i] > lo * 60 && ev.h[i] <= hi * 60, params) }));
const overall = score(() => true, params);
const byHour = [];
for (let h = 0; h < 24; h++) {
  const s = score((i) => ev.hour[i] === h, params);
  if (s.official) byHour.push({ hour: h, n: s.official.n, official: s.official.mae, bide: s.bide.mae, bidePlus: s.bidePlus.mae, schedule: s.schedule.mae });
}
const routeCount = {};
for (const r of ev.route) routeCount[r] = (routeCount[r] || 0) + 1;
const byRoute = Object.entries(routeCount)
  .filter(([, n]) => n >= 200)
  .map(([route]) => {
    const s = score((i) => ev.route[i] === route, params);
    return { route: route.replace('-VIC', ''), n: s.official.n, official: s.official.mae, bide: s.bide.mae, bidePlus: s.bidePlus.mae, schedule: s.schedule.mae };
  })
  .sort((a, b) => b.official - a.official);

// Fit tomorrow's parameters on today: a coarse grid over a sample of events.
let fitted = { ...params }, best = Infinity;
const stride = Math.max(1, Math.floor(N / 150000));
for (let rho = 0.7; rho <= 1.0001; rho += 0.05) {
  for (let gamma = 0; gamma <= 1.0001; gamma += 0.2) {
    for (let beta = 0; beta <= 16; beta += 2) {
      const p = { rho, gamma, beta };
      let ae = 0;
      for (let i = 0; i < N; i += stride) ae += Math.abs(bide(i, p) - ev.A[i]);
      if (ae < best) { best = ae; fitted = { rho: +rho.toFixed(2), gamma: +gamma.toFixed(1), beta }; }
    }
  }
}
// bide+ weights, per lead band, on the same sample, using the bide params
// just fitted (that is what tomorrow's bide+ will see).
const bands = LEAD_BANDS.map(() => ({ X: [], y: [] }));
for (let i = 0; i < N; i += stride) {
  const b = bands[band(Math.max(0, ev.official[i] + ev.off[i] - ev.made[i]))];
  b.X.push(features(i, fitted)); b.y.push(ev.A[i] - ev.made[i]);
}
// When the feed carries no delays (as on 2026-11-01), official and timetable
// are the same number and their weights can't be told apart: the timetable
// is left out rather than fitted to a wild +/- pair.
let withDelay = 0;
for (let i = 0; i < N; i += stride) if (Math.abs(ev.official[i] - ev.sched[i]) > 30) withDelay++;
const useSched = withDelay > 0.05 * Math.ceil(N / stride);
fitted.w = bands.map((b) => {
  if (b.X.length < 200) return null;
  const w = fitL1(useSched ? b.X : b.X.map((x) => x.slice(0, 3)), b.y);
  return [...w, ...(useSched ? [] : [0])].map((v) => +v.toFixed(4));
});

// Recording began partway through the first day; say so on the board.
const firstSnap = vpRows[0].ts;
const summary = {
  generated: new Date().toISOString(),
  partialFrom: firstSnap - FROM > 3600 ? firstSnap : null,
  window: [FROM, TO],
  snapshots: { vehicles: vpRows.length, predictions: tuRows.length },
  arrivals: nArr,
  trips: arrivals.size,
  events: N,
  droppedBlank: blank,
  feedClockOffset: offsetSnaps ? +(offsetSnaps / snapshots.length).toFixed(3) : 0,
  params: { used: params, fitted },
  overall,
  buckets,
  byHour,
  byRoute,
  method:
    'Arrivals: midpoint of the two vehicle reports either side of reaching a stop (kept when within +/-45 s). ' +
    'Events: every BC Transit prediction made 0-30 min before the observed arrival. All predictors are scored on the same events. ' +
    "bide uses only reports already received when the prediction was made, and parameters fitted on an earlier day.",
};

fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL(`./out/${DATE}.json`, import.meta.url), JSON.stringify(summary, null, 1));
const m = (x) => (x ? String(x.mae).padStart(6) : '     –');
console.log('\nMAE, seconds     official    bide   bide+   schedule');
for (const b of buckets) console.log(`${String(b.lo).padStart(2)}-${String(b.hi).padEnd(2)} min (${String(b.official?.n ?? 0).padStart(6)})  ${m(b.official)}  ${m(b.bide)}  ${m(b.bidePlus)}  ${m(b.schedule)}`);
console.log(`overall           ${m(overall.official)}  ${m(overall.bide)}  ${m(overall.bidePlus)}  ${m(overall.schedule)}`);
console.log(`within 1 min      ${overall.official.within60}%  ${overall.bide.within60}%  ${overall.bidePlus.within60}%`);
console.log(`fitted for next day: ${JSON.stringify(fitted)}`);

if (DRY) process.exit(0);

// --- 5. publish ----------------------------------------------------------------
async function post(body) {
  const res = await fetch(`${URL_BASE}/api/ingest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ingest ${body.kind}: ${res.status} ${await res.text()}`);
}
const rows = [...arrivals].map(([trip, m]) => ({
  trip,
  route: tripRoute.get(trip) || obs.get(trip)?.[0]?.route || '',
  stops: [...m].map(([seq, a]) => [seq, Math.round(a.A), Math.round(a.unc)]),
}));
for (let i = 0; i < rows.length; i += 200) await post({ kind: 'arrivals', date: DATE, rows: rows.slice(i, i + 200) });
await post({ kind: 'day', date: DATE, summary });
console.log(`published ${DATE}: ${rows.length} trips of arrivals and the day's scoreboard`);
