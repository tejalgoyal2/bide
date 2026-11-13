// Live buses. Each report is snapped onto its route's shape, and between
// reports the bus keeps rolling at its recent speed, so it glides rather than
// jumping every fifteen seconds. Each is drawn as a small 3D bus.
import * as THREE from 'three';
import { decodeVehicles } from '../../shared/gtfsrt.js';
import { toXY } from '../../shared/geo.js';
import { shared, CORE_C, CORE_R } from './world.js';

const MAX = 400;
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
    vec3 dim = vec3(L, L * 0.26, L * 0.3); // a touch broader than life, so the roof arrow reads
    vL = position;
    vec3 w = iPos.xyz + dir * position.x * dim.x + vec3(0.0, (position.y + 0.5) * dim.y, 0.0) + side * position.z * dim.z;
    vN = dir * normal.x + vec3(0.0, normal.y, 0.0) + side * normal.z;
    vW = w; vCol = iCol;
    gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  }`;
const BUS_FRAG = /* glsl */ `
  uniform vec3 uSun, uSunColor, uAmbient;
  uniform float uNight;
  varying vec3 vL, vN, vW;
  varying vec4 vCol;
  void main() {
    vec3 n = normalize(vN), c = vCol.rgb;
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
    gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
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
  fetch('/data/trips.json').then((r) => r.json()).then((t) => (trips = t));

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
  const busMat = new THREE.ShaderMaterial({
    uniforms: { uSun: shared.uSun, uSunColor: shared.uSunColor, uAmbient: shared.uAmbient, uNight: shared.uNight },
    vertexShader: BUS_VERT,
    fragmentShader: BUS_FRAG,
    transparent: true,
    // Buses are the point of the map: always drawn, never lost behind a
    // hill or a tower. Each box still shades itself correctly.
    depthTest: false,
    depthWrite: false,
  });
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
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
  pads.frustumCulled = false;
  pads.renderOrder = 17;
  scene.add(pads, models);
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
    const px = THREE.MathUtils.clamp(THREE.MathUtils.mapLinear(dist, 9000, 1200, 18, 40), 18, 40);
    haze.copy(shared.uHaze.value);
    list.length = 0;
    let i = 0, tagN = 0;
    const showTags = dist < 3200;
    const W = innerWidth, H = innerHeight;
    const tNow = performance.now() / 1000;
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
      colorFor(b, col).lerp(haze, fade * 0.8);
      const L = Math.max(12, px * mpp) * (0.6 + 0.4 * vis);
      const stopped = b.status === 1 || (b.speed === 0 && b.v < 0.5);
      iPos.setXYZW(i, b.x, gy + 3 + L * 0.05, -b.y, L); // the drawn terrain sits a little above the sampled height
      iCol.setXYZW(i, col.r, col.g, col.b, vis);
      iHead.setX(i, b.heading);
      pPos.setXYZW(i, b.x, gy + 0.6, -b.y, L);
      pInfo.setXYZW(i, b.heading, stopped ? tNow / 2.4 + (b.id.length % 7) * 0.13 : -1, b === selectedBus ? 1 : bunched.has(b) ? 2 : 0, vis);
      v3.set(b.x, gy + L * 0.45, -b.y).project(camera);

      b.screen = new THREE.Vector3(b.x, gy, -b.y);
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
