// Power outages from BC Hydro: each one's area tinted on the ground, with a
// slow ripple at its centre that stays readable from the whole-city view.
import * as THREE from 'three';
import { toXY } from '../../shared/geo.js';

const RED = '#c4553a';

export function createOutages(scene, surfaceY, onChange) {
  const group = new THREE.Group();
  scene.add(group);
  const ringGeo = new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2);
  let items = [], enabled = true, fade = 0;

  function build(list) {
    for (const it of items) {
      group.remove(it.fill, it.ring);
      it.fill?.geometry.dispose();
      it.fill?.material.dispose();
      it.ring.material.dispose();
    }
    items = list.map((o, i) => {
      const [cx, cy] = toXY(o.lon, o.lat);
      const base = surfaceY(cx, cy);
      let fill = null;
      if (o.poly.length >= 6) {
        const s = new THREE.Shape();
        for (let k = 0; k < o.poly.length; k += 2) {
          const [x, y] = toXY(o.poly[k], o.poly[k + 1]);
          k ? s.lineTo(x, y) : s.moveTo(x, y);
        }
        const g = new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2);
        fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: RED, transparent: true, opacity: 0.3, depthTest: false, depthWrite: false }));
        fill.position.y = base + 6;
        fill.renderOrder = 15;
        group.add(fill);
      }
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: RED, transparent: true, depthTest: false, depthWrite: false }));
      ring.position.set(cx, base + 5, -cy);
      ring.renderOrder = 15;
      group.add(ring);
      return { ...o, fill, ring, phase: i * 0.37 };
    });
    onChange?.(list);
  }

  async function poll() {
    if (!enabled || document.hidden) return;
    try {
      build(await (await fetch('/api/outages')).json());
    } catch {}
  }
  poll();
  setInterval(poll, 120_000);
  document.addEventListener('visibilitychange', () => !document.hidden && !items.length && poll());

  function update(dt, mpp, t) {
    fade = Math.min(1, Math.max(0, fade + (enabled ? dt : -dt) * 2));
    group.visible = fade > 0;
    if (!group.visible) return;
    // Bigger ripples for bigger outages, always at least a few pixels across.
    for (const it of items) {
      const p = (t / 2.6 + it.phase) % 1;
      const size = Math.max(40, mpp * (10 + 5 * Math.log10(1 + it.out)));
      it.ring.scale.setScalar(size * (0.4 + 1.6 * p));
      it.ring.material.opacity = fade * 0.75 * (1 - p) ** 1.5;
      if (it.fill) it.fill.material.opacity = fade * (0.24 + 0.1 * Math.sin(t * 2 + it.phase * 6));
    }
  }

  function setEnabled(on) {
    enabled = on;
    if (on) poll();
  }

  return { update, setEnabled, get items() { return items; } };
}
