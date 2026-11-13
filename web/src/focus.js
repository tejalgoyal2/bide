// The selected bus's journey: its route drawn as a lit ribbon in the route's
// colour, bright ahead of the bus and faint behind, with light pulsing along
// it in the direction of travel; and its next stops marked on the map with
// bide's arrival times, matching the bus card.
import * as THREE from 'three';
import { shared } from './world.js';

export function createFocus(scene, world, layer) {
  const uS = { value: 0 }, uWidth = { value: 8 }, uColor = { value: new THREE.Color() }, uFade = { value: 0 };
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uNight: shared.uNight, uS, uWidth, uColor, uFade },
    vertexShader: /* glsl */ `
      attribute float along; attribute float side; attribute vec2 normal2;
      uniform float uWidth;
      varying float vAlong, vSide;
      void main() {
        vec3 p = position + vec3(normal2.x, 0.0, normal2.y) * side * uWidth;
        vAlong = along; vSide = side;
        // Lies on the street, hidden by buildings in front of it; nudged
        // toward the camera so the ground doesn't swallow it.
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float d = length(mv.xyz);
        mv.xyz *= max(0.0, 1.0 - (3.0 + d * 0.005) / d);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uNight, uS, uWidth, uFade;
      uniform vec3 uColor;
      varying float vAlong, vSide;
      void main() {
        float ahead = smoothstep(uS - 40.0, uS + 10.0, vAlong);
        float pulse = pow(0.5 + 0.5 * sin((vAlong - uTime * 220.0) / (uWidth * 6.0)), 6.0) * ahead;
        float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
        vec3 col = mix(uColor, vec3(1.0), pulse * 0.55 + uNight * 0.15);
        float a = edge * mix(0.22, 0.9, ahead) * uFade;
        gl_FragColor = vec4(col, a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  let mesh = null, shape = null, bus = null, stops = [];

  function build(sh) {
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh = null; }
    shape = sh;
    if (!sh) return;
    const { xy, cum } = sh, n = cum.length;
    const pos = new Float32Array(n * 6), along = new Float32Array(n * 2), side = new Float32Array(n * 2), nrm = new Float32Array(n * 4);
    const idx = [];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const dx = xy[2 * b] - xy[2 * a], dy = xy[2 * b + 1] - xy[2 * a + 1], l = Math.hypot(dx, dy) || 1;
      const x = xy[2 * i], y = xy[2 * i + 1], h = world.meshHeight(x, y) * 1.7 + 1;
      for (let k = 0; k < 2; k++) {
        const j = i * 2 + k;
        pos.set([x, h, -y], j * 3);
        nrm.set([-dy / l, -dx / l], j * 2);
        side[j] = k ? 1 : -1; along[j] = cum[i];
      }
      if (i < n - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('along', new THREE.BufferAttribute(along, 1));
    geo.setAttribute('side', new THREE.BufferAttribute(side, 1));
    geo.setAttribute('normal2', new THREE.BufferAttribute(nrm, 2));
    geo.setIndex(idx);
    mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 16;
    scene.add(mesh);
  }

  // Stop markers: small HTML pins, so the names stay crisp.
  const pins = [];
  function setStops(list) {
    stops = list || [];
    while (pins.length < stops.length) {
      const el = document.createElement('div');
      el.className = 'stop-pin';
      layer.appendChild(el);
      pins.push(el);
    }
    pins.forEach((el, i) => {
      const s = stops[i];
      el.style.display = s ? '' : 'none';
      if (s) el.innerHTML = `<i></i><span>${s.label}</span>`;
    });
  }

  const v = new THREE.Vector3();
  function update(dt, camera, mpp) {
    uFade.value += ((bus ? 1 : 0) - uFade.value) * Math.min(1, dt * 4);
    if (mesh) mesh.visible = uFade.value > 0.01;
    if (!bus && uFade.value < 0.01 && mesh) build(null);
    uWidth.value = Math.max(4, mpp * 3);
    if (bus?.s != null) uS.value = bus.s;
    stops.forEach((s, i) => {
      const el = pins[i];
      v.set(s.x, world.surfaceY(s.x, s.y), -s.y).project(camera);
      const on = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      el.style.opacity = on ? uFade.value : 0;
      el.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px)`;
    });
  }

  return {
    update,
    set(b, color) {
      bus = b;
      if (!b) { setStops([]); return; }
      uColor.value.set(color);
      if (b.shape !== shape) build(b.shape);
    },
    setStops,
  };
}
