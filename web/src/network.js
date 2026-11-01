// The bus network as living lines: every route shape drawn along its streets,
// thickening with the number of trips scheduled in the hour on the dial.
// Corridors shared by many routes build up into trunk lines, and a slow
// shimmer travels along each line in the direction buses run.
import * as THREE from 'three';
import { HAZE_GLSL } from './shaders.js';
import { shared } from './world.js';

function unpack(d) {
  const out = [];
  let x = 0, y = 0;
  for (let i = 0; i < d.length; i += 2) {
    x += d[i]; y += d[i + 1];
    out.push(x, y);
  }
  return out;
}

export function createNetwork(scene, transit) {
  const { shapes, freq } = transit;
  const n = shapes.length;
  const flat = shapes.map((p) => (p ? unpack(p) : null));
  const pos = [], miter = [], along = [], sid = [], idx = [];
  shapes.forEach((packed, si) => {
    if (!packed || !freq.shapes[si].some((v) => v > 0)) return;
    const raw = flat[si];
    const pts = [];
    for (let i = 0; i < raw.length - 2; i += 2) {
      const ax = raw[i], ay = raw[i + 1], bx = raw[i + 2], by = raw[i + 3];
      const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 40));
      for (let s = 0; s < k; s++) pts.push(ax + ((bx - ax) * s) / k, ay + ((by - ay) * s) / k);
    }
    pts.push(raw[raw.length - 2], raw[raw.length - 1]);
    const np = pts.length / 2;
    if (np < 2) return;
    const base = pos.length / 3;
    let d = 0;
    for (let i = 0; i < np; i++) {
      const p = Math.max(0, i - 1), q = Math.min(np - 1, i + 1);
      let tx = pts[2 * q] - pts[2 * p], ty = pts[2 * q + 1] - pts[2 * p + 1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      if (i) d += Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
      for (const side of [-1, 1]) {
        pos.push(pts[2 * i], 0, -pts[2 * i + 1]);
        miter.push(-ty * side, -tx * side);
        along.push(d);
        sid.push(si);
      }
      if (i < np - 1) {
        const a = base + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('miter', new THREE.Float32BufferAttribute(miter, 2));
  geo.setAttribute('along', new THREE.Float32BufferAttribute(along, 1));
  geo.setAttribute('shapeId', new THREE.Float32BufferAttribute(sid, 1));
  geo.setIndex(idx);

  // Trips per hour for every shape, smoothed toward the dial each frame.
  const cur = new Float32Array(n), target = new Float32Array(n);
  const tex = new THREE.DataTexture(cur, n, 1, THREE.RedFormat, THREE.FloatType);
  tex.needsUpdate = true;

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uFreq: { value: tex }, uCount: { value: n }, uShow: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform sampler2D uHeight, uFreq;
      uniform vec4 uExtent;
      uniform float uExag, uRise, uMpp, uCount;
      attribute vec2 miter;
      attribute float along, shapeId;
      varying vec3 vWorld;
      varying float vAlong, vFreq;
      void main() {
        float f = texture2D(uFreq, vec2((shapeId + 0.5) / uCount, 0.5)).r;
        vFreq = f;
        vAlong = along;
        vec2 uv = (vec2(position.x, -position.z) - uExtent.xy) / uExtent.zw;
        float h = texture2D(uHeight, uv).r * uExag * uRise;
        float px = f > 0.05 ? 0.4 + 0.55 * sqrt(f) : 0.0;
        vec3 p = position + vec3(miter.x, 0.0, miter.y) * px * uMpp;
        p.y = h + 3.5 * max(1.0, uMpp * 0.6);
        vec4 w = modelMatrix * vec4(p, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uShow, uMpp;
      varying vec3 vWorld;
      varying float vAlong, vFreq;
      ${HAZE_GLSL}
      void main() {
        if (vFreq < 0.05) discard;
        float shimmer = 0.8 + 0.2 * sin(vAlong / max(30.0, uMpp * 9.0) - uTime * 2.2);
        vec3 day = vec3(0.16, 0.19, 0.27);
        vec3 night = vec3(0.78, 0.82, 1.0);
        vec3 col = mix(day, night, uNight);
        float a = mix(0.3, 0.32, uNight) * shimmer * uShow;
        gl_FragColor = vec4(applyHaze(col, vWorld), a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 16;
  scene.add(mesh);

  let show = 1, showTarget = 1;
  const DAY = { weekday: 0, saturday: 24, sunday: 48 };

  return {
    setTime(day, hour) {
      const off = DAY[day], h0 = Math.floor(hour) % 24, h1 = (h0 + 1) % 24, f = hour - Math.floor(hour);
      for (let i = 0; i < n; i++) target[i] = freq.shapes[i][off + h0] * (1 - f) + freq.shapes[i][off + h1] * f;
    },
    update(dt) {
      const k = 1 - Math.exp(-dt * 2.5);
      for (let i = 0; i < n; i++) cur[i] += (target[i] - cur[i]) * k;
      tex.needsUpdate = true;
      show += (showTarget - show) * (1 - Math.exp(-dt * 3));
      mat.uniforms.uShow.value = show;
      mesh.visible = show > 0.01;
    },
    setVisible: (v) => (showTarget = v ? 1 : 0),
    get visible() { return showTarget > 0; },
    // Scheduled trips an hour, both directions, on lines passing within `r`
    // metres of a map point.
    near(x, y, r) {
      let sum = 0;
      flat.forEach((p, si) => {
        if (!p || cur[si] < 0.05) return;
        for (let i = 0; i < p.length; i += 2) {
          if (Math.abs(p[i] - x) < r && Math.abs(p[i + 1] - y) < r) { sum += cur[si]; break; }
        }
      });
      return sum;
    },
  };
}
