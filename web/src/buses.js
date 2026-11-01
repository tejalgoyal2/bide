// Live buses. Each report is snapped onto its route's shape, and between
// reports the bus keeps rolling at its recent speed, so it glides rather than
// jumping every fifteen seconds. A bus is drawn as a pointed marker with a
// short trail along the road it just travelled, so its direction reads at a
// glance.
import * as THREE from 'three';
import { decodeVehicles } from '../../shared/gtfsrt.js';
import { toXY } from '../../shared/geo.js';
import { shared, CORE_C, CORE_R } from './world.js';

const MAX = 400;
const TRAIL_PTS = 16;
const OCC = ['Empty', 'Many seats', 'Few seats', 'Standing room', 'Crushed standing', 'Full', 'Not accepting passengers'];
const OCC_COLOR = ['#3f9b8f', '#3f9b8f', '#e2a03f', '#d9643f', '#9c3d6b', '#9c3d6b', '#9c3d6b'];

export function delayColor(d) {
  if (d == null) return '#a59c90';
  if (d < -60) return '#4f86c6';
  if (d < 120) return '#3f9b8f';
  if (d < 300) return '#e2a03f';
  if (d < 600) return '#d9643f';
  return '#9c3d6b';
}
export const occupancyLabel = (o) => OCC[o] ?? 'Unknown';
export const occupancyColor = (o) => OCC_COLOR[o] ?? '#a59c90';

// Route colours spread around the hue wheel at an even, map-friendly
// lightness, so no route shouts louder than another.
const routeCol = new THREE.Color();
export function routeColor(i) {
  if (i == null || i < 0) return '#7d8a99';
  return '#' + routeCol.setHSL(((i * 137.508) % 360) / 360, 0.5, 0.44).getHexString();
}

function unpack(d) {
  const n = d.length / 2;
  const xy = new Float32Array(d.length), cum = new Float32Array(n);
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) {
    x += d[2 * i]; y += d[2 * i + 1];
    xy[2 * i] = x; xy[2 * i + 1] = y;
    if (i) cum[i] = cum[i - 1] + Math.hypot(x - xy[2 * i - 2], y - xy[2 * i - 1]);
  }
  return { xy, cum, len: cum[n - 1] || 0 };
}

// Distance along the shape of the closest point to (px, py). Near-ties go to
// the candidate closest to `hint`, so loops and out-and-back routes don't flip.
function project(shape, px, py, hint) {
  const { xy, cum } = shape;
  let best = Infinity, bestS = 0;
  for (let i = 0; i < cum.length - 1; i++) {
    const ax = xy[2 * i], ay = xy[2 * i + 1], bx = xy[2 * i + 2], by = xy[2 * i + 3];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
    const ex = ax + dx * t - px, ey = ay + dy * t - py;
    const s = cum[i] + t * Math.sqrt(l2);
    const score = Math.sqrt(ex * ex + ey * ey) + (hint == null ? 0 : Math.abs(s - hint) * 0.02);
    if (score < best) { best = score; bestS = s; }
  }
  return { s: bestS, off: best };
}

function pointAt(shape, s, out) {
  const { xy, cum } = shape;
  s = Math.max(0, Math.min(shape.len, s));
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= s) lo = m; else hi = m;
  }
  const t = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
  out.x = xy[2 * lo] + (xy[2 * hi] - xy[2 * lo]) * t;
  out.y = xy[2 * lo + 1] + (xy[2 * hi + 1] - xy[2 * lo + 1]) * t;
  out.hx = xy[2 * hi] - xy[2 * lo];
  out.hy = xy[2 * hi + 1] - xy[2 * lo + 1];
  return out;
}

// A disc with a pointer on its rim in the direction of travel: one unit
// across, pointer toward +x.
function markerGeometry() {
  const s = new THREE.Shape();
  const r = 0.5, a0 = 0.62;
  s.moveTo(0.78, 0);
  s.lineTo(r * Math.cos(a0), r * Math.sin(a0));
  s.absarc(0, 0, r, a0, Math.PI * 2 - a0, false);
  s.lineTo(0.78, 0);
  return new THREE.ExtrudeGeometry(s, { depth: 0.08, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.02, bevelSegments: 2, curveSegments: 24 })
    .rotateX(-Math.PI / 2);
}

