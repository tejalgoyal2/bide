// Live wind: Open-Meteo's current wind at a 5 x 4 grid of points over the
// region (one keyless call), interpolated, and drawn as pale streaks that
// drift with it. Each streak's length and pace follow the local wind speed,
// so the lee of the hills and the open strait read differently.
import * as THREE from 'three';
import { BOUNDS, toXY } from '../../shared/geo.js';
import { shared } from './world.js';

const NX = 5, NY = 4, N = 900;

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

  // Streaks: instanced quads laid along the wind, a bright head and a long tail.
  const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  geo.instanceCount = N;
  const iPos = new Float32Array(N * 4), iDir = new Float32Array(N * 4);
  geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('iDir', new THREE.InstancedBufferAttribute(iDir, 4).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uNight: shared.uNight, uFade: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute vec4 iPos;  // position, width (m)
      attribute vec4 iDir;  // unit direction, length (m), alpha
      varying vec2 vQ; varying float vA;
      void main() {
        vec2 d = iDir.xy, n = vec2(-d.y, d.x);
        float w = iPos.w;
        vec2 o = d * position.z * -iDir.z + n * position.x * w;
        vQ = vec2(position.x * 2.0, 0.5 - position.z); vA = iDir.w;
        gl_Position = projectionMatrix * viewMatrix * vec4(iPos.x + o.x, iPos.y, iPos.z - o.y, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight, uFade;
      varying vec2 vQ; varying float vA;
      void main() {
        float tail = pow(vQ.y, 1.3);           // 1 at the head, 0 at the tail
        float a = tail * smoothstep(1.0, 0.3, abs(vQ.x)) * vA * uFade;
        vec3 c = mix(vec3(1.0, 0.99, 0.95), vec3(0.7, 0.8, 1.0), uNight);
        gl_FragColor = vec4(c, a * mix(0.85, 0.75, uNight));
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

  const P = Array.from({ length: N }, () => ({ x: 0, y: 0, age: 0, life: 0 }));
  const w = [0, 0];
  let enabled = true, fade = 0;
  const seed = (p, cx, cy, R) => {
    p.x = cx + (Math.random() - 0.5) * 2 * R;
    p.y = cy + (Math.random() - 0.5) * 2 * R;
    p.age = 0; p.life = 3 + Math.random() * 4;
  };

  function update(dt, target, dist, mpp) {
    fade += ((enabled && ready ? 1 : 0) - fade) * Math.min(1, dt * 1.5);
    mat.uniforms.uFade.value = fade * THREE.MathUtils.clamp(1.3 - dist / 18000, 0.4, 1); // calmer from afar
    mesh.visible = fade > 0.01;
    if (!mesh.visible) return;
    const cx = target.x, cy = -target.z, R = dist * 0.9;
    // Drawn quicker than life so it reads at any zoom: a steady pace on screen.
    const pace = mpp * 9;
    for (let k = 0; k < N; k++) {
      const p = P[k];
      p.age += dt;
      if (p.age > p.life || Math.abs(p.x - cx) > R * 1.2 || Math.abs(p.y - cy) > R * 1.2) seed(p, cx, cy, R);
      at(p.x, p.y, w);
      const s = Math.hypot(w[0], w[1]) || 0.01;
      p.x += w[0] * pace * dt; p.y += w[1] * pace * dt;
      const life = Math.min(1, p.age / 0.8, (p.life - p.age) / 0.8);
      iPos[k * 4] = p.x; iPos[k * 4 + 1] = surfaceY(p.x, p.y) + 25; iPos[k * 4 + 2] = -p.y; iPos[k * 4 + 3] = 2.4 * mpp;
      iDir[k * 4] = w[0] / s; iDir[k * 4 + 1] = w[1] / s;
      iDir[k * 4 + 2] = Math.min(80, 14 + s * 8) * mpp; iDir[k * 4 + 3] = life * Math.min(1, 0.45 + s / 6);
    }
    geo.attributes.iPos.needsUpdate = geo.attributes.iDir.needsUpdate = true;
  }

  return { update, setEnabled: (on) => (enabled = on) };
}
