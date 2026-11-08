// The city's buildings, extruded from OpenStreetMap footprints. They rise out
// of the map as you zoom in, in a wave rather than all at once, and sink
// back when you pull away. At night their windows light up, a few at a time.
import * as THREE from 'three';
import earcut from 'earcut';
import { shared, EXAG } from './world.js';
import { HAZE_GLSL, NOISE_GLSL } from './shaders.js';
import { toXY } from '../../shared/geo.js';

// Two buildings get their own night: the Legislature's outline of bulbs, and
// BCI, whose lights stay on late.
const LEG = toXY(-123.3703, 48.4197), BCI = toXY(-123.36308, 48.42823);

const SHOW_FROM = 7000, FULL_AT = 3000; // camera distance, metres

export function createBuildings(scene, world) {
  const uGrow = { value: 0 };
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uGrow },
    vertexShader: /* glsl */ `
      attribute vec4 aMeta;   // ground height, building height, 0 bottom / 1 top, metres along the wall (-1 on roofs)
      attribute float aSeed;
      uniform float uGrow, uRise;
      varying vec3 vN, vWorld;
      varying float vSeed, vU, vZ, vTop, vG, vFlag;
      void main() {
        float seed = fract(aSeed);
        vFlag = floor(aSeed);
        // Each building grows on its own beat: a wave, not a single lift.
        float g = clamp(uGrow * 1.7 - seed * 0.7, 0.0, 1.0);
        g = 1.0 - pow(1.0 - g, 3.0);
        float y = aMeta.x * uRise + aMeta.z * aMeta.y * g - (1.0 - aMeta.z) * 2.0;
        if (g < 0.01) y = aMeta.x * uRise - 6.0; // hidden under the ground
        vec4 w = modelMatrix * vec4(position.x, y, position.z, 1.0);
        vWorld = w.xyz; vN = normal; vSeed = seed; vU = aMeta.w;
        vZ = aMeta.z * aMeta.y * g; vTop = aMeta.y * g; vG = g;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vN, vWorld;
      varying float vSeed, vU, vZ, vTop, vG, vFlag;
      ${NOISE_GLSL}
      ${HAZE_GLSL}
      void main() {
        bool roof = vU < 0.0;
        vec3 base = roof ? mix(vec3(0.84, 0.8, 0.74), vec3(0.93, 0.89, 0.82), vSeed)
                         : mix(vec3(0.68, 0.64, 0.62), vec3(0.82, 0.76, 0.7), fract(vSeed * 7.3));
        float lambert = max(dot(normalize(vN), uSun), 0.0);
        vec3 col = base * (uAmbient * 0.85 + uSunColor * lambert * 0.6);
        if (!roof) col *= 0.72 + 0.28 * smoothstep(0.0, 6.0, vZ); // darker where walls meet the street
        col = mix(col, col * vec3(0.16, 0.19, 0.33), uNight * 0.92);

        // Lit windows: a grid of floors and bays, some on. Window edges are
        // anti-aliased, and where a window shrinks below a few pixels the grid
        // gives way to its average glow, so nothing shimmers as the camera moves.
        if (!roof && uNight > 0.01) {
          vec2 cell = vec2(vU / 3.4, vZ / 3.3);
          vec2 id = floor(cell), f = fract(cell);
          vec2 fw = max(fwidth(cell), vec2(1e-4));
          vec2 lo = smoothstep(vec2(0.28, 0.3) - fw, vec2(0.28, 0.3) + fw, f);
          vec2 hi = 1.0 - smoothstep(vec2(0.72, 0.78) - fw, vec2(0.72, 0.78) + fw, f);
          float win = lo.x * hi.x * lo.y * hi.y;
          win *= step(1.0, vTop - id.y * 3.3) * step(0.5, id.y + 0.6); // whole floors only
          // Which windows are on changes only every few minutes, one at a time.
          float on = step(vFlag > 1.5 ? 0.08 : 0.62, hash(id + vSeed * 97.0 + floor(uTime / 180.0 + hash(id) * 7.0) * 0.013));
          float detail = 1.0 - smoothstep(0.18, 0.4, max(fw.x, fw.y));
          float avg = vFlag > 1.5 ? 0.18 : 0.08;
          vec3 warm = mix(vec3(1.0, 0.76, 0.42), vec3(0.95, 0.9, 0.8), hash(id * 1.7 + vSeed));
          col += warm * uNight * mix(avg * vec3(1.0, 0.85, 0.6) / warm, vec3(win * on * 0.95), detail);
        }
        // The Legislature: rows of bulbs along its eaves and cornices.
        if (vFlag > 0.5 && vFlag < 1.5 && uNight > 0.01) {
          vec2 q = vec2(roof ? vWorld.x + vWorld.z : vU, vZ);
          float row = roof ? 0.0 : (1.0 - smoothstep(0.0, 0.35, abs(vZ - vTop + 0.3))) + (1.0 - smoothstep(0.0, 0.35, abs(vZ - 0.45 * vTop)));
          float bulb = 1.0 - smoothstep(0.12, 0.3, length(vec2(fract(q.x / 1.1) - 0.5, 0.0)));
          col += vec3(1.0, 0.86, 0.55) * uNight * row * bulb * 1.6;
        }
        gl_FragColor = vec4(applyHaze(col, vWorld), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  let mesh = null;

  // Fetched only the first time someone zooms in (700 kB saved for everyone
  // else), then decoded and built in slices so the page never stalls.
  let started = false;
  const load = () => (async () => {
    const res = await fetch('/data/buildings.dat');
    const raw = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const d = new Int16Array(raw);
    const list = [];
    let nv = 0, ni = 0;
    for (let p = 0; p < d.length; ) {
      const n = d[p], h = d[p + 1] / 10;
      const xs = new Float32Array(n * 2);
      let x = 0, y = 0;
      for (let j = 0; j < n; j++) {
        x = j ? x + d[p + 2 + j * 2] : d[p + 2]; y = j ? y + d[p + 3 + j * 2] : d[p + 3];
        xs[j * 2] = x; xs[j * 2 + 1] = y;
      }
      list.push({ h, xs });
      nv += n * 5; ni += n * 6 + (n - 2) * 3;
      p += 2 + n * 2;
    }
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), meta = new Float32Array(nv * 4), seed = new Float32Array(nv);
    const idx = new Uint32Array(ni);
    let v = 0, k = 0, b = 0;
    const put = (x, y, nx, ny, nz, m0, m1, m2, m3, s) => {
      pos[v * 3] = x; pos[v * 3 + 1] = 0; pos[v * 3 + 2] = -y;
      nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz;
      meta[v * 4] = m0; meta[v * 4 + 1] = m1; meta[v * 4 + 2] = m2; meta[v * 4 + 3] = m3;
      seed[v] = s;
      return v++;
    };
    while (b < list.length) {
      const stop = Math.min(list.length, b + 4000);
      for (; b < stop; b++) {
        const { h, xs } = list[b], n = xs.length / 2;
        let ground = Infinity, cx = 0, cy = 0;
        for (let j = 0; j < n; j++) {
          ground = Math.min(ground, world.heightAt(xs[j * 2], xs[j * 2 + 1]) * EXAG);
          cx += xs[j * 2]; cy += xs[j * 2 + 1];
        }
        // Buildings near the centre of downtown rise first.
        const r = Math.hypot(cx / n + 700, cy / n + 3900);
        const ccx = cx / n, ccy = cy / n;
        const flag = Math.hypot(ccx - LEG[0], ccy - LEG[1]) < 80 ? 1 : Math.hypot(ccx - BCI[0], ccy - BCI[1]) < 35 ? 2 : 0;
        const s = flag + Math.min(0.999, (r / 9000) * 0.75 + Math.random() * 0.25);
        let u = 0;
        for (let j = 0; j < n; j++) {
          const ax = xs[j * 2], ay = xs[j * 2 + 1], bx = xs[((j + 1) % n) * 2], by = xs[((j + 1) % n) * 2 + 1];
          const l = Math.hypot(bx - ax, by - ay) || 1, nx = (by - ay) / l, ny = -(bx - ax) / l;
          const a0 = put(ax, ay, nx, 0, -ny, ground, h, 0, u, s), a1 = put(ax, ay, nx, 0, -ny, ground, h, 1, u, s);
          const b0 = put(bx, by, nx, 0, -ny, ground, h, 0, u + l, s), b1 = put(bx, by, nx, 0, -ny, ground, h, 1, u + l, s);
          idx.set([a0, b0, b1, a0, b1, a1], k); k += 6;
          u += l;
        }
        const r0 = v;
        for (let j = 0; j < n; j++) put(xs[j * 2], xs[j * 2 + 1], 0, 1, 0, ground, h, 1, -1, s);
        for (const t of earcut(xs)) idx[k++] = r0 + t;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm.subarray(0, v * 3), 3));
    geo.setAttribute('aMeta', new THREE.BufferAttribute(meta.subarray(0, v * 4), 4));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed.subarray(0, v), 1));
    geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, k), 1));
    mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 12;
    scene.add(mesh);
  })().catch((e) => console.warn('buildings', e));

  let enabled = true;
  function update(dt, dist) {
    if (!started && enabled && dist < SHOW_FROM * 0.85) { started = true; load(); }
    const target = enabled ? THREE.MathUtils.smoothstep(dist, FULL_AT, SHOW_FROM) : 0;
    uGrow.value += ((1 - target) - uGrow.value) * Math.min(1, dt * 1.6);
    if (mesh) mesh.visible = uGrow.value > 0.005;
  }
  return { update, setEnabled: (on) => (enabled = on) };
}
