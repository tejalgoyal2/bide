// The drawn city: terrain painted from OpenStreetMap, roads as ribbons, and an
// animated sea whose foam follows the real coastline.
import * as THREE from 'three';
import { BOUNDS, CORE, toXY } from '../../shared/geo.js';
import { HAZE_GLSL, NOISE_GLSL } from './shaders.js';

const LAND_SEG = 60; // land mesh spacing, metres
export const EXAG = 1.7; // hills are drawn a little taller than life
const [X0, Y0] = toXY(BOUNDS.west, BOUNDS.south);
const [X1, Y1] = toXY(BOUNDS.east, BOUNDS.north);
export const EXTENT = { x0: X0, y0: Y0, w: X1 - X0, h: Y1 - Y0 };

const [cx0, cy0] = toXY(CORE.west, CORE.south);
const [cx1, cy1] = toXY(CORE.east, CORE.north);
export const CORE_C = new THREE.Vector2((cx0 + cx1) / 2, -(cy0 + cy1) / 2);
export const CORE_R = new THREE.Vector2(((cx1 - cx0) / 2) * 1.25, ((cy1 - cy0) / 2) * 1.25);

export const PALETTE = {
  land: '#f1e4c6',
  urban: '#ead2b0',
  campus: '#efdcbc',
  pitch: '#b8d68a',
  green: '#a9cf86',
  forest: '#86b672',
  sand: '#f3dda2',
  airport: '#e2d6bd',
  pier: '#d9c7a5',
  lake: '#7cc4cf',
};

function unpack(d) {
  const out = new Float32Array(d.length);
  let x = 0, y = 0;
  for (let i = 0; i < d.length; i += 2) {
    x += d[i]; y += d[i + 1];
    out[i] = x; out[i + 1] = y;
  }
  return out;
}

// Heights in metres, south row first, lightly blurred so hills read as smooth.
async function loadHeights(url) {
  const img = await createImageBitmap(await (await fetch(url)).blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const c = new OffscreenCanvas(img.width, img.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, img.width, img.height).data;
  const W = img.width, H = img.height;
  const raw = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) raw[(H - 1 - j) * W + i] = px[(j * W + i) * 4] * 2.5;
  }
  const h = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let s = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const a = Math.min(W - 1, Math.max(0, i + di)), b = Math.min(H - 1, Math.max(0, j + dj));
          s += raw[b * W + a]; n++;
        }
      }
      h[j * W + i] = s / n;
    }
  }
  return { W, H, h };
}

// Paints land, parks and lakes into a canvas with the open sea left transparent.
function paintMap(map) {
  const MW = 4096, MH = Math.round((4096 * EXTENT.h) / EXTENT.w);
  const canvas = document.createElement('canvas');
  canvas.width = MW; canvas.height = MH;
  const ctx = canvas.getContext('2d');
  const sx = MW / EXTENT.w, sy = MH / EXTENT.h;
  const trace = (rings) => {
    ctx.beginPath();
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i += 2) {
        const X = (ring[i] - EXTENT.x0) * sx, Y = MH - (ring[i + 1] - EXTENT.y0) * sy;
        i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
      }
      ctx.closePath();
    }
  };
  const polys = (k) => (map.polys[k] || []).map((p) => p.map(unpack));

  ctx.fillStyle = PALETTE.land;
  ctx.strokeStyle = PALETTE.land;
  ctx.lineWidth = 1;
  for (const p of polys('land')) { trace(p); ctx.fill('evenodd'); ctx.stroke(); }

  for (const k of ['urban', 'campus', 'airport', 'pitch', 'green', 'forest', 'sand', 'pier']) {
    ctx.fillStyle = PALETTE[k];
    for (const p of polys(k)) { trace(p); ctx.fill('evenodd'); }
  }

  // Lakes, rivers and pools are painted on; salt water is cut out so the
  // animated sea shows through.
  ctx.fillStyle = PALETTE.lake;
  for (const p of polys('lake')) { trace(p); ctx.fill('evenodd'); }
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  for (const p of polys('sea')) { trace(p); ctx.fill('evenodd'); }
  ctx.globalCompositeOperation = 'source-over';
  return canvas;
}

