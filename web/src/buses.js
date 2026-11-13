// Live buses. Each bus reports its position about every 17 s (measured:
// p50 17 s, p90 31 s). Rather than guessing ahead of the last report, which
// overshoots stops and then snaps back, each bus is played back along its own
// route shape toward its latest known position, paced to arrive about when
// the next report is due, with bus-like acceleration and braking. So a bus is
// shown roughly one report behind real time, but it never runs past where it
// has really been, never reverses, and never jumps. Each is a small 3D bus.
import * as THREE from 'three';
import { decodeVehicles } from '../../shared/gtfsrt.js';
import { toXY } from '../../shared/geo.js';
import { shared, CORE_C, CORE_R } from './world.js';

const MAX = 400;
const ACCEL = 1.1, BRAKE = 0.9, DECEL = 2.5, VMAX = 22; // m/s², m/s
const LIFE = 14; // a bus drawn at life size, metres (BC Transit's are 12 to 13 m)
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

// Each bus is a small 3D model: one instanced box, shaped and painted in the
// shader (body in the bus's colour, a band of windows, a pale roof, lights
// front and back after dark). Up close it is life-size; further out it keeps
// a minimum size on screen so the whole network stays readable. Under it, a
// soft shadow, a slow pulse while it waits at a stop, and a ring if selected.
const BUS_VERT = /* glsl */ `
  attribute vec4 iPos;  // ground position, length (m)
  attribute vec4 iCol;  // rgb, alpha
  attribute float iHead;
  varying vec3 vL, vN, vW;
  varying vec4 vCol;
  void main() {
    vec3 dir = vec3(cos(iHead), 0.0, -sin(iHead)), side = vec3(sin(iHead), 0.0, cos(iHead));
    float L = iPos.w;
    // Life-size proportions up close; when zoomed out the bus keeps a
    // minimum size on screen but doesn't grow taller than a low block.
    vec3 dim = vec3(L, min(L * 0.26, 3.6 + (L - 14.0) * 0.07), L * 0.3);
    vL = position;
    vec3 w = iPos.xyz + dir * position.x * dim.x + vec3(0.0, (position.y + 0.5) * dim.y, 0.0) + side * position.z * dim.z;
    vN = dir * normal.x + vec3(0.0, normal.y, 0.0) + side * normal.z;
    vW = w; vCol = iCol;
    // Depth-tested against the city, nudged a few metres toward the camera
    // so it sits on the road surface instead of sinking into it.
    vec4 mv = viewMatrix * vec4(w, 1.0);
    float d = length(mv.xyz);
    mv.xyz *= max(0.0, 1.0 - (4.0 + d * 0.006) / d);
    gl_Position = projectionMatrix * mv;
  }`;
