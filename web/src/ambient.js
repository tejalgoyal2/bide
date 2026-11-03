// Ambient life: the things that make Victoria's waterfront feel like itself,
// drawn from how the city actually moves rather than from a live feed.
//   Floatplanes take off from and land on the Inner Harbour water runway.
//   Little harbour ferries potter between their Inner Harbour stops.
//   The Coho sails out past Ogden Point for Port Angeles and back.
//   Sailboats tack about the bays; gulls wheel over the shore.
// Everything is drawn a little larger than life so it reads from afar, and
// fades with the haze like the rest of the map.
import * as THREE from 'three';
import { toXY } from '../../shared/geo.js';
import { shared, EXTENT } from './world.js';

const ll = (lon, lat, h = 0) => {
  const [x, y] = toXY(lon, lat);
  return new THREE.Vector3(x, h, -y);
};

// --- water mask, from the painted map's land alpha -------------------------
function waterMask(mapCanvas) {
  const W = 1024, H = Math.round((W * mapCanvas.height) / mapCanvas.width);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(mapCanvas, 0, 0, W, H);
  const a = ctx.getImageData(0, 0, W, H).data;
  return (x, z) => {
    const i = Math.floor(((x - EXTENT.x0) / EXTENT.w) * W);
    const j = Math.floor((1 - (-z - EXTENT.y0) / EXTENT.h) * H);
    if (i < 0 || j < 0 || i >= W || j >= H) return true;
    return a[(j * W + i) * 4 + 3] < 128;
  };
}

// --- shapes (top views, nose toward -z, one unit long) ----------------------
function planeShape() {
  const half = [[0, -0.5], [0.06, -0.38], [0.06, -0.16], [0.56, -0.13], [0.56, 0.04], [0.06, 0.06], [0.05, 0.34], [0.2, 0.4], [0.2, 0.47], [0, 0.45]];
  const s = new THREE.Shape();
  half.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  for (let i = half.length - 2; i > 0; i--) s.lineTo(-half[i][0], half[i][1]);
  return new THREE.ShapeGeometry(s).rotateX(Math.PI / 2);
}
function hullShape(beam = 0.32) {
  const s = new THREE.Shape();
  s.moveTo(0, -0.5);
  s.quadraticCurveTo(beam / 2, -0.25, beam / 2, 0.15);
  s.lineTo(beam * 0.4, 0.5);
  s.lineTo(-beam * 0.4, 0.5);
  s.lineTo(-beam / 2, 0.15);
  s.quadraticCurveTo(-beam / 2, -0.25, 0, -0.5);
  return new THREE.ShapeGeometry(s).rotateX(Math.PI / 2);
}
function sailShape() {
  // A vertical triangle along the boat's length, mast at the middle.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.05, -0.05, 0, 1.25, -0.02, 0, 0.05, 0.42], 3));
  g.setIndex([0, 1, 2]);
  return g;
}
function birdShape() {
  // A gull from above-ish: two swept wings, the tips flap in the shader.
  const v = [0, 0, -0.18, -0.5, 0, 0.12, 0, 0, 0.08, 0, 0, -0.18, 0.5, 0, 0.12, 0, 0, 0.08];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}

// --- routes -------------------------------------------------------------------
// Inner Harbour water runway (CYWH): taxi out from the floats by the Steamship
// Terminal, run west down the harbour, lift off past Ogden Point, and climb out
// over the strait before turning east along the shore toward Vancouver.
const FLOAT_PATH = [
  ll(-123.3702, 48.4232, 0), ll(-123.3740, 48.4236, 0), ll(-123.3790, 48.4227, 0), ll(-123.3860, 48.4207, 0),
  ll(-123.3935, 48.4180, 8), ll(-123.4000, 48.4120, 90), ll(-123.3950, 48.4000, 260), ll(-123.3650, 48.3930, 420),
  ll(-123.3150, 48.3990, 560), ll(-123.2600, 48.4230, 700), ll(-123.2000, 48.4700, 850),
];
const FLOAT_WATER = 0.43; // fraction of the path (by length) still on the water
const COHO_PATH = [
  ll(-123.3735, 48.4238), ll(-123.3800, 48.4226), ll(-123.3880, 48.4200), ll(-123.3955, 48.4150),
  ll(-123.3960, 48.4040), ll(-123.3900, 48.3800), ll(-123.3800, 48.3500),
];
const PICKLE_STOPS = [
  [-123.3696, 48.4224], [-123.3745, 48.4247], [-123.3790, 48.4262], [-123.3830, 48.4228], [-123.3760, 48.4214],
].map(([lo, la]) => ll(lo, la));
const GULL_SPOTS = [
  [-123.372, 48.423], [-123.392, 48.414], [-123.349, 48.404], [-123.303, 48.424], [-123.283, 48.454], [-123.414, 48.428],
].map(([lo, la]) => ll(lo, la));

