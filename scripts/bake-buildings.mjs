// Bakes building footprints for the core of Victoria into
// web/public/data/buildings.dat (OpenStreetMap via the Protomaps build), gzipped
// by hand since the host only compresses text.
// Int16 throughout, in the metre frame of shared/geo.js:
//   per building: vertex count n, height in decimetres, first x, y, then
//   n-1 deltas. Each footprint is kept by the tile that holds its centre, so
//   buildings in the tiles' overlap aren't drawn twice.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { CORE, toXY } from '../shared/geo.js';

const OUT = new URL('../web/public/data/buildings.dat', import.meta.url);
const BUILD = process.env.PMTILES || 'https://build.protomaps.com/20261031.pmtiles';
const Z = 14;
const tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const tileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

// Drop vertices closer than tol to the line through their neighbours.
function simplifyRing(r, tol) {
  const out = [];
  for (let i = 0; i < r.length; i++) {
    const a = out.length ? out[out.length - 1] : r[r.length - 1], b = r[i], c = r[(i + 1) % r.length];
    const dx = c[0] - a[0], dy = c[1] - a[1], l = Math.hypot(dx, dy) || 1;
    if (Math.abs((b[0] - a[0]) * dy - (b[1] - a[1]) * dx) / l > tol) out.push(b);
  }
  return out;
}

const pm = new PMTiles(BUILD);
const tiles = [];
for (let x = tileX(CORE.west, Z); x <= tileX(CORE.east, Z); x++) {
  for (let y = tileY(CORE.north, Z); y <= tileY(CORE.south, Z); y++) tiles.push([x, y]);
}
console.log(`fetching ${tiles.length} tiles`);
const out = [];
let n = 0, withHeight = 0, i = 0;
await Promise.all(Array.from({ length: 10 }, async () => {
  while (i < tiles.length) {
    const [x, y] = tiles[i++];
    const t = await pm.getZxy(Z, x, y);
    const l = t && new VectorTile(new PbfReader(new Uint8Array(t.data))).layers.buildings;
    if (!l) continue;
    const w = tileLon(x, Z), e = tileLon(x + 1, Z), north = tileLat(y, Z), s = tileLat(y + 1, Z);
    for (let k = 0; k < l.length; k++) {
      const f = l.feature(k);
      const g = f.toGeoJSON(x, y, Z).geometry;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) {
        const ring = poly[0].slice(0, -1);
        let cx = 0, cy = 0;
        for (const [lo, la] of ring) { cx += lo; cy += la; }
        cx /= ring.length; cy /= ring.length;
        if (cx < w || cx >= e || cy < s || cy >= north) continue;
        if (cx < CORE.west || cx > CORE.east || cy < CORE.south || cy > CORE.north) continue;
        const r = simplifyRing(ring.map(([lo, la]) => toXY(lo, la)), 0.6);
        if (r.length < 3) continue;
        let area = 0;
        for (let j = 0; j < r.length; j++) { const [a, b] = r[j], [c, d] = r[(j + 1) % r.length]; area += a * d - c * b; }
        if (Math.abs(area) / 2 < 12) continue;
        if (area < 0) r.reverse(); // counter-clockwise, so walls face out
        const p = f.properties;
        let h = +p.height || 0;
        if (h) withHeight++;
        else if (p['building:levels']) h = +p['building:levels'] * 3.2;
        else h = Math.abs(area) / 2 > 600 ? 9 : 4.5 + ((Math.abs(cx * 1e5) | 0) % 30) / 10;
        out.push(r.length, Math.min(3000, Math.round(h * 10)));
        let px = 0, py = 0;
        r.forEach(([a, b], j) => {
          const X = Math.round(a), Y = Math.round(b);
          out.push(j ? X - px : X, j ? Y - py : Y);
          px = X; py = Y;
        });
        n++;
      }
    }
  }
}));
fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(new Int16Array(out).buffer), { level: 9 }));
console.log(`${n} buildings (${withHeight} with a mapped height), ${(out.length * 2 / 1e6).toFixed(2)} MB`);
