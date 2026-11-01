// Road works and incidents from DriveBC (Open511, keyless, CORS-open): each
// affected stretch drawn as a marching hazard stripe along the road, amber for
// works and red for incidents. Hovering one says what it is.
import * as THREE from 'three';
import { BOUNDS, toXY } from '../../shared/geo.js';
import { shared } from './world.js';

const URL_EVENTS =
  'https://api.open511.gov.bc.ca/events?format=json&status=ACTIVE&limit=200' +
  `&bbox=${BOUNDS.west},${BOUNDS.south},${BOUNDS.east},${BOUNDS.north}`;

export function createRoadworks(scene, surfaceY, onChange) {
  const group = new THREE.Group();
  scene.add(group);
  const uWidth = { value: 12 };
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uNight: shared.uNight, uWidth, uFade: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float along; attribute float side; attribute vec2 normal2; attribute vec3 tint;
      uniform float uWidth;
      varying float vAlong; varying vec3 vTint; varying float vSide;
      void main() {
        vec3 p = position + vec3(normal2.x, 0.0, normal2.y) * side * uWidth;
        vAlong = along; vTint = tint; vSide = side;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uWidth, uNight, uFade;
      varying float vAlong; varying vec3 vTint; varying float vSide;
      void main() {
        // Diagonal stripes that march along the closure.
        float stripe = step(0.5, fract((vAlong + vSide * uWidth) / (uWidth * 2.2) - uTime * 0.6));
        vec3 col = mix(vTint, vec3(0.16, 0.12, 0.1), stripe * 0.75);
        float edge = 1.0 - smoothstep(0.75, 1.0, abs(vSide));
        gl_FragColor = vec4(col, (0.55 + 0.45 * edge) * uFade);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  let mesh = null, events = [], enabled = true, fade = 1;

  function build(list) {
    const pos = [], along = [], side = [], nrm = [], tint = [], idx = [];
    events = [];
    for (const e of list) {
      const g = e.geography;
      if (!g) continue;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : g.type === 'Point' ? [[g.coordinates, g.coordinates]] : [];
      const incident = e.event_type === 'INCIDENT';
      const c = new THREE.Color(incident ? '#d9563f' : '#eca43a');
      const mid = [];
      for (const line of lines) {
        // Densify so the ribbon follows the hills.
        const pts = [];
        for (let i = 0; i < line.length; i++) {
          const [x, y] = toXY(line[i][0], line[i][1]);
          if (i) {
            const [px, py] = pts[pts.length - 1];
            const n = Math.ceil(Math.hypot(x - px, y - py) / 30);
            for (let k = 1; k < n; k++) pts.push([px + ((x - px) * k) / n, py + ((y - py) * k) / n]);
          }
          pts.push([x, y]);
        }
        // A point event becomes a short dash.
        if (pts.length === 2 && pts[0][0] === pts[1][0]) { pts[0][0] -= 40; pts[1][0] += 40; }
        let s = 0;
        const base = pos.length / 3;
        pts.forEach(([x, y], i) => {
          const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
          const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
          if (i) s += Math.hypot(x - pts[i - 1][0], y - pts[i - 1][1]);
          for (const sd of [-1, 1]) {
            pos.push(x, surfaceY(x, y) + 3, -y);
            nrm.push(-dy / l, -dx / l);
            side.push(sd); along.push(s); tint.push(c.r, c.g, c.b);
          }
          if (i < pts.length - 1) {
            const k = base + i * 2;
            idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
          }
        });
        mid.push(pts[pts.length >> 1]);
      }
      if (!mid.length) continue;
      events.push({
        x: mid[0][0], y: mid[0][1],
        kind: incident ? 'Incident' : e.event_subtypes?.[0]?.replace(/_/g, ' ').toLowerCase() || 'Road work',
        text: (e.description || e.headline || '').split('. Until')[0].split('. Start')[0].slice(0, 160),
        severity: e.severity,
      });
    }
    if (mesh) { group.remove(mesh); mesh.geometry.dispose(); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('along', new THREE.Float32BufferAttribute(along, 1));
    geo.setAttribute('side', new THREE.Float32BufferAttribute(side, 1));
    geo.setAttribute('normal2', new THREE.Float32BufferAttribute(nrm, 2));
    geo.setAttribute('tint', new THREE.Float32BufferAttribute(tint, 3));
    geo.setIndex(idx);
    mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 14;
    group.add(mesh);
    onChange?.(events);
  }

  async function poll() {
    if (!enabled || document.hidden) return;
    try {
      const j = await (await fetch(URL_EVENTS)).json();
      build(j.events || []);
    } catch { /* stays as it was */ }
  }
  poll();
  setInterval(poll, 5 * 60e3);
  document.addEventListener('visibilitychange', () => !document.hidden && !mesh && poll());

  function update(dt, mpp) {
    fade += ((enabled ? 1 : 0) - fade) * Math.min(1, dt * 3);
    group.visible = fade > 0.02;
    mat.uniforms.uFade.value = fade;
    uWidth.value = Math.max(6, mpp * 3.2);
  }

  // The event nearest a map point, within r metres.
  function near(x, y, r) {
    let best = null, bd = r;
    for (const e of events) {
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  return { update, near, setEnabled: (on) => { enabled = on; if (on) poll(); }, get visible() { return enabled; } };
}
