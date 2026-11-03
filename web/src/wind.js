// Live wind: Open-Meteo's current wind at a 5 x 4 grid of points over the
// region (one keyless call), interpolated, and drawn as pale wisps that
// meander on it. Their pace and brightness follow the local wind speed, so
// the lee of the hills and the open strait read differently.
import * as THREE from 'three';
import { BOUNDS, toXY } from '../../shared/geo.js';
import { shared } from './world.js';

const NX = 5, NY = 4, N = 240, TR = 40;

export function createWind(scene, surfaceY, onChange) {
  // Grid in metres: u (east) and v (north) wind components, m/s.
  const [x0, y0] = toXY(BOUNDS.west, BOUNDS.south), [x1, y1] = toXY(BOUNDS.east, BOUNDS.north);
  const U = new Float32Array(NX * NY), V = new Float32Array(NX * NY);
  let ready = false;

  async function load() {
    const lats = [], lons = [];
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      lats.push((BOUNDS.south + ((BOUNDS.north - BOUNDS.south) * j) / (NY - 1)).toFixed(3));
      lons.push((BOUNDS.west + ((BOUNDS.east - BOUNDS.west) * i) / (NX - 1)).toFixed(3));
    }
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=ms`);
      const list = await r.json();
      let max = 0, gust = 0;
      list.forEach((p, k) => {
        const s = p.current.wind_speed_10m, d = (p.current.wind_direction_10m * Math.PI) / 180;
        // Direction is where the wind comes from.
        U[k] = -Math.sin(d) * s; V[k] = -Math.cos(d) * s;
        max = Math.max(max, s); gust = Math.max(gust, p.current.wind_gusts_10m);
      });
      ready = true;
      onChange?.({ max, gust });
    } catch { /* keep the last field */ }
  }
  load();
  setInterval(load, 15 * 60e3);

  const at = (x, y, out) => {
    const fx = THREE.MathUtils.clamp(((x - x0) / (x1 - x0)) * (NX - 1), 0, NX - 1.001);
    const fy = THREE.MathUtils.clamp(((y - y0) / (y1 - y0)) * (NY - 1), 0, NY - 1.001);
    const i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
    const k = j * NX + i;
    const mix = (A) => (A[k] * (1 - a) + A[k + 1] * a) * (1 - b) + (A[k + NX] * (1 - a) + A[k + NX + 1] * a) * b;
    out[0] = mix(U); out[1] = mix(V);
    return out;
  };

  // Wisps: long, thin trails that meander on the wind with a little
  // turbulence, like smoke from a match. Each is a ribbon through its last
  // few dozen positions, bright at the head and fading to nothing.
  const pos = new Float32Array(N * TR * 2 * 3), fade = new Float32Array(N * TR * 2);
  const idx = [];
  for (let p = 0; p < N; p++) for (let k = 0; k < TR - 1; k++) {
    const o = (p * TR + k) * 2;
    idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('fade', new THREE.BufferAttribute(fade, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uNight: shared.uNight, uFade: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float fade;
      varying float vF;
      void main() { vF = fade; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uNight, uFade;
      varying float vF;
      void main() {
        vec3 c = mix(vec3(1.0, 0.99, 0.96), vec3(0.75, 0.84, 1.0), uNight);
        gl_FragColor = vec4(c, vF * uFade * mix(0.7, 0.6, uNight));
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 28;
  scene.add(mesh);

  // Gentle turbulence: the curl of a slowly drifting sine field.
  const curl = (x, y, t) => {
    const k = 1 / 900;
    return [
      Math.cos(y * k * 1.3 + t * 0.05) + 0.6 * Math.cos(y * k * 2.9 - x * k * 0.7),
      -Math.cos(x * k * 1.1 - t * 0.04) - 0.6 * Math.cos(x * k * 2.3 + y * k * 0.9),
    ];
  };
  const P = Array.from({ length: N }, () => ({ trail: [], age: 0, life: 0, x: 0, y: 0 }));
  const w = [0, 0];
  let enabled = true, alpha = 0, clock = 0, tick = 0;
  const seed = (p, cx, cy, R) => {
    p.x = cx + (Math.random() - 0.5) * 2 * R;
    p.y = cy + (Math.random() - 0.5) * 2 * R;
    p.age = 0; p.life = 6 + Math.random() * 6;
    p.trail.length = 0;
  };

  function update(dt, target, dist, mpp) {
    alpha += ((enabled && ready ? 1 : 0) - alpha) * Math.min(1, dt * 1.5);
    mat.uniforms.uFade.value = alpha * THREE.MathUtils.clamp(1.3 - dist / 18000, 0.45, 1);
    mesh.visible = alpha > 0.01;
    if (!mesh.visible) return;
    clock += dt;
    const cx = target.x, cy = -target.z, R = dist * 0.85;
    const pace = mpp * 7;           // a steady drift on screen at any zoom
    const half = mpp * 1.3;         // ribbon half-width: under 3 px
    const record = (tick += dt) > 1 / 12;
    if (record) tick = 0;
    for (let k = 0; k < N; k++) {
      const p = P[k];
      p.age += dt;
      if (p.age > p.life || Math.abs(p.x - cx) > R * 1.25 || Math.abs(p.y - cy) > R * 1.25) seed(p, cx, cy, R);
      at(p.x, p.y, w);
      const sp = Math.hypot(w[0], w[1]);
      const c = curl(p.x, p.y, clock);
      const turb = 0.35 + sp * 0.06;
      p.x += (w[0] + c[0] * turb) * pace * dt;
      p.y += (w[1] + c[1] * turb) * pace * dt;
      if (record || !p.trail.length) {
        p.trail.unshift(p.x, p.y);
        if (p.trail.length > TR * 2) p.trail.length = TR * 2;
      } else { p.trail[0] = p.x; p.trail[1] = p.y; }
      const life = Math.min(1, p.age / 1.2, (p.life - p.age) / 1.2) * Math.min(1, 0.35 + sp / 5);
      const n = p.trail.length / 2;
      for (let j = 0; j < TR; j++) {
        const jj = Math.min(j, n - 1);
        const x = p.trail[jj * 2], y = p.trail[jj * 2 + 1];
        const x2 = p.trail[Math.min(jj + 1, n - 1) * 2], y2 = p.trail[Math.min(jj + 1, n - 1) * 2 + 1];
        let dx = x - x2, dy = y - y2;
        const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
        const z = surfaceY(x, y) + 20, f = j < n ? (1 - j / (TR - 1)) ** 1.4 * life : 0;
        const o = (k * TR + j) * 2;
        const hw = half * (0.4 + 0.6 * (1 - j / TR));
        pos[o * 3] = x - dy * hw; pos[o * 3 + 1] = z; pos[o * 3 + 2] = -(y + dx * hw);
        pos[o * 3 + 3] = x + dy * hw; pos[o * 3 + 4] = z; pos[o * 3 + 5] = -(y - dx * hw);
        fade[o] = fade[o + 1] = f;
      }
    }
    geo.attributes.position.needsUpdate = geo.attributes.fade.needsUpdate = true;
  }

  return { update, setEnabled: (on) => (enabled = on) };
}
