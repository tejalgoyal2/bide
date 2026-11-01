// Bakes the drawn map of Victoria from open data into web/public/data:
//   map.json     land, water, parks, roads and place names (OpenStreetMap via
//                the Protomaps daily basemap build)
//   height.png   elevation, 2.5 m per grey level (AWS Terrain Tiles)
// Everything is in the local metre frame from shared/geo.js.
import fs from 'node:fs';
import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { PNG } from 'pngjs';
import { BOUNDS, toXY, toLonLat } from '../shared/geo.js';

const OUT = new URL('../web/public/data/', import.meta.url);
const BUILD = process.env.PMTILES || 'https://build.protomaps.com/20261031.pmtiles';
const Z = 14;

const tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const tileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

// Douglas-Peucker on a flat [x, y, x, y, ...] array.
function simplify(pts, tol) {
  const n = pts.length / 2;
  if (n <= 2) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[2 * a], ay = pts[2 * a + 1], bx = pts[2 * b], by = pts[2 * b + 1];
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy || 1;
    let worst = -1, wd = t2;
    for (let i = a + 1; i < b; i++) {
      const px = pts[2 * i], py = pts[2 * i + 1];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}

// Whole metres, delta-encoded: small numbers that gzip well.
function pack(ring) {
  const out = [];
  let px = 0, py = 0;
  for (let i = 0; i < ring.length; i += 2) {
    const x = Math.round(ring[i]), y = Math.round(ring[i + 1]);
    out.push(x - px, y - py);
    px = x; py = y;
  }
  return out;
}

const flat = (coords) => coords.flatMap(([lon, lat]) => toXY(lon, lat));

const POLY_CLASS = {
  earth: 'land',
  park: 'green', garden: 'green', grass: 'green', recreation_ground: 'green', golf_course: 'green',
  cemetery: 'green', nature_reserve: 'green', playground: 'green', village_green: 'green',
  meadow: 'green', grassland: 'green', allotments: 'green', dog_park: 'green', zoo: 'green',
  pitch: 'pitch',
  wood: 'forest', forest: 'forest', protected_area: 'forest', national_park: 'forest', scrub: 'forest',
  beach: 'sand', sand: 'sand',
  commercial: 'urban', retail: 'urban', industrial: 'urban', railway: 'urban', pedestrian: 'urban',
  school: 'campus', university: 'campus', college: 'campus', hospital: 'campus',
  aerodrome: 'airport', runway: 'airport', pier: 'pier', military: 'urban',
};
// Salt water is cut out of the land so the animated sea shows through; lakes,
// ponds and rivers are painted onto the land instead.
const SEA_KINDS = new Set(['ocean', 'sea', 'bay', 'strait', 'sound', 'fjord', 'dock', 'harbour', 'lagoon']);
const waterKinds = {};

const LINE_CLASS = {
  highway: 'highway', major_road: 'major', medium_road: 'medium', minor_road: 'minor',
  path: 'path', rail: 'rail', ferry: 'ferry',
};

async function bakeVectors() {
  const pm = new PMTiles(BUILD);
  const tiles = [];
  for (let x = tileX(BOUNDS.west, Z); x <= tileX(BOUNDS.east, Z); x++) {
    for (let y = tileY(BOUNDS.north, Z); y <= tileY(BOUNDS.south, Z); y++) tiles.push([x, y]);
  }
  console.log(`fetching ${tiles.length} tiles from ${BUILD}`);

  const polys = {}, lines = {}, places = new Map();
  const addPoly = (cls, rings) => {
    const packed = rings.map((r) => pack(simplify(flat(r), cls === 'land' || cls === 'sea' || cls === 'lake' ? 2.5 : 4)));
    if (packed[0].length >= 6) (polys[cls] ||= []).push(packed);
  };

  let done = 0;
  await pool(tiles, 12, async ([x, y]) => {
    const t = await pm.getZxy(Z, x, y);
    if (++done % 50 === 0) console.log(`  ${done}/${tiles.length}`);
    if (!t) return;
    const vt = new VectorTile(new PbfReader(new Uint8Array(t.data)));
    for (const [layer, cls0] of [['earth'], ['landuse'], ['water'], ['roads'], ['places']]) {
      const l = vt.layers[layer];
      if (!l) continue;
      for (let i = 0; i < l.length; i++) {
        const f = l.feature(i);
        const p = f.properties;
        const g = f.toGeoJSON(x, y, Z).geometry;
        if (layer === 'places') {
          if (g.type !== 'Point' || !p.name) continue;
          const key = p.name;
          if (!places.has(key)) {
            const [px, py] = toXY(...g.coordinates);
            places.set(key, [p['name:en'] || p.name, p.kind, p.min_zoom ?? 99, Math.round(px), Math.round(py), p.population || 0]);
          }
          continue;
        }
        if (layer === 'roads') {
          const cls = LINE_CLASS[p.kind];
          if (!cls || p.is_tunnel) continue;
          const parts = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
          for (const part of parts) {
            const s = simplify(flat(part), 1.5);
            if (s.length >= 4) (lines[cls] ||= []).push(pack(s));
          }
          continue;
        }
        if (layer === 'water') waterKinds[`${p.kind}${p.name ? ': ' + p.name : ''}`] = 1;
        const cls = layer === 'earth' ? 'land' : layer === 'water' ? (SEA_KINDS.has(p.kind) ? 'sea' : 'lake') : POLY_CLASS[p.kind];
        if (!cls) continue;
        if (g.type === 'Polygon') addPoly(cls, g.coordinates);
        else if (g.type === 'MultiPolygon') g.coordinates.forEach((c) => addPoly(cls, c));
      }
    }
  });

  const map = { polys, lines, places: [...places.values()] };
  const text = JSON.stringify(map);
  fs.writeFileSync(new URL('map.json', OUT), text);
  for (const [k, v] of Object.entries(polys)) console.log(`  poly ${k}: ${v.length}`);
  for (const [k, v] of Object.entries(lines)) console.log(`  line ${k}: ${v.length}`);
  console.log(`  places: ${map.places.length}; map.json ${(text.length / 1e6).toFixed(1)} MB`);
  console.log('  water kinds:', Object.keys(waterKinds).sort().join(' | '));
}

// Terrarium tiles: height = R*256 + G + B/256 - 32768 metres.
async function bakeHeights() {
  const z = 12, RES = 30;
  const [x0m, y0m] = toXY(BOUNDS.west, BOUNDS.south);
  const [x1m, y1m] = toXY(BOUNDS.east, BOUNDS.north);
  const W = Math.round((x1m - x0m) / RES), H = Math.round((y1m - y0m) / RES);
  const tx0 = tileX(BOUNDS.west, z), tx1 = tileX(BOUNDS.east, z);
  const ty0 = tileY(BOUNDS.north, z), ty1 = tileY(BOUNDS.south, z);
  const tw = tx1 - tx0 + 1, th = ty1 - ty0 + 1;
  const mosaic = new Float32Array(tw * 256 * th * 256);
  const jobs = [];
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) jobs.push([tx, ty]);
  console.log(`fetching ${jobs.length} elevation tiles`);
  await pool(jobs, 8, async ([tx, ty]) => {
    const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`);
    const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        const i = (py * 256 + px) * 4;
        const h = png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
        mosaic[((ty - ty0) * 256 + py) * tw * 256 + (tx - tx0) * 256 + px] = h;
      }
    }
  });
  const n = 2 ** z * 256;
  const sample = (lon, lat) => {
    const r = (lat * Math.PI) / 180;
    const gx = ((lon + 180) / 360) * n - tx0 * 256;
    const gy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n - ty0 * 256;
    const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
    const at = (a, b) => mosaic[Math.min(th * 256 - 1, Math.max(0, b)) * tw * 256 + Math.min(tw * 256 - 1, Math.max(0, a))];
    return (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
  };
  const png = new PNG({ width: W, height: H, colorType: 0, inputColorType: 0, bitDepth: 8 });
  const gray = Buffer.alloc(W * H);
  let max = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = x0m + (i + 0.5) * RES, y = y1m - (j + 0.5) * RES;
      const h = sample(...toLonLat(x, y));
      max = Math.max(max, h);
      gray[j * W + i] = Math.max(0, Math.min(255, Math.round(h / 2.5)));
    }
  }
  png.data = gray;
  fs.writeFileSync(new URL('height.png', OUT), PNG.sync.write(png, { colorType: 0, inputColorType: 0 }));
  console.log(`  height.png ${W}x${H}, ${RES} m/px, max ${max.toFixed(0)} m`);
  return { W, H, RES };
}

fs.mkdirSync(OUT, { recursive: true });
const only = process.argv[2];
if (!only || only === 'vectors') await bakeVectors();
if (!only || only === 'heights') await bakeHeights();