export function createBuses(scene, transit, world, tagLayer) {
  const routes = transit.routes.map(([id, short, name], i) => ({ id, short, name, color: routeColor(i), text: '#fff' }));
  const routeById = new Map(routes.map((r, i) => [r.id, i]));
  const shapeCache = new Map();
  const getShape = (i) => {
    if (!shapeCache.has(i)) shapeCache.set(i, transit.shapes[i] ? unpack(transit.shapes[i]) : null);
    return shapeCache.get(i);
  };
  let trips = null;
  fetch('/data/trips.json').then((r) => r.json()).then((t) => (trips = t));

  const buses = new Map();
  let delays = {};
  let feedTs = 0;
  let mode = 'lateness';

  // Flat colour, like ink on the map: no lighting, no glow.
  const flatMat = (color) => new THREE.MeshBasicMaterial({ color });
  const geo = markerGeometry();
  const body = new THREE.InstancedMesh(geo, flatMat(0xffffff), MAX);
  body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
  const rim = new THREE.InstancedMesh(geo, flatMat(0xfbf6ea), MAX);
  for (const m of [body, rim]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.count = 0;
  }
  rim.renderOrder = 20;
  body.renderOrder = 21;

  // A soft contact shadow under each marker.
  const shadowMat = new THREE.ShaderMaterial({
    uniforms: { uNight: shared.uNight },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      varying vec2 vUv;
      void main() {
        vec2 d = (vUv - 0.5) * vec2(2.0, 2.0);
        float a = 1.0 - smoothstep(0.2, 1.0, length(d));
        gl_FragColor = vec4(0.12, 0.09, 0.07, a * mix(0.28, 0.4, uNight));
      }`,
    transparent: true,
    depthWrite: false,
  });
  const shadow = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), shadowMat, MAX);
  shadow.frustumCulled = false;
  shadow.count = 0;
  shadow.renderOrder = 18;

  // Trails: one tapered ribbon per bus, rebuilt every frame.
  const tPos = new Float32Array(MAX * TRAIL_PTS * 2 * 3);
  const tCol = new Float32Array(MAX * TRAIL_PTS * 2 * 4);
  const tIdx = [];
  for (let b = 0; b < MAX; b++) {
    for (let i = 0; i < TRAIL_PTS - 1; i++) {
      const a = (b * TRAIL_PTS + i) * 2;
      tIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const tGeo = new THREE.BufferGeometry();
  tGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3).setUsage(THREE.DynamicDrawUsage));
  tGeo.setAttribute('color', new THREE.BufferAttribute(tCol, 4).setUsage(THREE.DynamicDrawUsage));
  tGeo.setIndex(tIdx);
  const trail = new THREE.Mesh(
    tGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  trail.frustumCulled = false;
  trail.renderOrder = 17;
  scene.add(shadow, trail, rim, body);

  // Route-number tags, shown when close enough to read them.
  const tags = [];
  const tagFor = (i) => {
    while (tags.length <= i) {
      const el = document.createElement('div');
      el.className = 'bus-tag';
      tagLayer.appendChild(el);
      tags.push({ el, text: '', color: '', shown: false });
    }
    return tags[i];
  };

  async function poll() {
    try {
      const res = await fetch('/api/live', { cache: 'no-store' });
      if (res.ok) ingest(decodeVehicles(new Uint8Array(await res.arrayBuffer())));
    } catch (e) {
      console.warn('live feed', e);
    }
  }
  async function pollDelays() {
    try {
      const r = await fetch('/api/delays');
      if (r.ok) delays = (await r.json()).d || {};
    } catch { /* lateness view just shows grey */ }
  }

  function ingest(feed) {
    if (feed.ts === feedTs) return;
    feedTs = feed.ts;
    const now = Date.now() / 1000;
    for (const v of feed.vehicles) {
      if (!v.lat) continue;
      const [x, y] = toXY(v.lon, v.lat);
      let b = buses.get(v.id);
      if (!b || b.tripId !== v.tripId) {
        const t = trips?.[v.tripId];
        const shapeIdx = t ? t[1] : -1;
        b = {
          ...(b || { x, y, alpha: 0, heading: 0 }),
          id: v.id, tripId: v.tripId, shapeIdx,
          route: t ? t[0] : routeById.get(v.routeId) ?? -1,
          headsign: t ? transit.headsigns[t[3]] : '',
          shape: shapeIdx >= 0 ? getShape(shapeIdx) : null,
          s: null, sRep: null, v: 0, repTs: 0,
        };
        buses.set(v.id, b);
      }
      if (!b.shape && trips && trips[v.tripId]) {
        const t = trips[v.tripId];
        b.shapeIdx = t[1]; b.shape = getShape(t[1]); b.route = t[0]; b.headsign = transit.headsigns[t[3]];
      }
      b.occ = v.occ; b.status = v.status; b.seq = v.seq; b.stopId = v.stopId; b.speed = v.speed;
      b.seen = now; b.vts = v.ts; b.rx = x; b.ry = y;
      b.dying = false;
      if (b.shape) {
        const pr = project(b.shape, x, y, b.sRep);
        if (pr.off > 250) { b.offShape = true; continue; }
        b.offShape = false;
        if (b.sRep != null && v.ts > b.repTs) {
          const est = (pr.s - b.sRep) / (v.ts - b.repTs);
          if (est >= 0 && est < 30) b.v = b.v * 0.4 + est * 0.6;
        }
        if (v.speed === 0 || v.status === 1) b.v *= 0.25;
        b.sRep = pr.s;
        b.repTs = v.ts;
        if (b.s == null) b.s = pr.s;
      }
    }
    for (const b of buses.values()) if (now - b.seen > 240) b.dying = true;
  }

  poll();
  pollDelays();
  setInterval(poll, 10000);
  setInterval(pollDelays, 30000);

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color(), haze = new THREE.Color(), cream = new THREE.Color('#fbf6ea'), tmp = {}, tp = {};
  const v3 = new THREE.Vector3();
  const list = [];

  function colorFor(b, out) {
    if (mode === 'crowding') return out.set(occupancyColor(b.occ));
    if (mode === 'lateness') return out.set(delayColor(delays[b.tripId]));
    return out.set(routes[b.route]?.color || '#7d8a99');
  }

  function update(dt, mpp, camera, dist) {
    const now = Date.now() / 1000;
    const len = Math.max(18, (mpp > 12 ? 15 : 21) * mpp);
    const night = shared.uNight.value;
    haze.copy(shared.uHaze.value);
    rim.material.color.copy(cream).multiplyScalar(1 - night * 0.35);
    list.length = 0;
    let i = 0, tagN = 0;
    const showTags = dist < 6000;
    const W = innerWidth, H = innerHeight;
    for (const [id, b] of buses) {
      b.alpha += ((b.dying ? 0 : 1) - b.alpha) * (1 - Math.exp(-dt * 2));
      if (b.dying && b.alpha < 0.02) { buses.delete(id); continue; }
      const onShape = b.shape && b.s != null && !b.offShape;
      if (onShape) {
        const ahead = Math.min(45, Math.max(0, now - b.repTs));
        const pred = Math.min(b.shape.len, b.sRep + b.v * ahead);
        if (pred < b.s - 200 || pred > b.s + 1500) b.s = pred;
        else if (pred > b.s) b.s += (pred - b.s) * (1 - Math.exp(-dt * 1.2));
        // Head along the road a little ahead, so corners are taken smoothly.
        pointAt(b.shape, b.s, tmp);
        b.x = tmp.x; b.y = tmp.y;
        pointAt(b.shape, Math.min(b.shape.len, b.s + 12), tp);
        const hx = tp.x - b.x, hy = tp.y - b.y;
        if (hx || hy) {
          let d = Math.atan2(hy, hx) - b.heading;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          b.heading += d * (1 - Math.exp(-dt * 6));
        }
      } else {
        b.x += (b.rx - b.x) * (1 - Math.exp(-dt * 1.5));
        b.y += (b.ry - b.y) * (1 - Math.exp(-dt * 1.5));
      }
      // Buses heading out to Langford or Sidney dissolve into the haze.
      const r = Math.hypot((b.x - CORE_C.x) / CORE_R.x, (-b.y - CORE_C.y) / CORE_R.y);
      const fade = THREE.MathUtils.smoothstep(r, 0.95, 2.0);
      const vis = b.alpha * (1 - fade);
      if (vis < 0.03 || i >= MAX) continue;
      const gy = world.surfaceY(b.x, b.y);
      const sz = len * (0.5 + 0.5 * vis);
      q.setFromAxisAngle(up, b.heading);

      pos.set(b.x, gy + 0.08 * sz, -b.y);
      scl.set(sz, sz, sz);
      m4.compose(pos, q, scl);
      body.setMatrixAt(i, m4);
      colorFor(b, col).lerp(haze, fade * 0.8);
      body.setColorAt(i, col);
      pos.y = gy + 0.02 * sz;
      scl.set(sz * 1.2, sz * 0.9, sz * 1.2);
      m4.compose(pos, q, scl);
      rim.setMatrixAt(i, m4);
      pos.set(b.x + sz * 0.08, gy + 0.01, -b.y + sz * 0.08);
      scl.set(sz * 1.5, 1, sz * 1.5);
      m4.compose(pos, q, scl);
      shadow.setMatrixAt(i, m4);

      // Trail: back along the shape, tapering and fading.
      const base = i * TRAIL_PTS * 2;
      const tl = Math.min(900, Math.max(60, sz * 5)) * Math.min(1, 0.3 + b.v / 6);
      const halfW = sz * 0.2;
      for (let k = 0; k < TRAIL_PTS; k++) {
        const f = k / (TRAIL_PTS - 1);
        let x = b.x, y = b.y, nx = 0, ny = 0;
        if (onShape) {
          pointAt(b.shape, Math.max(0, b.s - sz * 0.3 - f * tl), tp);
          x = tp.x; y = tp.y;
          const l = Math.hypot(tp.hx, tp.hy) || 1;
          nx = -tp.hy / l; ny = tp.hx / l;
        }
        const w = halfW * (1 - f * 0.85);
        const z = world.surfaceY(x, y) + 0.04 * sz;
        const a = onShape ? (1 - f) ** 1.6 * 0.75 * vis : 0;
        for (let side = 0; side < 2; side++) {
          const sgn = side ? 1 : -1, o = (base + k * 2 + side);
          tPos[o * 3] = x + nx * w * sgn;
          tPos[o * 3 + 1] = z;
          tPos[o * 3 + 2] = -(y + ny * w * sgn);
          tCol[o * 4] = col.r; tCol[o * 4 + 1] = col.g; tCol[o * 4 + 2] = col.b; tCol[o * 4 + 3] = a;
        }
      }

      b.screen = v3.set(b.x, gy, -b.y).clone();
      if (showTags && tagN < 120) {
        v3.project(camera);
        if (v3.z < 1 && Math.abs(v3.x) < 1.05 && Math.abs(v3.y) < 1.05) {
          const t = tagFor(tagN++);
          const text = routes[b.route]?.short ?? '';
          if (t.text !== text) { t.el.textContent = text; t.text = text; }
          t.el.style.transform = `translate(${((v3.x + 1) / 2) * W}px, ${((1 - v3.y) / 2) * H}px) translate(-50%, -50%)`;
          t.el.style.opacity = vis * THREE.MathUtils.smoothstep(6000 - dist, 0, 1500);
          t.shown = true;
        }
      }
      list.push(b);
      i++;
    }
    for (let k = tagN; k < tags.length; k++) if (tags[k].shown) { tags[k].el.style.opacity = 0; tags[k].shown = false; }
    // Clear trails of unused slots.
    tCol.fill(0, i * TRAIL_PTS * 2 * 4);
    body.count = rim.count = shadow.count = i;
    tGeo.setDrawRange(0, i * (TRAIL_PTS - 1) * 6);
    for (const m of [body, rim, shadow]) m.instanceMatrix.needsUpdate = true;
    body.instanceColor.needsUpdate = true;
    tGeo.attributes.position.needsUpdate = tGeo.attributes.color.needsUpdate = true;
  }

  return {
    update,
    list,
    routes,
    setMode: (m) => (mode = m),
    get mode() { return mode; },
    delayOf: (b) => delays[b.tripId],
    get feedTs() { return feedTs; },
    stats() {
      let n = 0, standing = 0, late = 0, withDelay = 0, sum = 0;
      for (const b of buses.values()) {
        if (b.dying) continue;
        n++;
        if (b.occ >= 3) standing++;
        const d = delays[b.tripId];
        if (d != null) { withDelay++; sum += d; if (d >= 180) late++; }
      }
      return { n, standing, late, withDelay, avgDelay: withDelay ? sum / withDelay : null };
    },
  };
}
