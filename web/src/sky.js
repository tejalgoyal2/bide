// Light from the real sun (and moon) over Victoria, with a palette that moves
// through dawn, day, golden hour, dusk and night.
import * as THREE from 'three';
import * as SunCalc from 'suncalc';
import { shared } from './world.js';
import { NOISE_GLSL } from './shaders.js';

const LAT = 48.43, LON = -123.37;

// Keyed by sun altitude in degrees.
const KEYS = [
  { alt: -14, haze: '#141a33', top: '#070b1c', amb: [0.3, 0.34, 0.5], sun: [0.25, 0.3, 0.45], night: 1 },
  { alt: -6, haze: '#3d4673', top: '#1a2149', amb: [0.42, 0.44, 0.6], sun: [0.35, 0.36, 0.55], night: 0.78 },
  { alt: -1, haze: '#e79a7c', top: '#5a6aa8', amb: [0.58, 0.52, 0.6], sun: [0.95, 0.55, 0.35], night: 0.3 },
  { alt: 6, haze: '#f5cc9f', top: '#86aed8', amb: [0.62, 0.6, 0.62], sun: [0.85, 0.66, 0.45], night: 0 },
  { alt: 22, haze: '#f0e4cd', top: '#9cc9e8', amb: [0.62, 0.64, 0.7], sun: [0.72, 0.7, 0.64], night: 0 },
];

// SunCalc 2 gives degrees: altitude above the horizon, and azimuth clockwise
// from north. World axes are x east, y up, z south.
function sunDir(altDeg, azDeg) {
  const alt = (altDeg * Math.PI) / 180, az = (azDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
}

export function createSky(scene) {
  const top = new THREE.Color();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(150000, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uHaze: shared.uHaze, uTop: { value: top }, uNight: shared.uNight, uSun: shared.uSun, uTime: shared.uTime },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uHaze, uTop, uSun;
        uniform float uNight, uTime;
        varying vec3 vDir;
        ${NOISE_GLSL}
        void main() {
          float h = max(vDir.y, 0.0);
          vec3 col = mix(uHaze, uTop, pow(h, 0.55));
          vec2 sp = vDir.xz / max(vDir.y, 0.05) * 120.0;
          float star = step(0.9975, hash(floor(sp))) * smoothstep(0.08, 0.4, h);
          star *= 0.6 + 0.4 * sin(uTime * 2.0 + hash(floor(sp) + 3.0) * 40.0);
          col += vec3(star) * uNight * 0.9;
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  scene.add(dome);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x887766, 1);
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  scene.add(hemi, dir, dir.target);

  const c0 = new THREE.Color(), c1 = new THREE.Color();
  let info = { alt: 0 };

  function set(date) {
    const sun = SunCalc.getPosition(date, LAT, LON);
    const altDeg = sun.altitude;
    let i = 0;
    while (i < KEYS.length - 2 && altDeg > KEYS[i + 1].alt) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const t = THREE.MathUtils.clamp((altDeg - a.alt) / (b.alt - a.alt), 0, 1);
    const k = t * t * (3 - 2 * t);
    shared.uHaze.value.copy(c0.set(a.haze).lerp(c1.set(b.haze), k));
    top.copy(c0.set(a.top).lerp(c1.set(b.top), k));
    shared.uAmbient.value.setRGB(...a.amb.map((v, j) => v + (b.amb[j] - v) * k));
    shared.uSunColor.value.setRGB(...a.sun.map((v, j) => v + (b.sun[j] - v) * k));
    const night = a.night + (b.night - a.night) * k;
    shared.uNight.value = night;

    // By night the moon takes over the light (and the glint on the water).
    if (altDeg < -4) {
      const moon = SunCalc.getMoonPosition(date, LAT, LON);
      const d = sunDir(Math.max(moon.altitude, 20), moon.azimuth);
      shared.uSun.value.copy(d);
    } else {
      shared.uSun.value.copy(sunDir(Math.max(sun.altitude, 3.5), sun.azimuth));
    }
    hemi.color.copy(shared.uAmbient.value).multiplyScalar(1.3);
    hemi.groundColor.copy(shared.uAmbient.value).multiplyScalar(0.6);
    dir.color.copy(shared.uSunColor.value);
    dir.intensity = 1.6;
    dir.position.copy(shared.uSun.value).multiplyScalar(10000);
    info = { alt: altDeg, night };
    return info;
  }

  return { set, get info() { return info; }, dome };
}
