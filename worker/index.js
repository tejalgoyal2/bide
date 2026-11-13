import { DurableObject } from 'cloudflare:workers';
import { feedTimestamp, decodeTripUpdates, decodeVehicles, decodeAlerts } from '../shared/gtfsrt.js';
import { BOUNDS } from '../shared/geo.js';
import { bideAt, plusAt, blendParams } from '../shared/model.js';

const FEED = 'https://bct.tmix.se/gtfs-realtime/';
const GTFS = 'https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=48';
const OP = '?operatorIds=48';

const CODE_VERSION = 9;
const TICK = 10_000; // vehicle feed refreshes about every 15 s
const TRIP_EVERY = 60_000;
const ALERT_EVERY = 300_000;
// Raw snapshots are kept 30 days: long past being scored (the nightly run
// takes yesterday), and it holds storage near 1.5 GB instead of filling 4 GB.
const KEEP_DAYS = 30;
const PRUNE_EVERY = 3_600_000;
// The free plan stops writes at 5 GB. Stop well short of it, whatever the plan.
const MAX_DB_BYTES = 4e9;

async function gzip(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function gunzip(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Trip updates shrink a lot once delta-encoded: stop sequences step by one and
// times by a minute or two, so gzip squeezes them hard afterwards.
function compactTrips(feed) {
  return feed.trips.map((t) => {
    const s = t.stops;
    const d = [];
    let ps = 0, pt = 0, pd = 0;
    for (let i = 0; i < s.length; i += 3) {
      d.push(s[i] - ps, s[i + 1] - pt, s[i + 2] - pd);
      ps = s[i]; pt = s[i + 1]; pd = s[i + 2];
    }
    return [t.tripId, t.routeId, t.startDate, t.vehicle, t.ts, d];
  });
}

// The settings fitted on the most recent scored day, and which model won it.
let paramsCache = null;
async function latestParams(env) {
  if (paramsCache && Date.now() - paramsCache.at < 600_000) return paramsCache.p;
  const { results } = await env.DB.prepare('SELECT date, summary FROM days ORDER BY date DESC LIMIT 8').all();
  const days = results.map((r) => ({ date: r.date, ...JSON.parse(r.summary) }));
  // The same settings the scoreboard will use for today.
  const p = { ...blendParams(days, { rho: 0.95, gamma: 0.5, beta: 0, c: 0 }), date: days[0]?.date ?? null, best: 'bidePlus' };
  if (days[0]) {
    const o = days[0].overall;
    p.best = ['bide', 'bidePlus'].sort((a, b) => o[a].mae - o[b].mae)[0];
    p.mae = { official: o.official.mae, [p.best]: o[p.best].mae };
  }
  paramsCache = { at: Date.now(), p };
  return p;
}

const NEWS_FEEDS = [
  ['CHEK', 'https://www.cheknews.ca/feed/'],
  ['Times Colonist', 'https://www.timescolonist.com/rss/local-news'],
  ['Victoria News', 'https://www.vicnews.com/feed/'],
  ['Victoria Buzz', 'https://victoriabuzz.com/feed/'],
];
const unescape = (t) => t
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
  .replace(/&ndash;|&mdash;/g, '–').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
async function readFeed([source, feed]) {
  const res = await fetch(feed, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; bide; +https://bide.itejalgoyal.workers.dev)' }, signal: AbortSignal.timeout(6000), cf: { cacheTtl: 600 } });
  if (!res.ok) throw new Error(res.status);
  const xml = await res.text();
  const tag = (item, t) => (item.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '';
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 15).map(([, item]) => ({
    source,
    title: unescape(tag(item, 'title')).slice(0, 200),
    link: unescape(tag(item, 'link')),
    at: Date.parse(tag(item, 'pubDate')) || 0,
    text: unescape(tag(item, 'description')).slice(0, 280),
  })).filter((i) => /^https:\/\//.test(i.link));
}

export class Recorder extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS vp (ts INTEGER PRIMARY KEY, z BLOB);
      CREATE TABLE IF NOT EXISTS tu (ts INTEGER PRIMARY KEY, z BLOB);
      CREATE TABLE IF NOT EXISTS al (ts INTEGER PRIMARY KEY, z BLOB);
      CREATE TABLE IF NOT EXISTS gtfs (seen INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE IF NOT EXISTS err (at INTEGER, what TEXT);
    `);
    this.live = null;
    this.delays = { ts: 0, d: {} };
    this.state = { vp: 0, tu: 0, al: 0, tuAt: 0, alAt: 0, gtfsName: '' };
    // Live progress for the bus card: per trip, its last report and the last
    // stop it was seen to reach; its timetable; its latest predictions.
    this.track = new Map();
    this.sched = new Map();
    this.tu = null;
    this.warmed = false;
    ctx.blockConcurrencyWhile(async () => {
      Object.assign(this.state, (await ctx.storage.get('state')) || {});
    });
  }

  async ensure() {
    if ((await this.ctx.storage.getAlarm()) == null) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
    return true;
  }

  async alarm() {
    const now = Date.now();
    // Schedule the next tick first so a failure here never stops the recorder.
    await this.ctx.storage.setAlarm(Math.ceil((now + 1) / TICK) * TICK);
    const st = this.state;
    const full = this.sql.databaseSize > MAX_DB_BYTES;
    if (!this.warmed) await this.warm().catch((e) => this.fail('warm: ' + e.message));
    const jobs = [this.record('vp', 'vehicleupdates.pb', full)];
    if (now - st.tuAt >= TRIP_EVERY) {
      st.tuAt = now;
      jobs.push(this.record('tu', 'tripupdates.pb', full));
    }
    if (now - st.alAt >= ALERT_EVERY) {
      st.alAt = now;
      jobs.push(this.record('al', 'alerts.pb', full));
    }
    if (now - (st.pruneAt || 0) >= PRUNE_EVERY) {
      st.pruneAt = now;
      jobs.push(this.prune());
    }
    const results = await Promise.allSettled(jobs);
    for (const r of results) {
      if (r.status === 'rejected') this.fail(String(r.reason?.message || r.reason));
    }
    await this.ctx.storage.put('state', st);
  }

  async record(table, file, full) {
    const u8 = await get(FEED + file + OP);
    const ts = feedTimestamp(u8);
    if (table === 'vp') this.live = { u8, ts, fetched: Date.now() };
    if (table === 'al') this.alertsU8 = u8;
    // The feed often hasn't moved since the last poll; only keep new snapshots.
    if (!ts || ts === this.state[table] || full) return;
    this.state[table] = ts;
    let body = u8;
    if (table === 'vp') this.observe(decodeVehicles(u8).vehicles);
    if (table === 'tu') {
      const feed = decodeTripUpdates(u8);
      this.ingest(ts, feed.trips);
      // Each trip's current delay at its next stop, for the map's lateness view.
      const d = {};
      for (const t of feed.trips) if (t.stops.length) d[t.tripId] = t.stops[2];
      this.delays = { ts, d };
      body = new TextEncoder().encode(JSON.stringify(compactTrips(feed)));
    }
    this.sql.exec(`INSERT OR REPLACE INTO ${table} VALUES (?, ?)`, ts, await gzip(body));
  }

  // A stop counts as reached once a report shows the bus past it, or stopped
  // at it; the moment is the midpoint of the reports either side, as the
  // scoreboard does it. A gap over 90 s is too vague to use.
  observe(vehicles) {
    for (const v of vehicles) {
      if (!v.tripId || v.seq < 0 || !v.ts) continue;
      const o = this.track.get(v.tripId);
      if (!o) { this.track.set(v.tripId, { t: v.ts, seq: v.seq, status: v.status, pass: null }); continue; }
      if (v.ts <= o.t) continue;
      const k = v.status === 1 ? v.seq : v.seq - 1, ko = o.status === 1 ? o.seq : o.seq - 1;
      if (k > ko && v.ts - o.t <= 90) o.pass = { seq: k, A: (o.t + v.ts) / 2 };
      o.t = v.ts; o.seq = v.seq; o.status = v.status;
    }
    const old = Date.now() / 1000 - 3 * 3600;
    for (const [id, o] of this.track) if (o.t < old) this.track.delete(id);
  }

  ingest(ts, trips) {
    const byTrip = new Map();
    for (const t of trips) {
      // Late at night the feed also carries tomorrow's run of the same trip
      // id: today's run (the earlier start date) wins until it's done.
      const prev = byTrip.get(t.tripId);
      if (prev && prev.startDate && t.startDate && prev.startDate < t.startDate) continue;
      let sm = this.sched.get(t.tripId);
      if (!sm || (t.startDate && sm.startDate && t.startDate !== sm.startDate && !(t.startDate < sm.startDate))) {
        // A new day's run replaces the old timetable only once the old run has gone quiet.
        const o = this.track.get(t.tripId);
        if (sm && o && Date.now() / 1000 - o.t < 1800) continue;
        this.sched.set(t.tripId, (sm = new Map()));
      }
      if (t.startDate) sm.startDate = t.startDate;
      for (let i = 0; i < t.stops.length; i += 3) sm.set(t.stops[i], t.stops[i + 1] - t.stops[i + 2]);
      byTrip.set(t.tripId, t);
    }
    for (const id of this.sched.keys()) if (!byTrip.has(id) && !this.track.has(id)) this.sched.delete(id);
    this.tu = { ts, byTrip };
  }

  // After a restart, replay the last half hour so the card works at once.
  async warm() {
    this.warmed = true;
    const since = Math.floor(Date.now() / 1000) - 1800;
    for (const r of this.sql.exec('SELECT ts, z FROM tu WHERE ts > ? ORDER BY ts', since).toArray()) {
      const feed = JSON.parse(new TextDecoder().decode(await gunzip(new Uint8Array(r.z))));
      this.ingest(r.ts, feed.map(([tripId, , startDate, , , d]) => {
        const stops = [];
        let q = 0, t = 0, dl = 0;
        for (let i = 0; i < d.length; i += 3) { q += d[i]; t += d[i + 1]; dl += d[i + 2]; stops.push(q, t, dl); }
        return { tripId, startDate, stops, ids: [] };
      }));
    }
    this.tu = null; // the next live poll brings stop ids too
    for (const r of this.sql.exec('SELECT z FROM vp WHERE ts > ? ORDER BY ts', since + 900).toArray()) {
      this.observe(decodeVehicles(await gunzip(new Uint8Array(r.z))).vehicles);
    }
  }

  // The feed's clock, as the scoreboard reads it: buses just seen at a stop
  // reveal a whole-hour error in the timetable times.
  clockOffset(now) {
    const d = [];
    for (const [id, o] of this.track) {
      const sm = this.sched.get(id);
      if (o.pass && now - o.pass.A < 600 && sm?.has(o.pass.seq)) d.push(o.pass.A - sm.get(o.pass.seq));
    }
    if (d.length < 10) return 0;
    d.sort((a, b) => a - b);
    const h = Math.round(d[d.length >> 1] / 3600);
    return Math.abs(h) === 1 ? h * 3600 : 0; // a clock change, never anything else
  }

  // The next few stops of one trip: BC Transit's prediction beside bide's and
  // bide+'s, worked out now with the latest fitted settings.
  trip(id, p, max = 6) {
    const t = this.tu?.byTrip.get(id);
    if (!t) return null;
    const now = Date.now() / 1000, off = this.clockOffset(now);
    const sm = this.sched.get(id), pass = this.track.get(id)?.pass;
    let pj = -1, pS = 0, nS = 0;
    if (pass) for (const [q, v] of sm) if (q <= pass.seq && q > pj) { pj = q; pS = v; }
    let nq = Infinity;
    for (const [q, v] of sm) if (q > pj && q < nq) { nq = q; nS = v; }
    const stops = [];
    for (let i = 0; i < t.stops.length && stops.length < max; i += 3) {
      const q = t.stops[i], official = t.stops[i + 1] + off, s = t.stops[i + 1] - t.stops[i + 2] + off;
      if (q <= pj || !t.stops[i + 1] || official < now - 60) continue;
      // official is what riders are shown, clock fault and all.
      const bide = bideAt(now, s, pj >= 0 ? 1 : 0, pass?.A || 0, pS + off, nS ? nS + off : 0, p);
      stops.push({ seq: q, id: t.ids[i / 3] || '', official: t.stops[i + 1], sched: Math.round(s), bide: Math.round(bide), plus: Math.round(plusAt(now, official, bide, s, p)) });
    }
    return { now: Math.round(now), feed: this.tu.ts, off, passed: pj >= 0 ? { seq: pj, at: Math.round(pass.A), delay: Math.round(pass.A - pS - off) } : null, stops };
  }

  // A stop's departures board: every trip still due at this stop, soonest
  // first, with BC Transit's time beside bide's and bide+'s.
  stop(stopId, p) {
    if (!this.tu) return null;
    const now = Date.now() / 1000, rows = [];
    for (const [tripId, t] of this.tu.byTrip) {
      if (!t.ids.includes(stopId)) continue;
      const r = this.trip(tripId, p, 200);
      const s = r?.stops.find((x) => x.id === stopId);
      if (!s || s.official - now > 75 * 60) continue;
      rows.push({ trip: tripId, route: t.routeId, official: s.official, bide: s.bide, plus: s.plus, sched: s.sched, seen: !!r.passed });
    }
    rows.sort((a, b) => a.plus - b.plus);
    return { now: Math.round(now), off: this.clockOffset(now), rows: rows.slice(0, 10) };
  }

  async prune() {
    const cut = Math.floor(Date.now() / 1000) - KEEP_DAYS * 86400;
    for (const t of ['vp', 'tu', 'al']) this.sql.exec(`DELETE FROM ${t} WHERE ts < ?`, cut);
  }

  noteGtfs(name) {
    const hash = name.split('_')[0];
    if (hash && hash !== this.state.gtfsName) {
      this.state.gtfsName = hash;
      this.sql.exec('INSERT OR REPLACE INTO gtfs VALUES (?, ?)', Date.now(), name);
    }
  }

  fail(what) {
    this.sql.exec('INSERT INTO err VALUES (?, ?)', Date.now(), what.slice(0, 300));
    this.sql.exec('DELETE FROM err WHERE at < ?', Date.now() - 7 * 86400_000);
  }

  async latest() {
    if (this.live && Date.now() - this.live.fetched < 60_000) return this.live;
    const row = this.sql.exec('SELECT ts, z FROM vp ORDER BY ts DESC LIMIT 1').toArray()[0];
    if (!row) return null;
    return { u8: await gunzip(new Uint8Array(row.z)), ts: row.ts, fetched: 0 };
  }

  currentDelays() {
    return this.delays;
  }

  async alerts() {
    let u8 = this.alertsU8;
    if (!u8) {
      const row = this.sql.exec('SELECT z FROM al ORDER BY ts DESC LIMIT 1').toArray()[0];
      if (!row) return [];
      u8 = this.alertsU8 = await gunzip(new Uint8Array(row.z));
    }
    const now = Date.now() / 1000;
    return decodeAlerts(u8)
      .alerts.filter((a) => a.description && a.periods.some(([s, e]) => (!s || s <= now) && (!e || e >= now)))
      .map((a) => ({ ...a, routes: [...new Set(a.routes)], stops: [...new Set(a.stops)] }));
  }

  // "Victoria right now": one sentence from Groq about the city's buses,
  // regenerated at most every 15 minutes to stay well inside the free tier.
  async nowLine(weather) {
    const cached = this.now || (await this.ctx.storage.get('now'));
    if (cached && cached.v === 2 && Date.now() - cached.at < 15 * 60_000) return cached;
    if (!this.env.GROQ_API_KEY) return cached || null;
    const live = await this.latest();
    const v = live ? decodeVehicles(live.u8).vehicles : [];
    const standing = v.filter((b) => b.occ >= 3).length;
    const d = Object.values(this.delays.d || {});
    const late = d.filter((x) => x >= 180).length;
    const routesStanding = [...new Set(v.filter((b) => b.occ >= 3).map((b) => b.routeId.replace('-VIC', '')))].slice(0, 5);
    const alerts = (await this.alerts()).filter((a) => a.header).map((a) => `${a.header}: ${a.description.split('\n')[0].slice(0, 140)}`);
    const local = new Date().toLocaleString('en-CA', { timeZone: 'America/Vancouver', weekday: 'long', hour: 'numeric', minute: '2-digit' });
    const facts = [
      `Local time: ${local}.`,
      `Buses on the road: ${v.length}. Standing room only: ${standing}${routesStanding.length ? ` (routes ${routesStanding.join(', ')})` : ''}.`,
      `Trips with predictions: ${d.length}; running 3+ minutes late: ${late}.`,
      weather ? `Weather: ${weather}.` : '',
      alerts.length ? `Service alerts: ${alerts.slice(0, 3).join(' | ')}` : 'No service alerts.',
    ].filter(Boolean).join('\n');
    const ask = async (model) =>
      fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          // Reasoning models think before they write; leave them room.
          max_tokens: model.includes('gpt-oss') ? 600 : 120,
          ...(model.includes('gpt-oss') && { reasoning_effort: 'low', include_reasoning: false }),
          temperature: 0.6,
          messages: [
            {
              role: 'system',
              content:
                'You write a single sentence of at most 22 words about how Victoria, BC\'s buses are doing right now, ' +
                'for the top of a live map. Write like a good local columnist: plain, specific, unhurried. ' +
                'Pick the one or two facts that matter most (a detour, crowding, lateness, the weather if it affects riders) ' +
                'and leave the rest out. Never list statistics; use at most one number, written as a digit. ' +
                'Use only the facts given; never invent places, numbers or causes. ' +
                'No clock times, no greetings, no exclamation marks, no emoji, no semicolons.',
            },
            { role: 'user', content: facts },
          ],
        }),
        signal: AbortSignal.timeout(15000),
      });
    try {
      // Models come and go on Groq's free tier; walk down the list.
      const models = [this.env.GROQ_MODEL || 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'];
      const why = [];
      for (const model of models) {
        const res = await ask(model);
        if (!res.ok) { why.push(`${model} ${res.status}`); if (res.status === 429 || res.status === 401) break; continue; }
        const text = (await res.json()).choices?.[0]?.message?.content?.trim().replace(/^"|"$/g, '');
        if (!text) { why.push(`${model} empty`); continue; }
        this.now = { text, at: Date.now(), v: 2 };
        await this.ctx.storage.put('now', this.now);
        break;
      }
      if (!this.now || Date.now() - this.now.at > 60_000) throw new Error(`groq: ${why.join(', ')}`);
    } catch (e) {
      this.fail(String(e.message || e));
    }
    return this.now || cached || null;
  }

  status() {
    const one = (q) => this.sql.exec(q).one();
    const count = (t) => one(`SELECT COUNT(*) n, MIN(ts) first, MAX(ts) last FROM ${t}`);
    return {
      code: CODE_VERSION,
      vehicles: count('vp'),
      tripUpdates: count('tu'),
      alerts: count('al'),
      schedules: this.sql.exec('SELECT seen, name FROM gtfs ORDER BY seen').toArray(),
      bytes: this.sql.databaseSize,
      groq: !!this.env.GROQ_API_KEY,
      recentErrors: this.sql.exec('SELECT at, what FROM err ORDER BY at DESC LIMIT 5').toArray(),
    };
  }

  // Raw gzipped snapshots between two feed timestamps, framed as
  // [u32 ts][u32 length][bytes] so a client can split them without parsing.
  export(table, from, to) {
    if (!['vp', 'tu', 'al'].includes(table)) throw new Error('bad table');
    const rows = this.sql
      .exec(`SELECT ts, z FROM ${table} WHERE ts >= ? AND ts < ? ORDER BY ts LIMIT 2000`, from, to)
      .toArray();
    let size = 0;
    for (const r of rows) size += 8 + r.z.byteLength;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    let p = 0;
    for (const r of rows) {
      dv.setUint32(p, r.ts);
      dv.setUint32(p + 4, r.z.byteLength);
      out.set(new Uint8Array(r.z), p + 8);
      p += 8 + r.z.byteLength;
    }
    return out;
  }
}

const json = (data, maxAge = 0) =>
  new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${maxAge}` },
  });

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const rec = env.RECORDER.get(env.RECORDER.idFromName('victoria'));

    if (url.pathname === '/api/live') {
      const live = await rec.latest();
      if (!live) return new Response('warming up', { status: 503 });
      return new Response(live.u8, {
        headers: {
          'content-type': 'application/x-protobuf',
          'cache-control': 'public, max-age=5',
          'x-feed-ts': String(live.ts),
        },
      });
    }

    // One bus's next stops, BC Transit beside bide, for the bus card.
    if (url.pathname === '/api/trip') {
      const id = url.searchParams.get('id') || '';
      if (!/^[\w:.-]{1,80}$/.test(id)) return new Response('bad id', { status: 400 });
      const p = await latestParams(env);
      const out = await rec.trip(id, p);
      return json(out && { ...out, model: { from: p.date, best: p.best, mae: p.mae } }, 10);
    }

    if (url.pathname === '/api/stop') {
      const id = url.searchParams.get('id') || '';
      if (!/^[\w.-]{1,20}$/.test(id)) return new Response('bad id', { status: 400 });
      const p = await latestParams(env);
      const out = await rec.stop(id, p);
      return json(out && { ...out, model: { from: p.date, best: p.best } }, 15);
    }

    if (url.pathname === '/api/delays') {
      return json(await rec.currentDelays(), 20);
    }

    if (url.pathname === '/api/status') {
      ctx.waitUntil(rec.ensure());
      return json(await rec.status(), 30);
    }

    if (url.pathname === '/api/alerts') {
      return json(await rec.alerts(), 120);
    }

    if (url.pathname === '/api/now') {
      return json(await rec.nowLine(url.searchParams.get('weather')?.slice(0, 80)), 120);
    }

    // Power outages inside the map, from BC Hydro's public outage map; one
    // upstream call per 2 minutes, shared via the edge cache.
    if (url.pathname === '/api/outages') {
      const cache = caches.default;
      const key = new Request('https://bide.cache/outages');
      const hit = await cache.match(key);
      if (hit) return hit;
      let list = [], ok = true;
      try {
        const res = await fetch('https://www.bchydro.com/power-outages/app/outages-map-data.json', {
          headers: { 'user-agent': 'bide (https://bide.itejalgoyal.workers.dev)', accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(res.status);
        list = (await res.json())
          .filter((o) => o.latitude > BOUNDS.south && o.latitude < BOUNDS.north && o.longitude > BOUNDS.west && o.longitude < BOUNDS.east)
          .map((o) => ({
            id: o.id, area: o.area, place: o.municipality, cause: o.cause, out: o.numCustomersOut,
            since: o.dateOff, back: o.showEtr ? o.crewEtr : null, crew: o.crewStatusDescription,
            lat: o.latitude, lon: o.longitude, poly: (o.polygon || []).map((v) => +v.toFixed(5)),
          }));
      } catch {
        ok = false;
      }
      const out = json(list, ok ? 120 : 30);
      out.headers.set('x-upstream', ok ? 'ok' : 'failed');
      await cache.put(key, out.clone());
      return out;
    }

    // Local headlines from four Victoria newsrooms' public RSS feeds, merged,
    // newest first; one upstream round every 15 minutes via the edge cache.
    if (url.pathname === '/api/news') {
      const cache = caches.default;
      const key = new Request('https://bide.cache/news');
      const hit = await cache.match(key);
      if (hit) return hit;
      const items = (await Promise.allSettled(NEWS_FEEDS.map(readFeed))).flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      const seen = new Set();
      const list = items
        .filter((i) => i.title && !seen.has(i.title.toLowerCase()) && seen.add(i.title.toLowerCase()))
        .sort((a, b) => b.at - a.at)
        .slice(0, 40);
      const out = json(list, list.length ? 900 : 60);
      await cache.put(key, out.clone());
      return out;
    }

    if (url.pathname === '/api/scores') {
      const { results } = await env.DB.prepare('SELECT date, summary FROM days ORDER BY date DESC LIMIT 60').all();
      return json(results.map((r) => ({ date: r.date, ...JSON.parse(r.summary) })), 300);
    }

    // The nightly pipeline posts each day's scoreboard and observed arrivals.
    if (url.pathname === '/api/ingest' && req.method === 'POST') {
      if (!env.EXPORT_KEY || req.headers.get('authorization') !== `Bearer ${env.EXPORT_KEY}`) {
        return new Response('unauthorized', { status: 401 });
      }
      const body = await req.json();
      if (body.kind === 'day') {
        await env.DB.prepare('INSERT OR REPLACE INTO days VALUES (?, ?, ?)')
          .bind(body.date, JSON.stringify(body.summary), Date.now())
          .run();
      } else if (body.kind === 'arrivals') {
        const stmt = env.DB.prepare('INSERT OR REPLACE INTO arrivals VALUES (?, ?, ?, ?)');
        await env.DB.batch(body.rows.slice(0, 200).map((r) => stmt.bind(body.date, r.trip, r.route, JSON.stringify(r.stops))));
      } else return new Response('bad kind', { status: 400 });
      return json({ ok: true });
    }

    if (url.pathname === '/api/export') {
      if (!env.EXPORT_KEY || req.headers.get('authorization') !== `Bearer ${env.EXPORT_KEY}`) {
        return new Response('unauthorized', { status: 401 });
      }
      const p = url.searchParams;
      const body = await rec.export(p.get('table'), +p.get('from') || 0, +p.get('to') || 2 ** 32 - 1);
      return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
    }

    if (url.pathname.startsWith('/api/')) return new Response('not found', { status: 404 });
    return env.ASSETS.fetch(req);
  },

  // A watchdog that restarts the recorder's alarm chain if it ever stops.
  // Every six hours it also notes which schedule is published: the export is
  // built on demand and slow, so it lives here rather than in the alarm. Its
  // file name carries a content hash.
  async scheduled(event, env) {
    const rec = env.RECORDER.get(env.RECORDER.idFromName('victoria'));
    await rec.ensure();
    const d = new Date(event.scheduledTime);
    if (d.getUTCHours() % 6 !== 0 || d.getUTCMinutes() !== 0) return;
    const res = await fetch(GTFS, { method: 'HEAD', signal: AbortSignal.timeout(600_000) });
    const name = (res.headers.get('content-disposition') || '').split('filename=')[1] || '';
    await rec.noteGtfs(name);
  },
};