const BUS_FRAG = /* glsl */ `
  uniform vec3 uSun, uSunColor, uAmbient;
  uniform float uNight, uGhost;
  varying vec3 vL, vN, vW;
  varying vec4 vCol;
  void main() {
    vec3 n = normalize(vN), c = vCol.rgb;
    if (uGhost > 0.5) {
      // Behind a building: a faint flat silhouette, so it isn't lost.
      gl_FragColor = vec4(mix(c, vec3(1.0), 0.25), vCol.a * 0.42);
      #include <colorspace_fragment>
      return;
    }
    vec3 an = abs(vL) * 2.0; // 1 on the faces
    bool roof = vL.y > 0.49, front = vL.x > 0.49, back = vL.x < -0.49, sideF = abs(vL.z) > 0.49;
    vec3 glass = mix(vec3(0.16, 0.2, 0.26), vec3(1.0, 0.86, 0.6), uNight * 0.85);
    if (roof) {
      // A white arrow on the roof, pointing the way the bus is going.
      vec2 p = vec2(vL.x / 0.3, vL.z);                  // in bus widths
      float head = min((1.45 - p.x) * 0.48 - abs(p.y), p.x - 0.4);
      float shaft = min(0.11 - abs(p.y), min(p.x + 1.1, 0.6 - p.x));
      float sdf = max(head, shaft);
      float aa = fwidth(sdf) * 1.2;
      float arrow = smoothstep(-aa, aa, sdf);
      c = mix(mix(c, vec3(1.0), 0.12), vec3(1.0, 0.99, 0.96), arrow * 0.95);
    }
    if (sideF) {
      float band = step(-0.02, vL.y) * step(vL.y, 0.32) * step(abs(vL.x), 0.44);
      float pillar = step(0.86, fract((vL.x + 0.5) * 8.0));
      c = mix(c, glass, band * (1.0 - pillar));
      c = mix(c, vec3(0.96, 0.94, 0.88), step(-0.12, vL.y) * step(vL.y, -0.06) * 0.8); // belt line
      if (vL.y < -0.4) c *= 0.45; // skirt
    }
    if (front) c = mix(c, glass, step(-0.12, vL.y) * step(abs(vL.z), 0.42));
    if (back) c = mix(c, glass * 0.8, step(0.0, vL.y) * step(vL.y, 0.3) * step(abs(vL.z), 0.36));
    float lambert = max(dot(n, uSun), 0.0);
    // Buses carry their own light: the paint stays readable at night.
    vec3 col = c * (0.62 + 0.38 * lambert) * mix(vec3(1.0), uSunColor, 0.25);
    col = mix(col, col * vec3(0.78, 0.8, 0.9), uNight * 0.5);
    // Head and tail lights.
    float lamp = step(abs(abs(vL.z) - 0.32), 0.1) * step(abs(vL.y + 0.26), 0.1);
    if (front) col += vec3(1.0, 0.95, 0.8) * lamp * (0.4 + uNight * 1.2);
    if (back) col += vec3(1.0, 0.18, 0.12) * lamp * (0.3 + uNight * 0.9);
    if (sideF) col += glass * 0.35 * uNight * step(-0.02, vL.y) * step(vL.y, 0.32);
    gl_FragColor = vec4(col, vCol.a);
    #include <colorspace_fragment>
  }`;
const PAD_VERT = /* glsl */ `
  attribute vec4 iPos;   // ground position, length (m)
  attribute vec4 iInfo;  // heading, ripple phase (<0 none), selected, alpha
  varying vec2 vP; varying vec4 vInfo;
  void main() {
    float h = iInfo.x;
    vec3 dir = vec3(cos(h), 0.0, -sin(h)), side = vec3(sin(h), 0.0, cos(h));
    vP = position.xz * 2.0;
    vec3 w = iPos.xyz + (dir * position.x + side * position.z) * iPos.w * 1.6;
    vInfo = iInfo;
    vec4 mv = viewMatrix * vec4(w, 1.0);
    float d = length(mv.xyz);
    mv.xyz *= max(0.0, 1.0 - (4.0 + d * 0.006) / d);
    gl_Position = projectionMatrix * mv;
  }`;
const PAD_FRAG = /* glsl */ `
  uniform float uTime, uNight;
  varying vec2 vP; varying vec4 vInfo;
  void main() {
    float e = length(vP * vec2(1.0, 2.6));
    float a = (1.0 - smoothstep(0.25, 0.75, e)) * 0.32 * (1.0 - uNight * 0.4);
    vec3 col = vec3(0.1, 0.08, 0.1);
    float r = length(vP);
    if (vInfo.y >= 0.0) {
      float t = fract(vInfo.y);
      float ring = (1.0 - smoothstep(0.0, 0.05, abs(r - (0.3 + t * 0.65)))) * (1.0 - t);
      col = mix(col, vec3(1.0, 0.97, 0.9), ring); a = max(a, ring * 0.6);
    }
    if (vInfo.z > 0.5 && vInfo.z < 1.5) {
      float ring = 1.0 - smoothstep(0.0, 0.035, abs(r - 0.82 - 0.03 * sin(uTime * 4.0)));
      col = mix(col, vec3(1.0), ring); a = max(a, ring * 0.95);
    }
    if (vInfo.z > 1.5) {
      // Bunched: a dashed amber ring that turns slowly.
      float ang = atan(vP.y, vP.x);
      float dash = step(0.5, fract(ang * 3.0 / 3.1416 + uTime * 0.3));
      float ring = (1.0 - smoothstep(0.0, 0.05, abs(r - 0.8))) * dash;
      col = mix(col, vec3(0.98, 0.66, 0.2), ring); a = max(a, ring * 0.9);
    }
    gl_FragColor = vec4(col, a * vInfo.w);
    #include <colorspace_fragment>
  }`;

