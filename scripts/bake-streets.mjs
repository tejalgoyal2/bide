// Bakes street-name anchors for the core of Victoria into
// web/public/data/streets.json (OpenStreetMap via the Protomaps build):
//   [name, rank (0 highway .. 3 minor), x, y, angle (radians, map frame)]
// One anchor every ~300 m along each named road, none closer than 220 m to
// another anchor of the same name.
import fs from 'node:fs';
import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { CORE, toXY } from '../shared/geo.js';

const OUT = new URL('../web/public/data/streets.json', import.meta.url);
const BUILD = process.env.PMTILES || 'https://build.protomaps.com/20261031.pmtiles';
const Z = 14;
const RANK = { highway: 0, major_road: 1, medium_road: 2, minor_road: 3 };
const tileX = (lon) => Math.floor(((lon + 180) / 360) * 2 ** Z);
const tileY = (lat) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z);
};

const pm = new PMTiles(BUILD);
const tiles = [];
for (let x = tileX(CORE.west); x <= tileX(CORE.east); x++) for (let y = tileY(CORE.north); y <= tileY(CORE.south); y++) tiles.push([x, y]);
const byName = new Map();
let i = 0;
await Promise.all(Array.from({ length: 10 }, async () => {
  while (i < tiles.length) {
    const [x, y] = tiles[i++];
    const t = await pm.getZxy(Z, x, y);
    const l = t && new VectorTile(new PbfReader(new Uint8Array(t.data))).layers.roads;
    if (!l) continue;
    for (let k = 0; k < l.length; k++) {
      const f = l.feature(k), p = f.properties;
      const rank = RANK[p.kind];
      if (rank == null || !p.name || p.is_tunnel) continue;
      const g = f.toGeoJSON(x, y, Z).geometry;
      const parts = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      let e = byName.get(p.name);
      if (!e) byName.set(p.name, (e = { rank, lines: [] }));
      e.rank = Math.min(e.rank, rank);
      for (const part of parts) e.lines.push(part.map(([lo, la]) => toXY(lo, la)));
    }
  }
}));

const out = [];
for (const [name, { rank, lines }] of byName) {
  const mine = [];
  for (const pts of lines) {
    let total = 0;
    for (let j = 1; j < pts.length; j++) total += Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]);
    if (total < 60) continue;
    let along = Math.min(150, total / 2); // first anchor a little way in, or mid-block
    for (let j = 1; j < pts.length; j++) {
      const [ax, ay] = pts[j - 1], [bx, by] = pts[j];
      const seg = Math.hypot(bx - ax, by - ay);
      while (along <= seg) {
        const t = along / seg, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        if (seg > 40 && !mine.some(([mx, my]) => Math.hypot(mx - x, my - y) < 220)) {
          mine.push([x, y]);
          out.push([name, rank, Math.round(x), Math.round(y), +Math.atan2(by - ay, bx - ax).toFixed(3)]);
        }
        along += 300;
      }
      along -= seg;
    }
  }
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`${byName.size} named roads, ${out.length} anchors, ${(JSON.stringify(out).length / 1e3).toFixed(0)} kB`);
