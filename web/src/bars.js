// Hexagonal columns rising out of the map. The first layer is scheduled
// transit activity: bus departures per hour from the stops in each hex,
// following the time of day.
import * as THREE from 'three';
import { HAZE_GLSL } from './shaders.js';
import { shared, EXAG } from './world.js';

const SQ3 = Math.sqrt(3);
export const hexCenter = (q, r, s) => [s * SQ3 * (q + r / 2), s * 1.5 * r];

export function hexOf(x, y, s) {
  const qf = ((SQ3 / 3) * x - y / 3) / s, rf = ((2 / 3) * y) / s;
  let rx = Math.round(qf), ry = Math.round(rf);
  const rz = Math.round(-qf - rf);
  const dx = Math.abs(rx - qf), dy = Math.abs(ry - rf), dz = Math.abs(rz + qf + rf);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  return [rx, ry];
}

export function createBars(scene, activity, world) {
  const { hex, cells } = activity;
  const n = cells.length;
  const geo = new THREE.CylinderGeometry(hex * 0.5, hex * 0.5, 1, 6, 1).translate(0, 0.5, 0);
  const value = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  value.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aValue', value);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uShow: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aValue;
      varying vec3 vN, vWorld;
      varying float vV, vY;
      void main() {
        mat4 m = modelMatrix * instanceMatrix;
        vec4 w = m * vec4(position, 1.0);
        vN = normalize(mat3(m) * normal);
        vV = aValue;
        vY = position.y;
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uShow;
      varying vec3 vN, vWorld;
      varying float vV, vY;
      ${HAZE_GLSL}
      vec3 ramp(float t) {
        vec3 a = vec3(0.98, 0.91, 0.66), b = vec3(0.98, 0.70, 0.40);
        vec3 c = vec3(0.95, 0.47, 0.37), d = vec3(0.74, 0.25, 0.42);
        return t < 0.35 ? mix(a, b, t / 0.35) : t < 0.7 ? mix(b, c, (t - 0.35) / 0.35) : mix(c, d, (t - 0.7) / 0.3);
      }
      void main() {
        vec3 base = ramp(clamp(vV, 0.0, 1.0));
        vec3 base_l = pow(base, vec3(2.2));
        float top = step(0.5, vN.y);
        float lambert = max(dot(vN, uSun), 0.0);
        vec3 lit = base_l * (uAmbient * 0.95 + uSunColor * lambert * 0.6);
        lit = mix(lit, base_l * 1.08, top * 0.6);
        lit *= mix(0.72, 1.0, vY);
        // At night the columns become lanterns.
        vec3 lantern = base_l * mix(0.55, 1.25, vY) * mix(0.8, 1.15, top);
        vec3 col = mix(lit, lantern, uNight);
        gl_FragColor = vec4(applyHaze(col, vWorld), 0.93 * uShow);
        #include <colorspace_fragment>
      }`,
    transparent: true,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.frustumCulled = false;
  mesh.renderOrder = 15;
  scene.add(mesh);

  const base = new Float32Array(n), cur = new Float32Array(n), target = new Float32Array(n);
  const xy = cells.map(([q, r]) => hexCenter(q, r, hex));
  const index = new Map(cells.map(([q, r], i) => [`${q},${r}`, i]));
  xy.forEach(([x, y], i) => (base[i] = world.heightAt(x, y) * EXAG));

  let show = 1, showTarget = 1;
  const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion();

  // Departures per hour in a cell, interpolated between whole hours.
  const valueAt = (i, day, hour) => {
    const off = 2 + { weekday: 0, saturday: 24, sunday: 48 }[day];
    const h0 = Math.floor(hour) % 24, h1 = (h0 + 1) % 24, f = hour - Math.floor(hour);
    return cells[i][off + h0] * (1 - f) + cells[i][off + h1] * f;
  };

  function setTime(day, hour) {
    for (let i = 0; i < n; i++) target[i] = valueAt(i, day, hour);
  }

  // Up close the columns sink and thin out so the streets and buses show.
  function update(dt, dist) {
    show += (showTarget - show) * (1 - Math.exp(-dt * 3));
    const zoom = THREE.MathUtils.lerp(0.12, 1, THREE.MathUtils.smoothstep(dist, 1500, 9000));
    mat.uniforms.uShow.value = show * THREE.MathUtils.lerp(0.55, 1, zoom);
    mesh.visible = show > 0.01;
    const k = 1 - Math.exp(-dt * 2.5), rise = shared.uRise.value;
    for (let i = 0; i < n; i++) {
      cur[i] += (target[i] - cur[i]) * k;
      const v = cur[i];
      const h = 62 * Math.sqrt(Math.max(0, v - 3)) * show * rise * zoom;
      const w = THREE.MathUtils.smoothstep(h, 0, 40 * zoom);
      p.set(xy[i][0], base[i] * rise, -xy[i][1]);
      s.set(w, Math.max(h, 0.001), w);
      m4.compose(p, q, s);
      mesh.setMatrixAt(i, m4);
      value.array[i] = Math.sqrt(v) / 12;
    }
    mesh.instanceMatrix.needsUpdate = true;
    value.needsUpdate = true;
  }

  return {
    update,
    setTime,
    setVisible: (v) => (showTarget = v ? 1 : 0),
    get visible() { return showTarget > 0; },
    // The departures per hour under a map point, for the hover tooltip.
    at(x, y) {
      const [qq, rr] = hexOf(x, y, hex);
      const i = index.get(`${qq},${rr}`);
      return i == null ? null : { value: cur[i], i };
    },
  };
}
