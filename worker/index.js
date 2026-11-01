import { DurableObject } from 'cloudflare:workers';
import { feedTimestamp, decodeTripUpdates } from '../shared/gtfsrt.js';

const FEED = 'https://bct.tmix.se/gtfs-realtime/';
const GTFS = 'https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=48';
const OP = '?operatorIds=48';

const CODE_VERSION = 3;
const TICK = 10_000; // vehicle feed refreshes about every 15 s
const TRIP_EVERY = 60_000;
const ALERT_EVERY = 300_000;
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
    const jobs = [this.record('vp', 'vehicleupdates.pb', full)];
    if (now - st.tuAt >= TRIP_EVERY) {
      st.tuAt = now;
      jobs.push(this.record('tu', 'tripupdates.pb', full));
    }
    if (now - st.alAt >= ALERT_EVERY) {
      st.alAt = now;
      jobs.push(this.record('al', 'alerts.pb', full));
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
    // The feed often hasn't moved since the last poll; only keep new snapshots.
    if (!ts || ts === this.state[table] || full) return;
    this.state[table] = ts;
    let body = u8;
    if (table === 'tu') {
      const feed = decodeTripUpdates(u8);
      // Each trip's current delay at its next stop, for the map's lateness view.
      const d = {};
      for (const t of feed.trips) if (t.stops.length) d[t.tripId] = t.stops[2];
      this.delays = { ts, d };
      body = new TextEncoder().encode(JSON.stringify(compactTrips(feed)));
    }
    this.sql.exec(`INSERT OR REPLACE INTO ${table} VALUES (?, ?)`, ts, await gzip(body));
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

    if (url.pathname === '/api/delays') {
      return json(await rec.currentDelays(), 20);
    }

    if (url.pathname === '/api/status') {
      ctx.waitUntil(rec.ensure());
      return json(await rec.status(), 30);
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