const curveOf = (pts) => {
  const c = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  c.arcLengthDivisions = 400;
  return c;
};

export function createAmbient(scene, world) {
  const isWater = waterMask(world.mapCanvas);
  const group = new THREE.Group();
  scene.add(group);
  // Hulls and fuselages dim to ink at night; their lights don't.
  const tinted = [];
  const fadeMat = (color, opacity = 1) => {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: opacity === 1, side: THREE.DoubleSide, fog: false });
    tinted.push([m, new THREE.Color(color)]);
    return m;
  };
  const dotGeo = new THREE.CircleGeometry(1, 12).rotateX(-Math.PI / 2);
  const light = (color, r, x, y, z) => {
    const m = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false }));
    m.scale.setScalar(r);
    m.position.set(x, y, z);
    m.renderOrder = 31;
    m.userData.light = true;
    return m;
  };
  const nightTint = new THREE.Color();

  // Wakes: one pool of foam dots, each fading over a few seconds.
  const FOAM = 1400;
  const foamPos = new Float32Array(FOAM * 3), foamBirth = new Float32Array(FOAM).fill(-99), foamLife = new Float32Array(FOAM).fill(1);
  const foamGeo = new THREE.BufferGeometry();
  foamGeo.setAttribute('position', new THREE.BufferAttribute(foamPos, 3).setUsage(THREE.DynamicDrawUsage));
  foamGeo.setAttribute('birth', new THREE.BufferAttribute(foamBirth, 1).setUsage(THREE.DynamicDrawUsage));
  foamGeo.setAttribute('life', new THREE.BufferAttribute(foamLife, 1).setUsage(THREE.DynamicDrawUsage));
  const foam = new THREE.Points(
    foamGeo,
    new THREE.ShaderMaterial({
      uniforms: { uTime: shared.uTime, uNight: shared.uNight, uPx: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float birth; attribute float life;
        uniform float uTime, uPx;
        varying float vA;
        void main() {
          float age = (uTime - birth) / life;
          vA = age < 0.0 || age > 1.0 ? 0.0 : (1.0 - age) * (1.0 - age);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uPx * (1.0 + age * 1.6);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uNight;
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = (1.0 - smoothstep(0.2, 0.5, d)) * vA * mix(0.85, 0.35, uNight);
          if (a < 0.01) discard;
          gl_FragColor = vec4(1.0, 0.99, 0.96, a);
        }`,
      transparent: true,
      depthWrite: false,
    }),
  );
  foam.frustumCulled = false;
  foam.renderOrder = 6;
  group.add(foam);
  let foamI = 0, foamDirty = false;
  const spray = (x, z, spread, life, t) => {
    const i = foamI++ % FOAM;
    foamPos[i * 3] = x + (Math.random() - 0.5) * spread;
    foamPos[i * 3 + 1] = 0.6;
    foamPos[i * 3 + 2] = z + (Math.random() - 0.5) * spread;
    foamBirth[i] = t;
    foamLife[i] = life;
    foamDirty = true;
  };

  // --- floatplanes ---------------------------------------------------------
  const floatCurve = curveOf(FLOAT_PATH);
  const floatLen = floatCurve.getLength();
  const planeGeo = planeShape();
  const planes = [];
  const livery = ['#fbf8f0', '#fbf8f0', '#f3d27a', '#e9eef2'];
  for (let i = 0; i < 2; i++) {
    const body = new THREE.Mesh(planeGeo, fadeMat(livery[i]));
    const stripe = new THREE.Mesh(planeGeo, fadeMat('#2f6f8f'));
    stripe.scale.set(0.35, 1, 0.9);
    stripe.position.y = 0.02;
    body.add(stripe);
    const fin = new THREE.Mesh(sailShape(), fadeMat(livery[i]));
    fin.scale.set(1, 0.16, 0.42);
    fin.position.z = 0.24;
    body.add(fin);
    body.add(light('#ff4a3d', 0.035, -0.56, 0.05, -0.04), light('#3dff8a', 0.035, 0.56, 0.05, -0.04));
    const strobe = light('#ffffff', 0.05, 0, 0.12, 0.44);
    body.add(strobe);
    const shadow = new THREE.Mesh(planeGeo, fadeMat('#20303a', 0.22));
    body.renderOrder = 24; stripe.renderOrder = 25; shadow.renderOrder = 7;
    group.add(body, shadow);
    planes.push({ body, shadow, strobe, s: 0, dir: i ? -1 : 1, wait: 6 + i * 22, active: false });
  }
  // Speed along the path: taxi, take-off run, climb-out (m/s, drawn a bit brisk).
  const floatSpeed = (u) => (u < 0.12 ? 7 : u < FLOAT_WATER ? 7 + ((u - 0.12) / (FLOAT_WATER - 0.12)) * 45 : 62);

  // --- boats ------------------------------------------------------------------
  const hullGeo = hullShape(), sailGeo = sailShape(), bigHull = hullShape(0.22);
  const boats = [];
  const addBoat = (kind, x, z, heading) => {
    const g = new THREE.Group();
    const hull = new THREE.Mesh(kind === 'coho' ? bigHull : hullGeo, fadeMat(kind === 'pickle' ? '#f2c94c' : kind === 'coho' ? '#f4f1ea' : '#fbf8f0'));
    hull.renderOrder = 12;
    g.add(hull);
    if (kind === 'sail') {
      const sail = new THREE.Mesh(sailGeo, fadeMat('#fffdf7'));
      sail.renderOrder = 13;
      g.add(sail);
      g.userData.sail = sail;
    }
    if (kind === 'coho') {
      const deck = new THREE.Mesh(bigHull, fadeMat('#1f3a5a'));
      deck.scale.set(0.7, 1, 0.55);
      deck.position.set(0, 0.06, 0.08);
      deck.renderOrder = 13;
      g.add(deck);
    }
    group.add(g);
    const b = { kind, g, x, z, heading, speed: kind === 'sail' ? 3 + Math.random() * 2 : 4, turn: 0, alpha: 0, s: 0, leg: 0, wait: 0 };
    boats.push(b);
    return b;
  };
  // Sailboats: scattered over open water near the city's shore.
  const bays = [[-123.33, 48.405], [-123.29, 48.43], [-123.27, 48.46], [-123.41, 48.415], [-123.36, 48.398], [-123.30, 48.41], [-123.43, 48.42], [-123.255, 48.44]];
  for (const [lo, la] of bays) {
    for (let k = 0; k < 20; k++) {
      const p = ll(lo + (Math.random() - 0.5) * 0.02, la + (Math.random() - 0.5) * 0.01);
      if (isWater(p.x, p.z) && isWater(p.x + 120, p.z) && isWater(p.x - 120, p.z)) { addBoat('sail', p.x, p.z, Math.random() * 6.28); break; }
    }
  }
  const pickleCurve = curveOf([...PICKLE_STOPS, PICKLE_STOPS[0]]);
  const pickleLen = pickleCurve.getLength();
  const pickles = [0, 0.37, 0.71].map((s) => Object.assign(addBoat('pickle', 0, 0, 0), { s: s * pickleLen, speed: 2.4 }));
  const cohoCurve = curveOf(COHO_PATH);
  const cohoLen = cohoCurve.getLength();
  const coho = Object.assign(addBoat('coho', 0, 0, 0), { s: 0, dir: 1, wait: 20, speed: 7 });

  // --- gulls ------------------------------------------------------------------
  const BIRDS = 42;
  const birdMat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uNight: shared.uNight, uFade: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      void main() {
        vec3 p = position;
        float ph = float(gl_InstanceID) * 1.73;
        // Flap in bursts, glide in between.
        float flap = sin(uTime * 9.0 + ph) * smoothstep(0.2, 0.7, sin(uTime * 0.7 + ph * 0.5));
        p.y += abs(p.x) * (0.55 * flap + 0.12);
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight, uFade;
      void main() {
        gl_FragColor = vec4(mix(vec3(0.98, 0.97, 0.94), vec3(0.75, 0.78, 0.86), uNight), uFade);
      }`,
    side: THREE.DoubleSide,
    transparent: true,
  });
  const birds = new THREE.InstancedMesh(birdShape(), birdMat, BIRDS);
  birds.frustumCulled = false;
  birds.renderOrder = 26;
  group.add(birds);
  const flock = Array.from({ length: BIRDS }, (_, i) => ({
    home: GULL_SPOTS[i % GULL_SPOTS.length],
    r: 120 + Math.random() * 260,
    w: (0.05 + Math.random() * 0.05) * (Math.random() < 0.5 ? -1 : 1),
    a: Math.random() * 6.28,
    h: 40 + Math.random() * 110,
    drift: Math.random() * 6.28,
  }));

  // --- animation -------------------------------------------------------------
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p = new THREE.Vector3(), tan = new THREE.Vector3();
  let enabled = true, fade = 1;
  const yaw = (dx, dz) => Math.atan2(-dx, -dz); // nose is -z

  function update(dt, mpp, t) {
    fade += ((enabled ? 1 : 0) - fade) * Math.min(1, dt * 2);
    group.visible = fade > 0.02;
    if (!group.visible) return;
    // Everything is drawn larger than life, but never below a few pixels.
    const boost = (metres, px) => Math.max(metres, px * mpp);
    foam.material.uniforms.uPx.value = THREE.MathUtils.clamp(4 / Math.sqrt(mpp), 1.2, 4) * Math.min(2, devicePixelRatio);

    const night = shared.uNight.value, lightLevel = 0.25 + 0.75 * night;
    nightTint.setRGB(1 - 0.72 * night, 1 - 0.68 * night, 1 - 0.5 * night);
    for (const [m, c] of tinted) m.color.copy(c).multiply(nightTint);

    // Floatplanes.
    for (const pl of planes) {
      if (!pl.active) {
        pl.wait -= dt;
        pl.body.visible = pl.shadow.visible = false;
        if (pl.wait <= 0) Object.assign(pl, { active: true, s: 0 });
        continue;
      }
      // dir 1 takes off along the path; dir -1 flies it backwards to land.
      const u0 = pl.s / floatLen;
      const u = pl.dir > 0 ? u0 : 1 - u0;
      pl.s += floatSpeed(u) * dt;
      if (pl.s >= floatLen) {
        Object.assign(pl, { active: false, wait: 25 + Math.random() * 35, dir: -pl.dir });
        continue;
      }
      floatCurve.getPointAt(u, p);
      floatCurve.getTangentAt(u, tan).multiplyScalar(pl.dir);
      const size = boost(16, 16);
      const edge = Math.min(1, u0 * 12, (1 - u0) * 6);
      const a = edge * fade;
      pl.body.visible = pl.shadow.visible = a > 0.01;
      pl.body.position.set(p.x, p.y + 1.2, p.z);
      // Nose up on the climb, down on the approach.
      e.set(Math.asin(THREE.MathUtils.clamp(tan.y, -0.3, 0.3)) * 0.8, yaw(tan.x, tan.z), 0, 'YXZ');
      pl.body.rotation.copy(e);
      pl.body.scale.setScalar(size);
      pl.shadow.position.set(p.x + p.y * 0.35, 0.8, p.z + p.y * 0.2);
      pl.shadow.rotation.set(0, e.y, 0);
      pl.shadow.scale.setScalar(size);
      pl.body.traverse((m) => m.material && (m.material.opacity = m.userData.light ? a * lightLevel : a));
      pl.strobe.material.opacity = a * (Math.sin(t * 9 + pl.dir * 1.3) > 0.85 ? 1 : 0.1);
      pl.shadow.material.opacity = 0.22 * a * Math.max(0.15, 1 - p.y / 900);
      if (p.y < 10 && floatSpeed(u) > 6) for (let k = 0; k < 2; k++) spray(p.x - tan.x * size * 0.4, p.z - tan.z * size * 0.4, size * 0.35, 4 + Math.random() * 3, t);
    }

    // Harbour ferries: round their stops, pausing at each one.
    for (const b of pickles) {
      if (b.wait > 0) b.wait -= dt;
      else {
        const before = Math.floor((b.s / pickleLen) * PICKLE_STOPS.length);
        b.s = (b.s + b.speed * dt) % pickleLen;
        const after = Math.floor((b.s / pickleLen) * PICKLE_STOPS.length);
        if (after !== before) b.wait = 10 + Math.random() * 8;
      }
      const u = b.s / pickleLen;
      pickleCurve.getPointAt(u, p);
      pickleCurve.getTangentAt(u, tan);
      b.x = p.x; b.z = p.z; b.heading = yaw(tan.x, tan.z);
      b.size = boost(8, 9);
      if (b.wait <= 0 && Math.random() < dt * 6) spray(b.x - tan.x * b.size * 0.5, b.z - tan.z * b.size * 0.5, b.size * 0.2, 3, t);
    }

    // The Coho: out to the strait and back, a long pause at the terminal.
    if (coho.wait > 0) coho.wait -= dt;
    else {
      coho.s += coho.speed * dt;
      if (coho.s >= cohoLen) Object.assign(coho, { s: 0, dir: -coho.dir, wait: coho.dir > 0 ? 30 : 90 });
    }
    {
      const u0 = coho.s / cohoLen, u = coho.dir > 0 ? u0 : 1 - u0;
      cohoCurve.getPointAt(u, p);
      cohoCurve.getTangentAt(u, tan).multiplyScalar(coho.dir);
      coho.x = p.x; coho.z = p.z; coho.heading = yaw(tan.x, tan.z);
      coho.size = boost(105, 22);
      coho.edge = coho.dir > 0 ? Math.min(1, (1 - u0) * 5) : Math.min(1, u0 * 5);
      if (coho.wait <= 0 && Math.random() < dt * 20) spray(coho.x - tan.x * coho.size * 0.5, coho.z - tan.z * coho.size * 0.5, coho.size * 0.25, 7, t);
    }

    // Sailboats: wander, and come about before running aground.
    for (const b of boats) {
      if (b.kind !== 'sail') continue;
      b.size = boost(10, 11);
      b.turn += (Math.random() - 0.5) * dt * 0.2;
      b.turn *= 0.99;
      const look = Math.max(150, b.size * 6);
      const ax = b.x - Math.sin(b.heading) * look, az = b.z - Math.cos(b.heading) * look;
      if (!isWater(ax, az)) b.heading += dt * 0.6;
      else b.heading += b.turn * dt;
      b.x -= Math.sin(b.heading) * b.speed * dt;
      b.z -= Math.cos(b.heading) * b.speed * dt;
      if (Math.random() < dt * 3) spray(b.x + Math.sin(b.heading) * b.size * 0.5, b.z + Math.cos(b.heading) * b.size * 0.5, b.size * 0.15, 4, t);
    }

    for (const b of boats) {
      if (!b.lamp) {
        b.lamp = light(b.kind === 'sail' ? '#fff3d6' : '#ffc46b', b.kind === 'coho' ? 0.05 : 0.11, 0, 0.3, b.kind === 'coho' ? -0.1 : 0.05);
        b.g.add(b.lamp);
      }
      const a = fade * (b.kind === 'coho' ? b.edge : 1);
      b.g.visible = a > 0.01;
      b.g.position.set(b.x, 0.8, b.z);
      b.g.rotation.set(0, b.heading, 0);
      b.g.scale.setScalar(b.size);
      // Sails heel a little with the wind.
      if (b.g.userData.sail) b.g.userData.sail.rotation.z = 0.18 * Math.sin(t * 0.3 + b.x);
      b.g.traverse((m) => m.material && (m.material.opacity = m.userData.light ? a * lightLevel : a));
    }

    // Gulls: lazy circles over the shore, the circles themselves drifting.
    const bs = boost(1.4, 7);
    const day = 1 - shared.uNight.value;
    birdMat.uniforms.uFade.value = fade * Math.max(0, day * 1.2 - 0.2);
    for (let i = 0; i < BIRDS; i++) {
      const f = flock[i];
      f.a += f.w * dt;
      f.drift += dt * 0.02;
      const cx = f.home.x + Math.cos(f.drift) * 250, cz = f.home.z + Math.sin(f.drift * 1.3) * 180;
      p.set(cx + Math.cos(f.a) * f.r, f.h + Math.sin(t * 0.4 + i) * 12, cz + Math.sin(f.a) * f.r);
      const dx = -Math.sin(f.a) * f.w, dz = Math.cos(f.a) * f.w;
      q.setFromEuler(e.set(0, yaw(dx, dz), f.w > 0 ? -0.35 : 0.35, 'YXZ'));
      birds.setMatrixAt(i, m4.compose(p, q, sc.setScalar(bs)));
    }
    birds.instanceMatrix.needsUpdate = true;

    if (foamDirty) {
      foamGeo.attributes.position.needsUpdate = foamGeo.attributes.birth.needsUpdate = foamGeo.attributes.life.needsUpdate = true;
      foamDirty = false;
    }
  }

  return { update, setEnabled: (on) => (enabled = on) };
}
