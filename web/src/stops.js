// Bus stops: small markers that appear once you're down at street level.
// Tap one for its departures board (see main.js). Drawn as screen-sized
// points so they stay crisp at any tilt.
import * as THREE from 'three';
import { shared, EXAG } from './world.js';

const SHOW_AT = 2200, FULL_AT = 1400; // camera distance, metres

export function createStops(scene, transit, heightAt) {
  const list = transit.stops; // [id, name, x, y]
  const n = list.length;
  const pos = new Float32Array(n * 3), sel = new Float32Array(n);
  // Final terrain height (the intro's rising city is ignored: stops appear later).
  list.forEach(([, , x, y], i) => pos.set([x, heightAt(x, y) * EXAG + 1.5, -y], i * 3));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSel', new THREE.BufferAttribute(sel, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uFade: { value: 0 }, uNight: shared.uNight, uDpr: { value: Math.min(devicePixelRatio, 2) } },
    vertexShader: /* glsl */ `
      attribute float aSel;
      uniform float uDpr;
      varying float vSel;
      void main() {
        vSel = aSel;
        // Depth-tested so buildings in front hide it, nudged toward the camera.
        vec4 mv = viewMatrix * vec4(position, 1.0);
        float d = length(mv.xyz);
        mv.xyz *= max(0.0, 1.0 - (3.0 + d * 0.005) / d);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (aSel > 0.5 ? 17.0 : 9.0) * uDpr;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uFade, uNight;
      varying float vSel;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        if (r > 1.0) discard;
        float aa = 0.12;
        vec3 ring = vSel > 0.5 ? vec3(0.88, 0.47, 0.31) : mix(vec3(0.25, 0.22, 0.24), vec3(0.85, 0.85, 0.95), uNight);
        vec3 fill = vec3(1.0, 0.99, 0.96);
        float edge = smoothstep(1.0, 1.0 - aa, r);
        vec3 c = mix(ring, fill, smoothstep(0.62, 0.62 - aa, r));
        gl_FragColor = vec4(c, edge * uFade);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 18;
  scene.add(points);

  let enabled = true, picked = -1;
  const v = new THREE.Vector3();
  function update(dt, dist) {
    const target = enabled ? 1 - THREE.MathUtils.smoothstep(dist, FULL_AT, SHOW_AT) : 0;
    mat.uniforms.uFade.value += (target - mat.uniforms.uFade.value) * Math.min(1, dt * 5);
    points.visible = mat.uniforms.uFade.value > 0.02 || picked >= 0;
    if (picked >= 0) mat.uniforms.uFade.value = Math.max(mat.uniforms.uFade.value, 0.0001);
  }

  // The stop nearest a screen point, within r px, if stops are showing.
  function at(camera, x, y, r = 14) {
    if (mat.uniforms.uFade.value < 0.4) return null;
    let best = null, bd = r;
    for (let i = 0; i < n; i++) {
      v.fromArray(pos, i * 3).project(camera);
      if (v.z > 1 || v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) continue;
      const d = Math.hypot(((v.x + 1) / 2) * innerWidth - x, ((1 - v.y) / 2) * innerHeight - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best == null ? null : { i: best, id: list[best][0], name: list[best][1], x: list[best][2], y: list[best][3] };
  }

  function select(i) {
    if (picked >= 0) sel[picked] = 0;
    picked = i ?? -1;
    if (picked >= 0) sel[picked] = 1;
    geo.attributes.aSel.needsUpdate = true;
  }

  return { update, at, select, setEnabled: (on) => (enabled = on) };
}