export function createBuses(scene, transit, world, tagLayer) {
  const routes = transit.routes.map(([id, short, name], i) => ({ id, short, name, color: routeColor(i), text: '#fff' }));
  const routeById = new Map(routes.map((r, i) => [r.id, i]));
  const shapeCache = new Map();
  const getShape = (i) => {
    if (!shapeCache.has(i)) shapeCache.set(i, transit.shapes[i] ? unpack(transit.shapes[i]) : null);
    return shapeCache.get(i);
  };
  let trips = null;
  const tripsReady = fetch('/data/trips.json').then((r) => r.json()).then((t) => (trips = t)).catch(() => {});

  const buses = new Map();
  let delays = {};
  let feedTs = 0;
  let mode = 'lateness';

  const box = new THREE.BoxGeometry(1, 1, 1);
  const busGeo = new THREE.InstancedBufferGeometry();
  busGeo.index = box.index;
  busGeo.setAttribute('position', box.getAttribute('position'));
  busGeo.setAttribute('normal', box.getAttribute('normal'));
  busGeo.instanceCount = 0;
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const iCol = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const iHead = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
  busGeo.setAttribute('iPos', iPos);
  busGeo.setAttribute('iCol', iCol);
  busGeo.setAttribute('iHead', iHead);
  const busUniforms = { uSun: shared.uSun, uSunColor: shared.uSunColor, uAmbient: shared.uAmbient, uNight: shared.uNight };
  // Drawn twice: a faint silhouette that shows through buildings, then the
  // real bus, depth-tested so towers and hills stand in front of it.
  const ghostMat = new THREE.ShaderMaterial({
    uniforms: { ...busUniforms, uGhost: { value: 1 } },
    vertexShader: BUS_VERT,
    fragmentShader: BUS_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const busMat = new THREE.ShaderMaterial({
    uniforms: { ...busUniforms, uGhost: { value: 0 } },
    vertexShader: BUS_VERT,
    fragmentShader: BUS_FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: true,
  });
  const ghosts = new THREE.Mesh(busGeo, ghostMat);
  ghosts.frustumCulled = false;
  ghosts.renderOrder = 29;
  const models = new THREE.Mesh(busGeo, busMat);
  models.frustumCulled = false;
  models.renderOrder = 30;

  const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const padGeo = new THREE.InstancedBufferGeometry();
  padGeo.index = quad.index;
  padGeo.setAttribute('position', quad.getAttribute('position'));
  const pPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const pInfo = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
  padGeo.setAttribute('iPos', pPos);
  padGeo.setAttribute('iInfo', pInfo);
  padGeo.instanceCount = 0;
  const pads = new THREE.Mesh(padGeo, new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uNight: shared.uNight },
    vertexShader: PAD_VERT,
    fragmentShader: PAD_FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
  pads.frustumCulled = false;
  pads.renderOrder = 17;
  scene.add(pads, ghosts, models);
  let selectedBus = null;

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
  // On open, replay the last minute of reports, so buses are already moving
  // along their routes in the first frame instead of waiting for a second report.
  async function seed() {
    try {
      const res = await fetch('/api/recent');
      if (!res.ok) return;
      const buf = new Uint8Array(await res.arrayBuffer());
      const dv = new DataView(buf.buffer);
      for (let p = 0; p + 8 <= buf.length;) {
        const n = dv.getUint32(p + 4);
        const z = buf.subarray(p + 8, p + 8 + n);
        p += 8 + n;
        const raw = await new Response(new Blob([z]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        ingest(decodeVehicles(new Uint8Array(raw)), true);
      }
    } catch (e) {
      console.warn('recent feed', e);
    }
  }
  async function pollDelays() {
    try {
      const r = await fetch('/api/delays');
      if (r.ok) delays = (await r.json()).d || {};
    } catch { /* lateness view just shows grey */ }
  }

  const clock = () => performance.now() / 1000;

  // A new report for each bus becomes its next target. `seeding` replays
  // history: the bus is placed at its previous report, heading for the latest.
  function ingest(feed, seeding = false) {
    if (feed.ts <= feedTs) return;
    feedTs = feed.ts;
    const now = Date.now() / 1000, rx = clock();
    for (const v of feed.vehicles) {
      if (!v.lat) continue;
      const [x, y] = toXY(v.lon, v.lat);
      let b = buses.get(v.id);
      if (!b || b.tripId !== v.tripId) {
        const t = trips?.[v.tripId];
        const shapeIdx = t ? t[1] : -1;
        b = {
          id: v.id, tripId: v.tripId, shapeIdx,
          x: b ? b.x : x, y: b ? b.y : y, tx: x, ty: y, alpha: b ? b.alpha : 0, heading: b ? b.heading : 0,
          route: t ? t[0] : routeById.get(v.routeId) ?? -1,
          headsign: t ? transit.headsigns[t[3]] : '',
          shape: shapeIdx >= 0 ? getShape(shapeIdx) : null,
          s: null, tgt: null, lastS: null, v: 0, vReal: 6, gap: 17, lastTs: 0, rxAt: rx,
          back: 0, snap: null, hop: !!b, // a bus starting a new trip fades across
        };
        buses.set(v.id, b);
      }
      if (!b.shape && trips && trips[v.tripId]) {
        const t = trips[v.tripId];
        b.shapeIdx = t[1]; b.shape = getShape(t[1]); b.route = t[0]; b.headsign = transit.headsigns[t[3]];
      }
      b.occ = v.occ; b.status = v.status; b.seq = v.seq; b.stopId = v.stopId; b.speed = v.speed;
      b.seen = now; b.dying = false;
      if (v.ts <= b.lastTs) continue; // the same report again
      const dtRep = b.lastTs ? v.ts - b.lastTs : 0;
      if (dtRep > 0 && dtRep < 120) b.gap = b.gap * 0.7 + Math.min(45, Math.max(8, dtRep)) * 0.3;
      b.lastTs = b.vts = v.ts;
      b.rxAt = rx;
      b.rx = x; b.ry = y;
      const prevT = b.tgt;
      if (b.shape) {
        const pr = project(b.shape, x, y, b.lastS ?? b.s);
        if (pr.off > 250) { // off its route (a detour): head straight for the report
          b.offShape = true;
          if (b.hop) { b.hop = false; b.x = x; b.y = y; b.alpha = 0; }
          if (seeding) { b.x = b.tx; b.y = b.ty; }
          b.tx = x; b.ty = y;
          continue;
        }
        if (b.offShape) { b.offShape = false; b.s = b.tgt = pr.s; b.v = 0; }
        if (b.lastS != null && dtRep > 0) {
          const est = (pr.s - b.lastS) / dtRep;
          if (est > -2 && est < 30) b.vReal = b.vReal * 0.5 + Math.max(0, est) * 0.5;
        }
        b.lastS = pr.s;
        if (b.hop) { // a new trip: fade out where it is, in at the new spot
          b.hop = false;
          b.snap = b.tgt = pr.s;
          continue;
        }
        if (b.s == null) { b.s = b.tgt = pr.s; continue; } // first sighting: it fades in here
        if (pr.s > b.tgt + 3000 || dtRep > 300) { b.snap = b.tgt = pr.s; continue; }
        if (pr.s < b.tgt - 60) {
          // Reported behind where it was: GPS noise, or a loop matched to the
          // wrong pass. Hold still; only if it persists, fade across.
          if (++b.back >= 2 && pr.s < b.s - 250) { b.snap = b.tgt = pr.s; b.back = 0; }
          continue;
        }
        b.back = 0;
        b.tgt = Math.max(b.tgt, pr.s);
        if (seeding && prevT != null) { b.s = prevT; b.v = Math.min(b.vReal, VMAX); }
      } else {
        if (b.hop) { b.hop = false; b.x = x; b.y = y; b.alpha = 0; }
        if (seeding) { b.x = b.tx; b.y = b.ty; }
        b.tx = x; b.ty = y;
      }
    }
    for (const b of buses.values()) if (now - b.seen > 240) b.dying = true;
  }

  tripsReady.then(seed).then(() => {
    poll();
    setInterval(poll, 10000);
  });
  pollDelays();
  setInterval(pollDelays, 30000);

  // Ease the heading toward a direction, turning no faster than a bus could.
  function turn(b, hx, hy, dt) {
    if (!hx && !hy) return;
    const want = Math.atan2(hy, hx);
    if (!b.headingSet) { b.heading = want; b.headingSet = true; return; }
    const d = Math.atan2(Math.sin(want - b.heading), Math.cos(want - b.heading));
    b.heading += d * (1 - Math.exp(-dt * 7));
  }

  // One frame of motion along the route: pace to reach the latest report a
  // little after the next one is due, brake smoothly into it, never pass it.
  function drive(b, dt, rem) {
    const tl = Math.max(0.5, b.rxAt + b.gap * 1.35 - clock());
    let want = rem / tl;
    want = Math.min(want, VMAX, Math.sqrt(2 * BRAKE * Math.max(0, rem)), Math.max(b.vReal * 1.5, 4, rem / 25));
    const dv = want - b.v;
    b.v += dv > 0 ? Math.min(dv, ACCEL * dt) : Math.max(dv, -DECEL * dt);
    return Math.min(rem, Math.max(0, b.v * dt));
  }

  const col = new THREE.Color(), haze = new THREE.Color(), tmp = {}, tp = {};
  const v3 = new THREE.Vector3(), v4 = new THREE.Vector3();
  const list = [];

  function colorFor(b, out) {
    if (mode === 'crowding') return out.set(occupancyColor(b.occ));
    if (mode === 'lateness') return out.set(delayColor(delays[b.tripId]));
    return out.set(routes[b.route]?.color || '#7d8a99');
  }

  // Bunching: two buses on the same route pattern within 350 m of each
  // other along it, away from the ends of the line (where buses lay over).
  // Checked once a second.
  const bunched = new Map(); // bus -> the bus it's bunched with
  let pairs = [], bunchT = 0;
  function findBunches() {
    bunched.clear(); pairs = [];
    const byShape = new Map();
    for (const b of buses.values()) {
      if (b.dying || !b.shape || b.s == null || b.offShape) continue;
      if (b.s < 400 || b.s > b.shape.len - 400) continue;
      (byShape.get(b.shapeIdx) || byShape.set(b.shapeIdx, []).get(b.shapeIdx)).push(b);
    }
    for (const list of byShape.values()) {
      list.sort((a, c) => a.s - c.s);
      for (let k = 1; k < list.length; k++) {
        const a = list[k - 1], c = list[k];
        if (c.s - a.s < 350 && !bunched.has(a) && !bunched.has(c)) {
          bunched.set(a, c); bunched.set(c, a);
          pairs.push([c, a, Math.round(c.s - a.s)]); // leader, follower, gap (m)
        }
      }
    }
  }

  function update(dt, mpp, camera, dist) {
    const now = Date.now() / 1000;
    if ((bunchT += dt) > 1) { bunchT = 0; findBunches(); }
    // Smallest on-screen length of a bus, in pixels; life-size wins up close.
    // Far out, a bus keeps 18 to 26 px on screen so the network reads; closer
    // in it shrinks toward life size, so it fits its street between buildings.
    const near = THREE.MathUtils.smoothstep(dist, 700, 2600);
    const px = THREE.MathUtils.clamp(THREE.MathUtils.mapLinear(dist, 9000, 2600, 18, 26), 18, 26) * (0.7 + 0.3 * near);
    haze.copy(shared.uHaze.value);
    list.length = 0;
    let i = 0, tagN = 0;
    const showTags = dist < 3200;
    const W = innerWidth, H = innerHeight;
    const tNow = performance.now() / 1000;
    for (const [id, b] of buses) {
      b.alpha += ((b.dying || b.snap != null ? 0 : 1) - b.alpha) * (1 - Math.exp(-dt * (b.snap != null ? 5 : 2)));
      if (b.dying && b.alpha < 0.02) { buses.delete(id); continue; }
      if (b.snap != null && b.alpha < 0.04) { b.s = b.tgt = b.snap; b.snap = null; b.v = 0; b.headingSet = false; b.x = b.tx; b.y = b.ty; }
      const onShape = b.shape && b.s != null && !b.offShape && b.snap == null;
      const L = Math.max(LIFE, px * mpp) * (0.6 + 0.4 * Math.min(1, b.alpha * 1.5));
      if (onShape) {
        b.s += drive(b, dt, b.tgt - b.s);
        pointAt(b.shape, b.s, tmp);
        b.x = tmp.x; b.y = tmp.y;
        // Point the body along the road under it, front to back, so it
        // swings through corners the way a real bus does.
        const c = Math.min(10, L * 0.45);
        pointAt(b.shape, Math.max(0, b.s - c), tp);
        const ax = tp.x, ay = tp.y;
        pointAt(b.shape, Math.min(b.shape.len, b.s + c), tp);
        turn(b, tp.x - ax, tp.y - ay, dt);
      } else if (b.snap == null) {
        const dx = b.tx - b.x, dy = b.ty - b.y, rem = Math.hypot(dx, dy);
        if (rem > 2500) { b.x = b.tx; b.y = b.ty; b.v = 0; }
        else if (rem > 0.01) {
          const step = drive(b, dt, rem);
          b.x += (dx / rem) * step; b.y += (dy / rem) * step;
          if (rem > 3) turn(b, dx, dy, dt);
        }
      }
      // Buses heading out to Langford or Sidney dissolve into the haze.
      const r = Math.hypot((b.x - CORE_C.x) / CORE_R.x, (-b.y - CORE_C.y) / CORE_R.y);
      const fade = THREE.MathUtils.smoothstep(r, 0.95, 2.0);
      const vis = b.alpha * (1 - fade);
      if (vis < 0.03 || i >= MAX) continue;
      const gy = world.surfaceY(b.x, b.y);
      colorFor(b, col).lerp(haze, fade * 0.8);
      // Waiting at a stop: it has caught up with a report that says so.
      const stopped = b.v < 0.4 && (b.status === 1 || b.speed === 0) && (!onShape || b.tgt - b.s < 4);
      iPos.setXYZW(i, b.x, gy + 0.5, -b.y, L); // on the road; the shader's depth nudge keeps it above the terrain mesh
      iCol.setXYZW(i, col.r, col.g, col.b, vis);
      iHead.setX(i, b.heading);
      pPos.setXYZW(i, b.x, gy + 0.6, -b.y, L);
      pInfo.setXYZW(i, b.heading, stopped ? tNow / 2.4 + (b.id.length % 7) * 0.13 : -1, b === selectedBus ? 1 : bunched.has(b) ? 2 : 0, vis);
      v3.set(b.x, gy + Math.min(L * 0.26, 3.6 + (L - LIFE) * 0.07) + 2, -b.y).project(camera);
      (b.screen ||= new THREE.Vector3()).set(b.x, gy, -b.y);
      if (showTags && tagN < 120) {
        if (v3.z < 1 && Math.abs(v3.x) < 1.05 && Math.abs(v3.y) < 1.05) {
          const t = tagFor(tagN++);
          const text = routes[b.route]?.short ?? '';
          if (t.text !== text) { t.el.textContent = text; t.text = text; }
          t.el.style.transform = `translate(${((v3.x + 1) / 2) * W}px, ${((1 - v3.y) / 2) * H}px) translate(-50%, -100%)`;
          t.el.style.opacity = vis * (1 - THREE.MathUtils.smoothstep(dist, 2400, 3200));
          const bg = routes[b.route]?.color || '#7d8a99';
          if (t.color !== bg) { t.el.style.background = bg; t.color = bg; }
          t.shown = true;
        }
      }
      list.push(b);
      i++;
    }
    for (let k = tagN; k < tags.length; k++) if (tags[k].shown) { tags[k].el.style.opacity = 0; tags[k].shown = false; }
    busGeo.instanceCount = padGeo.instanceCount = i;
    iPos.needsUpdate = iCol.needsUpdate = iHead.needsUpdate = pPos.needsUpdate = pInfo.needsUpdate = true;
  }

  return {
    update,
    list,
    routes,
    setMode: (m) => (mode = m),
    setSelected: (b) => (selectedBus = b),
    get bunches() { return pairs; },
    bunchedWith: (b) => bunched.get(b),
    get mode() { return mode; },
    delayOf: (b) => delays[b.tripId],
    // [route index, shape index, direction, headsign index] for a trip id.
    tripInfo: (id) => trips?.[id],
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