// Distance to the coast, both ways, from the painted map's alpha (chamfer
// distance transform). R: metres of sea to the nearest land, B: metres of land
// to the nearest sea, G: land mask.
function coastField(mapCanvas) {
  const W = 1024, H = Math.round((1024 * mapCanvas.height) / mapCanvas.width);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(mapCanvas, 0, 0, W, H);
  const a = ctx.getImageData(0, 0, W, H).data;
  const land = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) land[(H - 1 - j) * W + i] = a[(j * W + i) * 4 + 3] > 127 ? 1 : 0;
  const dt = (inside) => {
    const INF = 1e9, d = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) d[i] = land[i] === inside ? INF : 0;
    const k1 = 1, k2 = Math.SQRT2;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const p = j * W + i;
        if (!d[p]) continue;
        let v = d[p];
        if (i > 0) v = Math.min(v, d[p - 1] + k1);
        if (j > 0) {
          v = Math.min(v, d[p - W] + k1);
          if (i > 0) v = Math.min(v, d[p - W - 1] + k2);
          if (i < W - 1) v = Math.min(v, d[p - W + 1] + k2);
        }
        d[p] = v;
      }
    }
    for (let j = H - 1; j >= 0; j--) {
      for (let i = W - 1; i >= 0; i--) {
        const p = j * W + i;
        if (!d[p]) continue;
        let v = d[p];
        if (i < W - 1) v = Math.min(v, d[p + 1] + k1);
        if (j < H - 1) {
          v = Math.min(v, d[p + W] + k1);
          if (i < W - 1) v = Math.min(v, d[p + W + 1] + k2);
          if (i > 0) v = Math.min(v, d[p + W - 1] + k2);
        }
        d[p] = v;
      }
    }
    return d;
  };
  const sea = dt(0), inland = dt(1);
  const mpp = EXTENT.w / W;
  const out = new Uint8Array(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    out[p * 4] = Math.min(255, Math.sqrt((sea[p] * mpp) / 4000) * 255);
    out[p * 4 + 1] = land[p] * 255;
    out[p * 4 + 2] = Math.min(255, Math.sqrt((inland[p] * mpp) / 4000) * 255);
    out[p * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(out, W, H, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export const shared = {
  uTime: { value: 0 },
  uSun: { value: new THREE.Vector3(0.3, 0.8, 0.2).normalize() },
  uSunColor: { value: new THREE.Color(1, 0.96, 0.88) },
  uAmbient: { value: new THREE.Color(0.55, 0.58, 0.66) },
  uHaze: { value: new THREE.Color('#efe3cf') },
  uNight: { value: 0 },
  uCloud: { value: 0.3 },
  uWind: { value: new THREE.Vector2(3, 1) },
  uCamPos: { value: new THREE.Vector3() },
  uFogDist: { value: 20000 },
  uCoreC: { value: CORE_C },
  uCoreR: { value: CORE_R },
  uRise: { value: 0 },
  uExag: { value: EXAG },
  uExtent: { value: new THREE.Vector4(EXTENT.x0, EXTENT.y0, EXTENT.w, EXTENT.h) },
  uMpp: { value: 2 },
  uSea: { value: 0.5 }, // wave height offshore, metres
};

export async function createWorld(scene, map) {
  const H = await loadHeights('/data/height.png');
  const heightAt = (x, y) => {
    const u = ((x - EXTENT.x0) / EXTENT.w) * (H.W - 1);
    const v = ((y - EXTENT.y0) / EXTENT.h) * (H.H - 1);
    if (u < 0 || v < 0 || u > H.W - 1 || v > H.H - 1) return 0;
    const i = Math.floor(u), j = Math.floor(v), fx = u - i, fy = v - j;
    const at = (a, b) => H.h[Math.min(H.H - 1, b) * H.W + Math.min(H.W - 1, a)];
    return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy;
  };
  // Height of the drawn surface at a map point. The land mesh has a vertex
  // every 60 m and is flat between them, so on a convex street it sits
  // metres off the true height: interpolate between the mesh's own corners,
  // or buses and pins sink into (or float over) the ground they're on.
  const LAND_NX = Math.round(EXTENT.w / LAND_SEG), LAND_NY = Math.round(EXTENT.h / LAND_SEG);
  const cellX = EXTENT.w / LAND_NX, cellY = EXTENT.h / LAND_NY;
  const meshHeight = (x, y) => {
    const gx = (x - EXTENT.x0) / cellX, gy = (y - EXTENT.y0) / cellY;
    const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
    const h = (a, b) => heightAt(EXTENT.x0 + a * cellX, EXTENT.y0 + b * cellY);
    return (h(i, j) * (1 - fx) + h(i + 1, j) * fx) * (1 - fy) + (h(i, j + 1) * (1 - fx) + h(i + 1, j + 1) * fx) * fy;
  };
  const surfaceY = (x, y) => meshHeight(x, y) * EXAG * shared.uRise.value;

  const half = new Uint16Array(H.h.length);
  for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(H.h[i]);
  const heightTex = new THREE.DataTexture(half, H.W, H.H, THREE.RedFormat, THREE.HalfFloatType);
  heightTex.minFilter = THREE.LinearFilter;
  heightTex.magFilter = THREE.LinearFilter;
  heightTex.needsUpdate = true;
  shared.uHeight = { value: heightTex };
  shared.uHeightTexel = { value: new THREE.Vector2(1 / H.W, 1 / H.H) };

  const mapCanvas = paintMap(map);
  const mapTex = new THREE.CanvasTexture(mapCanvas);
  mapTex.colorSpace = THREE.SRGBColorSpace;
  mapTex.anisotropy = 8;
  mapTex.generateMipmaps = true;
  mapTex.minFilter = THREE.LinearMipmapLinearFilter;
  const coastTex = coastField(mapCanvas);
  shared.uCoast = { value: coastTex };

  const group = new THREE.Group();
  scene.add(group);

  // --- sea -------------------------------------------------------------
  const seaGeo = new THREE.PlaneGeometry(400000, 400000, 1, 1).rotateX(-Math.PI / 2);
  const seaMat = new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uDeep: { value: new THREE.Color('#2c6f8c') },
      uShallow: { value: new THREE.Color('#69c2c4') },
      uFoam: { value: new THREE.Color('#fbf6e9') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uDeep, uShallow, uFoam;
      uniform sampler2D uCoast;
      uniform float uSea;
      varying vec3 vWorld;
      ${NOISE_GLSL}
      ${HAZE_GLSL}
      void main() {
        vec2 m = vec2(vWorld.x, -vWorld.z);
        vec2 uv = (m - uExtent.xy) / uExtent.zw;
        float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
        vec4 c = texture2D(uCoast, clamp(uv, 0.0, 1.0));
        float r = mix(1.0, c.r, inside);
        float d = r * r * 4000.0;              // metres to the nearest shore
        float t = uTime;

        // Gentle swell: two layers of drifting noise give the surface normal.
        vec2 p = m * 0.012;
        float e = 0.6;
        float n0 = fbm(p + uWind * t * 0.02);
        float nx = fbm(p + vec2(e, 0.0) + uWind * t * 0.02) - n0;
        float ny = fbm(p + vec2(0.0, e) + uWind * t * 0.02) - n0;
        // The live wave height (Open-Meteo marine) sets how rough it looks.
        float rough = 1.4 + uSea * 1.3;
        vec3 nrm = normalize(vec3(-nx * rough, 1.0, ny * rough));

        vec3 col = mix(uShallow, uDeep, smoothstep(10.0, 1400.0, d));
        col = mix(col, uDeep * 0.85, smoothstep(2500.0, 4000.0, d));

        // Foam: a bright lip on the shore and soft bands rolling in.
        float wob = noise(m * 0.02 + t * 0.15) * 14.0;
        float lip = 1.0 - smoothstep(3.0, 16.0 + wob * 0.6, d);
        float band = sin((d + wob) * 0.075 + t * 1.3);
        float bands = smoothstep(0.82, 1.0, band) * (1.0 - smoothstep(15.0, 90.0 + uSea * 120.0, d)) * (0.45 + uSea * 0.3);
        // Whitecaps offshore once the waves pass about a metre.
        float caps = smoothstep(0.8 - 0.06 * uSea, 0.84, noise(m * 0.03 + uWind * t * 0.05) * noise(m * 0.011 - t * 0.05) * 1.6)
          * smoothstep(0.7, 1.6, uSea) * smoothstep(150.0, 500.0, d) * 0.7;
        float foam = clamp((lip + bands) * inside + caps, 0.0, 1.0);

        vec3 view = normalize(uCamPos - vWorld);
        float diff = 0.75 + 0.25 * max(dot(nrm, uSun), 0.0);
        col *= mix(vec3(1.0), uSunColor, 0.4) * diff;
        vec3 h = normalize(view + uSun);
        float spec = pow(max(dot(nrm, h), 0.0), 220.0) * (1.0 - uNight * 0.6);
        float fres = pow(1.0 - max(view.y, 0.0), 4.0);
        col = mix(col, uHaze, fres * 0.35);
        col += uSunColor * spec * 1.2;
        col = mix(col, uFoam * mix(vec3(1.0), uAmbient * 1.4, uNight), foam);
        col = mix(col, col * vec3(0.16, 0.2, 0.36), uNight * 0.9);
        gl_FragColor = vec4(applyHaze(col, vWorld), 1.0);
        #include <colorspace_fragment>
      }`,
    depthWrite: false,
  });
  const sea = new THREE.Mesh(seaGeo, seaMat);
  sea.renderOrder = 0;
  group.add(sea);

  // --- land ------------------------------------------------------------
  const nx = LAND_NX, ny = LAND_NY;
  const landGeo = new THREE.PlaneGeometry(EXTENT.w, EXTENT.h, nx, ny).rotateX(-Math.PI / 2);
  landGeo.translate(EXTENT.x0 + EXTENT.w / 2, 0, -(EXTENT.y0 + EXTENT.h / 2));
  const landMat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uMap: { value: mapTex } },
    vertexShader: /* glsl */ `
      uniform sampler2D uHeight;
      uniform float uExag, uRise;
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vUv = uv;
        vec3 p = position;
        p.y = texture2D(uHeight, uv).r * uExag * uRise;
        vec4 w = modelMatrix * vec4(p, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap, uHeight, uCoast;
      uniform vec2 uHeightTexel;
      uniform float uExag, uRise;
      varying vec2 vUv;
      varying vec3 vWorld;
      ${NOISE_GLSL}
      ${HAZE_GLSL}
      void main() {
        vec4 m = texture2D(uMap, vUv);
        if (m.a < 0.5) discard;
        vec4 c = texture2D(uCoast, vUv);

        float cell = uExtent.z * uHeightTexel.x;
        float hl = texture2D(uHeight, vUv - vec2(uHeightTexel.x, 0.0)).r;
        float hr = texture2D(uHeight, vUv + vec2(uHeightTexel.x, 0.0)).r;
        float hd = texture2D(uHeight, vUv - vec2(0.0, uHeightTexel.y)).r;
        float hu = texture2D(uHeight, vUv + vec2(0.0, uHeightTexel.y)).r;
        float k = uExag * uRise * 1.6 / (2.0 * cell);
        vec3 n = normalize(vec3((hl - hr) * k, 1.0, (hu - hd) * k));
        float lambert = max(dot(n, uSun), 0.0);
        float toon = mix(smoothstep(0.15, 0.75, lambert), lambert, 0.5);
        vec3 col = m.rgb * (uAmbient + uSunColor * toon * 0.62);

        // Faint contour lines every 20 m, like an old survey sheet.
        float h = texture2D(uHeight, vUv).r;
        float ch = h / 20.0;
        float cl = abs(fract(ch - 0.5) - 0.5) / max(fwidth(ch), 1e-4);
        col *= 1.0 - 0.07 * (1.0 - min(cl, 1.0)) * smoothstep(8.0, 25.0, h);

        // A pencil line along the coast and a pale sandy rim inside it.
        float inland = c.b * c.b * 4000.0;
        col = mix(col, vec3(0.98, 0.93, 0.78), (1.0 - smoothstep(10.0, 45.0, inland)) * 0.55);
        col = mix(col, vec3(0.45, 0.38, 0.3), (1.0 - smoothstep(0.0, 9.0, inland)) * 0.55);

        // Paper grain and drifting cloud shadows.
        vec2 w = vec2(vWorld.x, -vWorld.z);
        col *= 0.97 + 0.05 * noise(w * 0.35);
        float cloud = smoothstep(0.45, 0.8, fbm(w * 0.00028 + uWind * uTime * 0.0012));
        col *= 1.0 - cloud * uCloud * 0.32;

        // At night the city dims to ink blue.
        col = mix(col, col * vec3(0.16, 0.19, 0.33), uNight * 0.92);
        gl_FragColor = vec4(applyHaze(col, vWorld), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const land = new THREE.Mesh(landGeo, landMat);
  land.renderOrder = 1;
  group.add(land);

  group.add(buildRoads(map));

  return { group, heightAt, meshHeight, surfaceY, mapCanvas };
}

// Roads are ribbons whose width never drops below a pixel or two, so the
// street grid stays crisp at every zoom. Each road draws twice: a darker
// casing, then the fill on top.
const ROAD = {
  //         width m, min px, casing px, fill, casing, night glow, lift
  highway: [17, 2.6, 1.2, '#f7d48a', '#bf8f45', 0.8, 3.2],
  major: [11, 2.0, 1.1, '#ffffff', '#b8a487', 0.46, 3.0],
  medium: [8.5, 1.5, 0.9, '#fffefa', '#c4b399', 0.24, 2.8],
  minor: [6, 0.9, 0.6, '#fdfaf3', '#d2c4ad', 0.04, 2.6],
  path: [1.8, 0.35, 0, '#f4ead7', '#f4ead7', 0.0, 2.4],
  rail: [2.4, 0.6, 0, '#a0907e', '#a0907e', 0.1, 2.5],
  ferry: [3, 0.9, 0, '#fdfbf4', '#fdfbf4', 0.25, 1.0],
};

function buildRoads(map) {
  const group = new THREE.Group();
  const order = ['path', 'rail', 'minor', 'medium', 'major', 'highway', 'ferry'];
  order.forEach((cls, ci) => {
    const lines = map.lines[cls];
    if (!lines) return;
    const [width, minPx, casePx, fill, casing, glow, lift] = ROAD[cls];
    const pos = [], miter = [], dist = [], idx = [];
    for (const d of lines) {
      const raw = unpack(d);
      // Split long segments so the ribbon can follow the hills.
      const pts = [];
      for (let i = 0; i < raw.length - 2; i += 2) {
        const ax = raw[i], ay = raw[i + 1], bx = raw[i + 2], by = raw[i + 3];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 45));
        for (let s = 0; s < n; s++) pts.push(ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n);
      }
      pts.push(raw[raw.length - 2], raw[raw.length - 1]);
      const np = pts.length / 2;
      if (np < 2) continue;
      const base = pos.length / 3;
      let along = 0;
      for (let i = 0; i < np; i++) {
        const x = pts[2 * i], y = pts[2 * i + 1];
        const pi = Math.max(0, i - 1), ni = Math.min(np - 1, i + 1);
        let dx0 = x - pts[2 * pi], dy0 = y - pts[2 * pi + 1];
        let dx1 = pts[2 * ni] - x, dy1 = pts[2 * ni + 1] - y;
        const l0 = Math.hypot(dx0, dy0) || 1, l1 = Math.hypot(dx1, dy1) || 1;
        if (i === 0) { dx0 = dx1; dy0 = dy1; }
        if (i === np - 1) { dx1 = dx0; dy1 = dy0; }
        dx0 /= i === 0 ? l1 : l0; dy0 /= i === 0 ? l1 : l0;
        dx1 /= i === np - 1 ? l0 : l1; dy1 /= i === np - 1 ? l0 : l1;
        let tx = dx0 + dx1, ty = dy0 + dy1;
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl; ty /= tl;
        // The miter normal, lengthened at corners but never past 2x.
        const nx = -ty, ny = tx;
        const dot = nx * -dy1 + ny * dx1;
        const scale = Math.min(2, 1 / Math.max(0.5, Math.abs(dot) || 1));
        if (i > 0) along += Math.hypot(x - pts[2 * i - 2], y - pts[2 * i - 1]);
        for (const side of [-1, 1]) {
          pos.push(x, 0, -y);
          miter.push(nx * scale * side, -ny * scale * side);
          dist.push(along);
        }
        if (i < np - 1) {
          const a = base + i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('miter', new THREE.Float32BufferAttribute(miter, 2));
    geo.setAttribute('along', new THREE.Float32BufferAttribute(dist, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mk = (color, extraPx, order, dashed) =>
      new THREE.ShaderMaterial({
        uniforms: {
          ...shared,
          uColor: { value: new THREE.Color(color) },
          uWidth: { value: width },
          uMinPx: { value: minPx },
          uExtraPx: { value: extraPx },
          uGlow: { value: glow },
          uLift: { value: lift },
          uFade: { value: cls === 'path' ? 1 : cls === 'minor' ? 0.6 : 0 },
          uDash: { value: dashed ? 1 : 0 },
          uOnSea: { value: cls === 'ferry' ? 1 : 0 },
        },
        vertexShader: /* glsl */ `
          uniform sampler2D uHeight;
          uniform vec4 uExtent;
          uniform float uExag, uRise, uWidth, uMinPx, uExtraPx, uMpp, uLift, uOnSea;
          attribute vec2 miter;
          attribute float along;
          varying vec3 vWorld;
          varying float vAlong;
          void main() {
            vec2 uv = (vec2(position.x, -position.z) - uExtent.xy) / uExtent.zw;
            float h = uOnSea > 0.5 ? 0.0 : texture2D(uHeight, uv).r * uExag * uRise;
            // Streets slim down at street level, where buildings stand beside them.
            float w = max(uWidth * mix(0.6, 1.0, smoothstep(0.8, 4.0, uMpp)), uMinPx * uMpp) * 0.5 + uExtraPx * uMpp * 0.5;
            vec3 p = position + vec3(miter.x, 0.0, miter.y) * w;
            p.y = h + uLift * max(1.0, uMpp * 0.6);
            vec4 wp = modelMatrix * vec4(p, 1.0);
            vWorld = wp.xyz;
            vAlong = along;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform float uGlow, uFade, uDash, uMpp, uOnSea;
          varying vec3 vWorld;
          varying float vAlong;
          ${HAZE_GLSL}
          void main() {
            if (uDash > 0.5 && fract(vAlong / max(60.0, uMpp * 14.0)) > 0.55) discard;
            vec3 day = uColor * (uAmbient * 0.5 + uSunColor * 0.55);
            // At night streets sink into the dark; lit roads carry a row of
            // sodium lamps, visible as pearls of light once you're close.
            float lamps = 0.78 + 0.45 * pow(0.5 + 0.5 * cos(vAlong * 6.2832 / 36.0), 10.0) * (1.0 - smoothstep(1.2, 3.5, uMpp));
            vec3 night = mix(uColor * vec3(0.2, 0.22, 0.34), vec3(1.0, 0.74, 0.46) * lamps, uGlow);
            vec3 col = mix(day, night, uNight);
            // Small streets fade out when seen from far away.
            float a = 1.0 - uFade * smoothstep(3.0, 9.0, uMpp);
            // Ferry routes are a whisper on the water, not a road.
            a *= mix(1.0, 0.4 * smoothstep(2.0, 6.0, uMpp), uOnSea); // and fade out up close
            if (a < 0.02) discard;
            gl_FragColor = vec4(applyHaze(col, vWorld), a);
            #include <colorspace_fragment>
          }`,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
    if (casePx > 0) {
      const c = new THREE.Mesh(geo, mk(casing, casePx, 0, false));
      c.renderOrder = 2 + ci * 2;
      c.frustumCulled = false;
      group.add(c);
    }
    const f = new THREE.Mesh(geo, mk(fill, 0, 1, cls === 'ferry' || cls === 'rail'));
    f.renderOrder = 3 + ci * 2;
    f.frustumCulled = false;
    group.add(f);
  });
  return group;
}
