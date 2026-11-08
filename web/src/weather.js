// Live conditions from free, keyless sources: Open-Meteo for weather, air
// and the sea; the Canadian Hydrographic Service for the tide at Victoria
// Harbour; Environment Canada for official warnings and the AQHI.
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
  const state = { weather: null, tide: null, air: null, sea: null, aqhi: null, warnings: [], enabled: true };

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
        '&current=temperature_2m,apparent_temperature,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation&timezone=America%2FVancouver';
      const c = (await (await fetch(u)).json()).current;
      const dir = (c.wind_direction_10m * Math.PI) / 180;
      // Wind blows from its stated direction; push the sea and clouds the other way.
      shared.uWind.value.set(-Math.sin(dir), -Math.cos(dir)).multiplyScalar(1 + c.wind_speed_10m / 8);
      shared.uCloud.value = c.cloud_cover / 100;
      state.weather = {
        temp: Math.round(c.temperature_2m),
        text: WMO[c.weather_code] || 'unsettled',
        wind: Math.round(c.wind_speed_10m),
        gust: Math.round(c.wind_gusts_10m),
        feels: Math.round(c.apparent_temperature),
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

  // Air quality (Open-Meteo's CAMS model): the US AQI and fine particles.
  // Wildfire smoke shows up as PM2.5; the map's haze takes on its colour.
  async function loadAir() {
    try {
      const u = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=48.43&longitude=-123.37&current=us_aqi,pm2_5';
      const c = (await (await fetch(u)).json()).current;
      state.air = { aqi: Math.round(c.us_aqi), pm: c.pm2_5 };
      onChange(state);
    } catch (e) {
      console.warn('air', e);
    }
  }

  // The sea off Dallas Road: wave height, period and direction, and the
  // water temperature. Wave height also sets how rough the drawn sea is.
  async function loadSea() {
    try {
      const u = 'https://marine-api.open-meteo.com/v1/marine?latitude=48.39&longitude=-123.37' +
        '&current=wave_height,wave_direction,wave_period,sea_surface_temperature';
      const c = (await (await fetch(u)).json()).current;
      state.sea = { h: c.wave_height, dir: COMPASS[Math.round(((c.wave_direction + 180) % 360) / 45) % 8], from: COMPASS[Math.round(c.wave_direction / 45) % 8], period: Math.round(c.wave_period), temp: c.sea_surface_temperature };
      shared.uSea.value = Math.min(3, c.wave_height || 0);
      onChange(state);
    } catch (e) {
      console.warn('sea', e);
    }
  }

  // Environment Canada: the official Air Quality Health Index for
  // Victoria/Saanich, and any weather warning in force for Greater Victoria.
  const GC = 'https://api.weather.gc.ca/collections/';
  async function loadAqhi() {
    try {
      const j = await (await fetch(`${GC}aqhi-observations-realtime/items?f=json&lang=en&location_id=JBOBQ&latest=true&limit=1`)).json();
      const p = j.features?.[0]?.properties;
      if (p) { state.aqhi = { v: p.aqhi, at: p.observation_datetime }; onChange(state); }
    } catch (e) {
      console.warn('aqhi', e);
    }
  }
  async function loadWarnings() {
    try {
      const j = await (await fetch(`${GC}weather-alerts/items?f=json&lang=en&bbox=-123.45,48.4,-123.3,48.5&limit=40`)).json();
      const now = Date.now();
      const seen = new Set();
      state.warnings = j.features.map((f) => f.properties)
        .filter((p) => p.feature_name_en === 'Greater Victoria' && p.status_en !== 'ended' && Date.parse(p.event_end_datetime || p.expiration_datetime) > now)
        .filter((p) => !seen.has(p.alert_name_en) && seen.add(p.alert_name_en))
        .map((p) => ({ name: p.alert_name_en, type: p.alert_type, colour: p.risk_colour_en, until: Date.parse(p.event_end_datetime || p.expiration_datetime), text: p.alert_text_en }));
      onChange(state);
    } catch (e) {
      console.warn('warnings', e);
    }
  }

  loadWeather();
  loadTide();
  loadAir();
  loadSea();
  loadAqhi();
  loadWarnings();
  setInterval(loadAir, 30 * 60e3);
  setInterval(loadSea, 30 * 60e3);
  setInterval(loadAqhi, 30 * 60e3);
  setInterval(loadWarnings, 10 * 60e3);
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
