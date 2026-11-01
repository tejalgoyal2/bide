// Bakes BC Transit's Victoria schedule (GTFS) into web/public/data:
//   transit.json  routes, route shapes, stops, and how many trips start on
//                 each shape in each hour (the service-frequency network)
//   trips.json    trip id -> route, shape, direction, headsign
// Usage: node scripts/bake-gtfs.mjs [gtfs-dir]
// Without a directory it downloads the current feed into .cache/gtfs.
import fs from 'node:fs';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { toXY } from '../shared/geo.js';

const OUT = new URL('../web/public/data/', import.meta.url);
const URL_GTFS = 'https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=48';

let dir = process.argv[2];
if (!dir) {
  dir = '.cache/gtfs';
  if (!fs.existsSync(`${dir}/trips.txt`)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('downloading GTFS (slow, it is built on demand)…');
    const res = await fetch(URL_GTFS);
    fs.writeFileSync(`${dir}/gtfs.zip`, Buffer.from(await res.arrayBuffer()));
    execFileSync('unzip', ['-o', '-q', `${dir}/gtfs.zip`, '-d', dir]);
  }
}

function splitCsv(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function rows(name, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(`${dir}/${name}`) });
  let head = null;
  for await (const raw of rl) {
    const line = raw.replace(/^﻿/, '').trimEnd();
    if (!line) continue;
    const cells = splitCsv(line);
    if (!head) { head = Object.fromEntries(cells.map((c, i) => [c, i])); continue; }
    fn(cells, head);
  }
}

function pack(flat) {
  const out = [];
  let px = 0, py = 0;
  for (let i = 0; i < flat.length; i += 2) {
    const x = Math.round(flat[i]), y = Math.round(flat[i + 1]);
    out.push(x - px, y - py);
    px = x; py = y;
  }
  return out;
}

const routes = [];
const routeIdx = new Map();
await rows('routes.txt', (c, h) => {
  routeIdx.set(c[h.route_id], routes.length);
  routes.push([c[h.route_id], c[h.route_short_name], c[h.route_long_name], c[h.route_color] || '777777', c[h.route_text_color] || 'FFFFFF']);
});

const stops = [];
const stopIdx = new Map();
await rows('stops.txt', (c, h) => {
  const [x, y] = toXY(+c[h.stop_lon], +c[h.stop_lat]);
  stopIdx.set(c[h.stop_id], stops.length);
  stops.push([c[h.stop_id], c[h.stop_name], Math.round(x), Math.round(y)]);
});

// Which services run on a sample weekday, Saturday and Sunday.
const DAYS = { weekday: '20261103', saturday: '20261107', sunday: '20261108' };
const svcDays = new Map();
await rows('calendar_dates.txt', (c, h) => {
  const day = Object.keys(DAYS).find((k) => DAYS[k] === c[h.date]);
  if (!day || c[h.exception_type] !== '1') return;
  if (!svcDays.has(c[h.service_id])) svcDays.set(c[h.service_id], new Set());
  svcDays.get(c[h.service_id]).add(day);
});

const trips = {};
const tripDays = new Map();
const headsigns = [], headIdx = new Map();
const shapeIds = new Map();
await rows('trips.txt', (c, h) => {
  const sid = c[h.shape_id];
  if (!shapeIds.has(sid)) shapeIds.set(sid, shapeIds.size);
  const hs = c[h.trip_headsign];
  if (!headIdx.has(hs)) { headIdx.set(hs, headsigns.length); headsigns.push(hs); }
  trips[c[h.trip_id]] = [routeIdx.get(c[h.route_id]), shapeIds.get(sid), +c[h.direction_id], headIdx.get(hs)];
  const d = svcDays.get(c[h.service_id]);
  if (d) tripDays.set(c[h.trip_id], d);
});

const shapePts = new Map();
await rows('shapes.txt', (c, h) => {
  const sid = c[h.shape_id];
  if (!shapeIds.has(sid)) return;
  if (!shapePts.has(sid)) shapePts.set(sid, []);
  shapePts.get(sid).push([+c[h.shape_pt_sequence], +c[h.shape_pt_lon], +c[h.shape_pt_lat]]);
});
const shapes = [];
for (const [sid, i] of shapeIds) {
  const pts = (shapePts.get(sid) || []).sort((a, b) => a[0] - b[0]);
  shapes[i] = pack(pts.flatMap(([, lon, lat]) => toXY(lon, lat)));
}

// Trips starting on each shape in each hour, for each sample day. A trip's
// hour is that of its first departure.
const dayOff = { weekday: 0, saturday: 24, sunday: 48 };
const firstStop = new Map();
await rows('stop_times.txt', (c, h) => {
  const trip = c[h.trip_id];
  if (!tripDays.has(trip)) return;
  const seq = +c[h.stop_sequence];
  const f = firstStop.get(trip);
  if (!f || seq < f.seq) firstStop.set(trip, { seq, hour: +(c[h.departure_time] || c[h.arrival_time]).split(':')[0] % 24 });
});
const freq = shapes.map(() => new Array(72).fill(0));
for (const [trip, f] of firstStop) {
  const si = trips[trip][1];
  for (const d of tripDays.get(trip)) freq[si][dayOff[d] + f.hour]++;
}
const transit = {
  routes, stops, shapes, headsigns,
  freq: { days: DAYS, shapes: freq },
};
fs.writeFileSync(new URL('transit.json', OUT), JSON.stringify(transit));
fs.writeFileSync(new URL('trips.json', OUT), JSON.stringify(trips));
console.log(
  `routes ${routes.length}, stops ${stops.length}, shapes ${shapes.length}, trips ${Object.keys(trips).length}, ` +
    `services on sample days ${svcDays.size}, trips on sample days ${firstStop.size}`,
);
