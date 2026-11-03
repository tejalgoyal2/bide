// Earthquakes from the USGS feed (keyless, CORS-open): the past week within
// 250 km. Each one pulses where it struck; those beyond the map sit on the
// horizon in their true direction, so you can see where Cascadia stirred.
// Fresh quakes ripple quickly in coral, older ones slow and fade to ink.
import * as THREE from 'three';
import { CORE, toXY } from '../../shared/geo.js';
import { shared } from './world.js';

const MAX = 64;
const [cx0, cy0] = toXY(CORE.west, CORE.south), [cx1, cy1] = toXY(CORE.east, CORE.north);
const C = [(cx0 + cx1) / 2, (cy0 + cy1) / 2], RX = (cx1 - cx0) * 0.75, RY = (cy1 - cy0) * 0.75;
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function createQuakes(scene, surfaceY, onChange) {
  const quad = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  const iPos = new Float32Array(MAX * 4), iInfo = new Float32Array(MAX * 4);
  geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('iInfo', new THREE.InstancedBufferAttribute(iInfo, 4));
  geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uNight: shared.uNight, uFade: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute vec4 iPos;  // position, radius (m)
      attribute vec4 iInfo; // hours ago, magnitude, phase, 1 on the map / 0 on the horizon
      varying vec2 vP; varying vec4 vInfo;
      void main() {
        vP = position.xz; vInfo = iInfo;
        gl_Position = projectionMatrix * viewMatrix * vec4(iPos.xyz + vec3(position.x, 0.0, position.z) * iPos.w, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uNight, uFade;
      varying vec2 vP; varying vec4 vInfo;
      void main() {
        float r = length(vP);
        if (r > 1.0) discard;
        float fresh = exp(-vInfo.x / 18.0);              // 1 now, ~0.26 a day on
        float speed = mix(0.12, 0.45, fresh);
        float a = 0.0;
        for (int k = 0; k < 3; k++) {
          float t = fract(uTime * speed + vInfo.z + float(k) / 3.0);
          float ring = 1.0 - smoothstep(0.0, 0.05, abs(r - t));
          a += ring * (1.0 - t);
        }
        float core = 1.0 - smoothstep(0.06, 0.11, r);
        vec3 coral = vec3(0.93, 0.42, 0.33), ink = mix(vec3(0.35, 0.3, 0.32), vec3(0.75, 0.78, 0.9), uNight);
        vec3 col = mix(ink, coral, fresh);
        gl_FragColor = vec4(col, (a * mix(0.35, 0.85, fresh) + core * 0.9) * uFade);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 15;
  scene.add(mesh);

  let list = [], enabled = true, fade = 0;
  async function load() {
    try {
      const since = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 19);
      const u = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=48.43&longitude=-123.37' +
        `&maxradiuskm=250&minmagnitude=1&orderby=time&limit=${MAX}&starttime=${since}`;
      const j = await (await fetch(u)).json();
      list = j.features.map((f) => {
        const [lon, lat, depth] = f.geometry.coordinates;
        const [x, y] = toXY(lon, lat);
        const dx = x - C[0], dy = y - C[1];
        // Beyond the map: on the horizon ellipse, same bearing.
        const e = Math.hypot(dx / RX, dy / RY);
        const on = e <= 1;
        const km = Math.round(Math.hypot(x - toXY(-123.37, 48.43)[0], y - toXY(-123.37, 48.43)[1]) / 1000);
        const bearing = COMPASS[Math.round(((Math.atan2(dx, dy) * 180) / Math.PI + 360) / 45) % 8];
        return {
          x: on ? x : C[0] + dx / e, y: on ? y : C[1] + dy / e, on,
          mag: f.properties.mag, time: f.properties.time, depth: Math.round(depth),
          place: f.properties.place, km, bearing, phase: Math.random(),
        };
      });
      onChange?.(list);
    } catch { /* keep the last list */ }
  }
  load();
  setInterval(load, 10 * 60e3);

  function update(dt, mpp) {
    fade += ((enabled ? 1 : 0) - fade) * Math.min(1, dt * 2);
    mat.uniforms.uFade.value = fade;
    mesh.visible = fade > 0.01 && list.length > 0;
    if (!mesh.visible) return;
    const now = Date.now();
    list.forEach((q, i) => {
      // Size grows with magnitude, and never shrinks below a few dozen pixels.
      const px = 14 + q.mag * 9;
      iPos[i * 4] = q.x; iPos[i * 4 + 1] = q.on ? surfaceY(q.x, q.y) + 4 : 2; iPos[i * 4 + 2] = -q.y;
      iPos[i * 4 + 3] = Math.max(q.mag * 400, px * mpp);
      iInfo[i * 4] = (now - q.time) / 3600e3; iInfo[i * 4 + 1] = q.mag; iInfo[i * 4 + 2] = q.phase; iInfo[i * 4 + 3] = q.on ? 1 : 0;
    });
    geo.instanceCount = list.length;
    geo.attributes.iPos.needsUpdate = geo.attributes.iInfo.needsUpdate = true;
  }

  // The quake nearest a map point, within r metres.
  function near(x, y, r) {
    let best = null, bd = r;
    for (const q of list) {
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }

  return { update, near, setEnabled: (on) => (enabled = on), get list() { return enabled ? list : []; } };
}
