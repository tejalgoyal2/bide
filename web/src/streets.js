// Street names, once you're close enough to read them: laid along the road,
// kept upright, bigger roads first, and never piled on top of each other.
import * as THREE from 'three';

const SHOW_AT = 2600, FULL_AT = 1700; // camera distance, metres
const MAX_LABELS = 70;

export function createStreets(layer, surfaceY) {
  let anchors = [];
  fetch('/data/streets.json').then((r) => r.json()).then((a) => (anchors = a)).catch(() => {});
  const pool = [];
  const el = (i) => {
    while (pool.length <= i) {
      const d = document.createElement('div');
      d.className = 'street';
      layer.appendChild(d);
      pool.push({ d, text: '', on: false });
    }
    return pool[i];
  };
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  let enabled = true, frame = 0;

  function update(camera, target, dist) {
    if (++frame % 2) return; // every other frame is plenty
    const vis = enabled ? 1 - THREE.MathUtils.smoothstep(dist, FULL_AT, SHOW_AT) : 0;
    let n = 0;
    if (vis > 0.01 && anchors.length) {
      const W = innerWidth, H = innerHeight, R = dist * 1.6, tx = target.x, ty = -target.z;
      const cand = [];
      for (const s of anchors) {
        if (Math.abs(s[2] - tx) > R || Math.abs(s[3] - ty) > R) continue;
        // Minor streets only when really close.
        if (s[1] === 3 && dist > 2100) continue;
        const z = surfaceY(s[2], s[3]) + 3;
        a.set(s[2], z, -s[3]).project(camera);
        if (a.z > 1 || Math.abs(a.x) > 0.95 || Math.abs(a.y) > 0.92) continue;
        b.set(s[2] + Math.cos(s[4]) * 30, z, -(s[3] + Math.sin(s[4]) * 30)).project(camera);
        const sx = ((a.x + 1) / 2) * W, sy = ((1 - a.y) / 2) * H;
        let ang = Math.atan2((a.y - b.y) * H, (b.x - a.x) * W);
        if (ang > Math.PI / 2) ang -= Math.PI;
        if (ang < -Math.PI / 2) ang += Math.PI;
        const centre = Math.hypot(sx - W / 2, sy - H / 2) / W;
        cand.push({ s, sx, sy, ang, score: s[1] + centre * 2 });
      }
      cand.sort((p, q) => p.score - q.score);
      const boxes = [];
      for (const c of cand) {
        if (n >= MAX_LABELS) break;
        const w = c.s[0].length * 6.4 + 8, h = 14;
        const cw = Math.abs(Math.cos(c.ang)) * w + Math.abs(Math.sin(c.ang)) * h;
        const ch = Math.abs(Math.sin(c.ang)) * w + Math.abs(Math.cos(c.ang)) * h;
        const box = [c.sx - cw / 2, c.sy - ch / 2, c.sx + cw / 2, c.sy + ch / 2];
        if (boxes.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
        boxes.push(box);
        const p = el(n++);
        if (p.text !== c.s[0]) { p.d.textContent = c.s[0]; p.text = c.s[0]; p.d.dataset.rank = c.s[1]; }
        p.d.style.transform = `translate(${c.sx}px, ${c.sy}px) translate(-50%, -50%) rotate(${c.ang}rad)`;
        p.d.style.opacity = vis;
        p.on = true;
      }
    }
    for (let k = n; k < pool.length; k++) if (pool[k].on) { pool[k].d.style.opacity = 0; pool[k].on = false; }
  }

  return { update, setEnabled: (on) => (enabled = on) };
}
