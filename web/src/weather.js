// Live conditions from free, keyless sources: Open-Meteo for weather and the
// Canadian Hydrographic Service for the tide at Victoria Harbour.
import * as THREE from 'three';
import { shared } from './world.js';

const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow',
  80: 'showers', 81: 'showers', 82: 'downpours', 95: 'thunderstorms', 96: 'thunderstorms', 99: 'thunderstorms',
};
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const TIDE_STATION = '5cebf1df3d0f4a073c4bbd1e'; // Victoria Harbour, 07120

export function createWeather(scene, onChange) {
  const state = { weather: null, tide: null, enabled: true };

  // Rain: streaks that fall around the camera's target and recycle.
  const N = 9000;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = Math.random() - 0.5;
    pos[i * 3 + 1] = Math.random();
    pos[i * 3 + 2] = Math.random() - 0.5;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const rainMat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uCenter: { value: new THREE.Vector3() }, uSize: { value: 4000 }, uAmount: { value: 0 }, uWind: shared.uWind },
    vertexShader: /* glsl */ `
      uniform float uTime, uSize, uAmount;
      uniform vec3 uCenter;
      uniform vec2 uWind;
      varying float vA;
      void main() {
        vec3 p = position;
        float fall = fract(p.y - uTime * 0.35);
        vec3 w = vec3(p.x * uSize, fall * uSize * 0.45, p.z * uSize);
        w.xz += uWind * fall * 30.0;
        w += vec3(uCenter.x, uCenter.y, uCenter.z);
        vA = step(fract(p.x * 91.7), uAmount) * smoothstep(0.0, 0.1, fall);
        vec4 mv = viewMatrix * vec4(w, 1.0);
        gl_PointSize = clamp(2600.0 / -mv.z, 1.0, 3.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        if (vA < 0.5) discard;
        gl_FragColor = vec4(0.85, 0.9, 1.0, 0.35);
      }`,
    transparent: true,
    depthWrite: false,
  });
  const rain = new THREE.Points(geo, rainMat);
  rain.frustumCulled = false;
  rain.renderOrder = 30;
  scene.add(rain);

  async function loadWeather() {
    try {
      const u = 'https://api.open-meteo.com/v1/forecast?latitude=48.43&longitude=-123.37' +
        '&current=temperature_2m,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,precipitation&timezone=America%2FVancouver';
      const c = (await (await fetch(u)).json()).current;
      const dir = (c.wind_direction_10m * Math.PI) / 180;
      // Wind blows from its stated direction; push the sea and clouds the other way.
      shared.uWind.value.set(-Math.sin(dir), -Math.cos(dir)).multiplyScalar(1 + c.wind_speed_10m / 8);
      shared.uCloud.value = c.cloud_cover / 100;
      state.weather = {
        temp: Math.round(c.temperature_2m),
        text: WMO[c.weather_code] || 'unsettled',
        wind: Math.round(c.wind_speed_10m),
        from: COMPASS[Math.round(c.wind_direction_10m / 45) % 8],
        rain: c.precipitation,
        code: c.weather_code,
      };
      onChange(state);
    } catch (e) {
      console.warn('weather', e);
    }
  }

  async function loadTide() {
    try {
      const now = Date.now();
      const iso = (t) => new Date(t).toISOString().slice(0, 19) + 'Z';
      const u = `https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/${TIDE_STATION}/data?time-series-code=wlp` +
        `&from=${iso(now - 3 * 3600e3)}&to=${iso(now + 15 * 3600e3)}`;
      const rows = (await (await fetch(u)).json()).map((r) => ({ t: Date.parse(r.eventDate), v: r.value }));
      if (!rows.length) return;
      let i = rows.findIndex((r) => r.t > now);
      if (i < 1) i = 1;
      const a = rows[i - 1], b = rows[i];
      const v = a.v + ((b.v - a.v) * (now - a.t)) / (b.t - a.t || 1);
      // The next turn of the tide.
      let turn = null;
      for (let j = i; j < rows.length - 1; j++) {
        const d0 = rows[j].v - rows[j - 1].v, d1 = rows[j + 1].v - rows[j].v;
        if (d0 * d1 < 0) { turn = { t: rows[j].t, v: rows[j].v, high: d0 > 0 }; break; }
      }
      state.tide = { v, rising: b.v > a.v, turn };
      onChange(state);
    } catch (e) {
      console.warn('tide', e);
    }
  }

  loadWeather();
  loadTide();
  setInterval(loadWeather, 10 * 60e3);
  setInterval(loadTide, 15 * 60e3);

  function update(target, dist) {
    const w = state.weather;
    const raining = state.enabled && w && (w.rain > 0 || [51, 53, 55, 61, 63, 65, 80, 81, 82].includes(w.code));
    const amt = raining ? Math.min(1, 0.35 + (w.rain || 0) / 3) : 0;
    rainMat.uniforms.uAmount.value += (amt - rainMat.uniforms.uAmount.value) * 0.05;
    rainMat.uniforms.uCenter.value.copy(target);
    rainMat.uniforms.uSize.value = dist * 1.2;
    rain.visible = rainMat.uniforms.uAmount.value > 0.01;
  }

  return {
    state,
    update,
    setEnabled(v) {
      state.enabled = v;
      if (!v) shared.uCloud.value = 0;
      else if (state.weather) loadWeather();
    },
  };
}
