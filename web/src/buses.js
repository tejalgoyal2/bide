// Live buses. Each report is snapped onto its route's shape, and between
// reports the bus keeps rolling at its recent speed, so it glides rather than
// jumping every fifteen seconds.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { decodeVehicles } from '../../shared/gtfsrt.js';
import { toXY } from '../../shared/geo.js';
import { shared, CORE_C, CORE_R } from './world.js';

const MAX = 400;
const OCC = ['Empty', 'Many seats', 'Few seats', 'Standing room', 'Crushed standing', 'Full', 'Not accepting passengers'];
const OCC_COLOR = ['#8fd6b6', '#76c79f', '#f3b64a', '#ec6a4c', '#c93a5a', '#8e2a63', '#8e2a63'];

export function delayColor(d) {
  if (d == null) return '#b9b0a0';
  if (d < -60) return '#6aa7e8';
  if (d < 120) return '#76c79f';
  if (d < 300) return '#f3b64a';
  if (d < 600) return '#ec6a4c';
  return '#c93a5a';
}
export const occupancyLabel = (o) => OCC[o] ?? 'Unknown';
export const occupancyColor = (o) => OCC_COLOR[o] ?? '#b9b0a0';

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

export function createBuses(scene, transit, world) {
  const routes = transit.routes.map(([id, short, name, color, text]) => ({ id, short, name, color: '#' + color, text: '#' + text }));
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
  let mode = 'route';

  // Body: a rounded capsule, lit; halo: a soft disc on the ground.
  const bodyGeo = new RoundedBoxGeometry(12, 3.3, 3.2, 3, 1.2).translate(0, 1.65, 0);
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const glow = { value: 0 };
  bodyMat.onBeforeCompile = (sh) => {
    sh.uniforms.uGlow = glow;
    sh.fragmentShader = 'uniform float uGlow;\n' + sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * uGlow;',
    );
  };
  const body = new THREE.InstancedMesh(bodyGeo, bodyMat, MAX);
  body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
  body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  body.frustumCulled = false;
  body.count = 0;
  body.renderOrder = 20;

  const haloGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const haloMat = new THREE.ShaderMaterial({
    uniforms: { uNight: shared.uNight },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vCol;
      void main() {
        vUv = uv;
        vCol = instanceColor;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      varying vec2 vUv;
      varying vec3 vCol;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float a = (1.0 - smoothstep(0.0, 1.0, r));
        a = a * a * mix(0.7, 0.95, uNight);
        gl_FragColor = vec4(vCol * mix(1.0, 1.6, uNight), a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
  const halo = new THREE.InstancedMesh(haloGeo, haloMat, MAX);
  halo.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
  halo.frustumCulled = false;
  halo.count = 0;
  halo.renderOrder = 19;
  scene.add(halo, body);

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
          ...(b || { x, y, hx: 1, hy: 0, alpha: 0, heading: 0 }),
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
    for (const [id, b] of buses) if (now - b.seen > 240) b.dying = true;
  }

  poll();
  pollDelays();
  setInterval(poll, 10000);
  setInterval(pollDelays, 30000);

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color(), haze = new THREE.Color(), tmp = {};
  const list = [];

  function colorFor(b, out) {
    if (mode === 'crowding') return out.set(occupancyColor(b.occ));
    if (mode === 'lateness') return out.set(delayColor(delays[b.tripId]));
    return out.set(routes[b.route]?.color || '#4a6fa5');
  }

  function update(dt, mpp) {
    const now = Date.now() / 1000;
    const size = Math.max(1, ((mpp > 10 ? 24 : 32) * mpp) / 12);
    glow.value = shared.uNight.value * 0.55;
    haze.copy(shared.uHaze.value);
    list.length = 0;
    let i = 0;
    for (const [id, b] of buses) {
      b.alpha += ((b.dying ? 0 : 1) - b.alpha) * (1 - Math.exp(-dt * 2));
      if (b.dying && b.alpha < 0.02) { buses.delete(id); continue; }
      if (b.shape && b.s != null && !b.offShape) {
        const ahead = Math.min(45, Math.max(0, now - b.repTs));
        const pred = Math.min(b.shape.len, b.sRep + b.v * ahead);
        if (pred < b.s - 200 || pred > b.s + 1500) b.s = pred;
        else if (pred > b.s) b.s += (pred - b.s) * (1 - Math.exp(-dt * 1.2));
        pointAt(b.shape, b.s, tmp);
        b.x = tmp.x; b.y = tmp.y;
        if (tmp.hx || tmp.hy) {
          const target = Math.atan2(tmp.hy, tmp.hx);
          let d = target - b.heading;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          b.heading += d * (1 - Math.exp(-dt * 5));
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
      const sz = size * (0.4 + 0.6 * vis);
      pos.set(b.x, gy + 0.6 * size, -b.y);
      q.setFromAxisAngle(up, b.heading);
      scl.set(sz, sz, sz);
      m4.compose(pos, q, scl);
      body.setMatrixAt(i, m4);
      colorFor(b, col).lerp(haze, fade * 0.8);
      body.setColorAt(i, col);
      pos.y = gy + 0.3 * size;
      scl.set(sz * 26, 1, sz * 26);
      m4.compose(pos, q.identity(), scl);
      halo.setMatrixAt(i, m4);
      colorFor(b, col);
      halo.setColorAt(i, col.multiplyScalar(vis));
      b.screen = pos.clone();
      list.push(b);
      i++;
    }
    body.count = halo.count = i;
    body.instanceMatrix.needsUpdate = halo.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    halo.instanceColor.needsUpdate = true;
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
