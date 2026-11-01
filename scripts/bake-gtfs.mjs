// Bakes BC Transit's Victoria schedule (GTFS) into web/public/data:
//   transit.json  routes, route shapes, stops, and scheduled departures per
//                 hour in hexagonal cells (the "activity" bars)
//   trips.json    trip id -> route, shape, direction, headsign
// Usage: node scripts/bake-gtfs.mjs [gtfs-dir]
// Without a directory it downloads the current feed into .cache/gtfs.
import fs from 'node:fs';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { toXY } from '../shared/geo.js';

const OUT = new URL('../web/public/data/', import.meta.url);
const URL_GTFS = 'https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=48';
export const HEX = 280; // hex radius in metres

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

// Pointy-top axial hex coordinates for a point.
export function hexOf(x, y, s = HEX) {
  const q = ((Math.sqrt(3) / 3) * x - y / 3) / s;
  const r = ((2 / 3) * y) / s;
  let rx = Math.round(q), ry = Math.round(r), rz = Math.round(-q - r);
  const dx = Math.abs(rx - q), dy = Math.abs(ry - r), dz = Math.abs(rz + q + r);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  return [rx, ry];
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

// Scheduled departures per hex per hour, for each sample day.
const cells = new Map();
const dayOff = { weekday: 0, saturday: 24, sunday: 48 };
let counted = 0;
await rows('stop_times.txt', (c, h) => {
  const days = tripDays.get(c[h.trip_id]);
  if (!days) return;
  const s = stops[stopIdx.get(c[h.stop_id])];
  if (!s) return;
  const hour = +(c[h.departure_time] || c[h.arrival_time]).split(':')[0] % 24;
  const [q, r] = hexOf(s[2], s[3]);
  const key = `${q},${r}`;
  if (!cells.has(key)) cells.set(key, [q, r, ...new Array(72).fill(0)]);
  const cell = cells.get(key);
  for (const d of days) cell[2 + dayOff[d] + hour]++;
  counted++;
});

const transit = {
  routes, stops, shapes, headsigns,
  activity: { hex: HEX, days: DAYS, cells: [...cells.values()] },
};
fs.writeFileSync(new URL('transit.json', OUT), JSON.stringify(transit));
fs.writeFileSync(new URL('trips.json', OUT), JSON.stringify(trips));
console.log(
  `routes ${routes.length}, stops ${stops.length}, shapes ${shapes.length}, trips ${Object.keys(trips).length}, ` +
    `services on sample days ${svcDays.size}, departures counted ${counted}, hex cells ${cells.size}`,
);
