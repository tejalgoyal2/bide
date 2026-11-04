// Map camera: drag to pan, wheel or pinch to zoom toward the pointer,
// right-drag or two fingers to turn and tilt. Everything glides, and the
// camera drifts gently back toward the city if you wander out to sea.
import * as THREE from 'three';
import { CORE_C, CORE_R } from './world.js';

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function createControls(camera, dom, groundY) {
  const s = {
    target: new THREE.Vector3(CORE_C.x, 0, CORE_C.y),
    dist: 9000,
    azimuth: 0.35,
    polar: 0.85,
    vel: new THREE.Vector3(),
    spin: 0,
    follow: null,
    flight: null,
    lastInput: performance.now(),
    onTap: null,
  };
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = new THREE.Vector2();
  const pointers = new Map();
  let mode = null, anchor = null, moved = 0, last = null, lastT = 0, twoStart = null, touch = false;
  // Fingers are less precise than a mouse: on touch, gestures need a clear
  // intent before they turn or tilt, and everything moves a little less.
  let twoTurn = false, twoTilt = false;

  const groundAt = (x, y) => {
    const r = dom.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    plane.constant = -s.target.y;
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, hit) ? hit : null;
  };

  const maxPolar = () => THREE.MathUtils.lerp(1.22, 0.92, THREE.MathUtils.smoothstep(s.dist, 1500, 20000));

  function place() {
    s.polar = THREE.MathUtils.clamp(s.polar, 0.05, maxPolar());
    s.dist = THREE.MathUtils.clamp(s.dist, 300, 30000);
    const sp = Math.sin(s.polar);
    camera.position.set(
      s.target.x + s.dist * sp * Math.sin(s.azimuth),
      s.target.y + s.dist * Math.cos(s.polar),
      s.target.z + s.dist * sp * Math.cos(s.azimuth),
    );
    camera.lookAt(s.target);
  }

  function interrupt() {
    s.flight = null;
    s.lastInput = performance.now();
  }

  dom.addEventListener('contextmenu', (e) => e.preventDefault());
  dom.addEventListener('pointerdown', (e) => {
    interrupt();
    dom.setPointerCapture(e.pointerId);
    touch = e.pointerType === 'touch';
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0;
    s.vel.set(0, 0, 0);
    s.spin = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      twoStart = { d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), my: (a.y + b.y) / 2, ang0: Math.atan2(b.y - a.y, b.x - a.x), my0: (a.y + b.y) / 2 };
      twoTurn = twoTilt = false;
      s.vel.set(0, 0, 0);
      mode = 'two';
      return;
    }
    mode = e.button === 2 || e.ctrlKey || e.shiftKey ? 'turn' : 'pan';
    anchor = groundAt(e.clientX, e.clientY);
    last = { x: e.clientX, y: e.clientY };
    lastT = performance.now();
  });

  dom.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
    if (moved > 4) s.follow = null;
    s.lastInput = performance.now();
    if (mode === 'two' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x), my = (a.y + b.y) / 2;
      const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
      // Zoom always follows the pinch, a little softened.
      s.dist *= (twoStart.d / d) ** (touch ? 0.85 : 1);
      // Twist turns the map only once it's clearly a twist (about 12 degrees),
      // and both fingers sliding together tilt it only past 40 px.
      if (!twoTurn && Math.abs(wrap(ang - twoStart.ang0)) > 0.21) twoTurn = true;
      if (!twoTilt && Math.abs(my - twoStart.my0) > 40 && Math.abs(Math.log(d / twoStart.d)) < 0.05) twoTilt = true;
      if (twoTurn) s.azimuth -= wrap(ang - twoStart.ang) * (touch ? 0.7 : 1);
      if (twoTilt) s.polar -= (my - twoStart.my) * (touch ? 0.0025 : 0.004);
      twoStart = { ...twoStart, d, ang, my };
      return;
    }
    if (mode === 'turn') {
      s.azimuth -= (e.clientX - prev.x) * 0.005;
      s.polar -= (e.clientY - prev.y) * 0.004;
      s.spin = -(e.clientX - prev.x) * 0.005;
      return;
    }
    if (mode === 'pan' && anchor) {
      const now = groundAt(e.clientX, e.clientY);
      if (!now) return;
      const delta = anchor.clone().sub(now);
      delta.y = 0;
      s.target.add(delta);
      const t = performance.now();
      const dt = Math.max(1, t - lastT) / 1000;
      s.vel.lerp(delta.clone().divideScalar(dt), 0.5);
      lastT = t;
      place();
    }
  });

  const up = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (moved < (touch ? 12 : 6) && mode === 'pan' && s.onTap) s.onTap(e.clientX, e.clientY);
    if (performance.now() - lastT > 80 || mode === 'two') s.vel.set(0, 0, 0);
    // A flick carries on, but a finger's flick only so far.
    if (touch) s.vel.multiplyScalar(0.55).clampLength(0, s.dist * 1.2);
    if (pointers.size === 1) {
      const [p] = [...pointers.values()];
      mode = 'pan';
      anchor = groundAt(p.x, p.y);
    } else if (!pointers.size) mode = null;
  };
  dom.addEventListener('pointerup', up);
  dom.addEventListener('pointercancel', up);

  dom.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      interrupt();
      const k = Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
      const g = groundAt(e.clientX, e.clientY);
      const nd = THREE.MathUtils.clamp(s.dist * k, 300, 30000);
      const f = nd / s.dist;
      if (g && !s.follow) {
        s.target.x = g.x + (s.target.x - g.x) * f;
        s.target.z = g.z + (s.target.z - g.z) * f;
      }
      s.dist = nd;
    },
    { passive: false },
  );

  function flyTo(to, ms = 2600) {
    s.flight = {
      t0: performance.now(), ms,
      from: { x: s.target.x, z: s.target.z, dist: s.dist, polar: s.polar, azimuth: s.azimuth },
      to: { x: s.target.x, z: s.target.z, dist: s.dist, polar: s.polar, azimuth: s.azimuth, ...to },
    };
  }

  function update(dt, followPos) {
    const now = performance.now();
    if (s.flight) {
      const f = s.flight;
      const t = Math.min(1, (now - f.t0) / f.ms), k = ease(t);
      for (const key of ['x', 'z', 'polar', 'azimuth']) {
        const v = f.from[key] + (f.to[key] - f.from[key]) * k;
        if (key === 'x') s.target.x = v;
        else if (key === 'z') s.target.z = v;
        else s[key] = v;
      }
      s.dist = Math.exp(Math.log(f.from.dist) + (Math.log(f.to.dist) - Math.log(f.from.dist)) * k);
      if (t >= 1) s.flight = null;
    } else if (followPos) {
      s.target.x += (followPos.x - s.target.x) * (1 - Math.exp(-dt * 4));
      s.target.z += (followPos.z - s.target.z) * (1 - Math.exp(-dt * 4));
    } else if (mode !== 'pan') {
      s.target.addScaledVector(s.vel, dt);
      s.vel.multiplyScalar(Math.exp(-dt * (touch ? 4.5 : 3.2)));
      if (mode !== 'turn') {
        s.azimuth += s.spin;
        s.spin *= Math.exp(-dt * 4);
      }
      // Ease back toward the city when the view has drifted out to sea.
      const dx = (s.target.x - CORE_C.x) / (CORE_R.x * 0.95), dz = (s.target.z - CORE_C.y) / (CORE_R.y * 0.95);
      const r = Math.hypot(dx, dz);
      if (r > 1 && !mode) {
        const k = 1 - Math.exp(-dt * 1.6);
        s.target.x -= (dx / r) * (r - 1) * CORE_R.x * 0.95 * k;
        s.target.z -= (dz / r) * (r - 1) * CORE_R.y * 0.95 * k;
      }
      // After a while untouched, the view slowly turns, like a held breath.
      if (now - s.lastInput > 30000 && !mode) s.azimuth += dt * 0.012;
    }
    const gy = groundY(s.target.x, -s.target.z);
    s.target.y += (gy - s.target.y) * (1 - Math.exp(-dt * 3));
    place();
  }

  place();
  return { state: s, update, flyTo, groundAt, interrupt };
}
