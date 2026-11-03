// Hidden notes. Nothing marks these places: run the cursor (or a finger)
// over the right spot when zoomed in and a small sparkle appears; tap it for
// a line about the place. A few are personal, the rest Victoria lore. And one
// more: tap the logo's dot and a pod of orcas swims past.
import * as THREE from 'three';
import { toXY } from '../../shared/geo.js';

const MINE = 1, LORE = 0;
const EGGS = [
  [MINE, 'BCI', -123.36308, 48.42823, 'British Columbia Investment Management Corporation, which invests the pensions of B.C.’s public sector. It’s where I work.'],
  [MINE, 'Italian Food Imports', -123.36275, 48.42479, 'An Italian deli on Blanshard since the 1950s, and my usual lunch. Get a sandwich from the counter.'],
  [MINE, 'Chipotle', -123.36583, 48.42446, 'The first Chipotle on Vancouver Island, opened in 2024. A regular stop.'],
  [MINE, 'Bold Butchery', -123.35949, 48.4272, 'Butcher shop and grill on Quadra. Go for the shawarma.'],
  [LORE, 'Fan Tan Alley', -123.36792, 48.42894, 'Canada’s narrowest street, barely over a metre wide at one end. It was once lined with gambling clubs.'],
  [LORE, 'Gate of Harmonious Interest', -123.3672, 48.4295, 'The gateway to Canada’s oldest Chinatown, founded in 1858.'],
  [LORE, 'Parliament Buildings', -123.3703, 48.4197, 'After dark, 3,333 bulbs trace the building’s outline, a tradition that dates to 1897.'],
  [LORE, 'The Empress', -123.3678, 48.4216, 'The hotel has served afternoon tea since it opened in 1908.'],
  [LORE, 'Mile 0', -123.369, 48.4091, 'The western end of the Trans-Canada Highway, where Terry Fox planned to finish his Marathon of Hope.'],
  [LORE, 'Beacon Hill Children’s Farm', -123.36385, 48.41153, 'On summer mornings the goats are let out all at once: the goat stampede.'],
  [LORE, 'Fisherman’s Wharf', -123.38257, 48.42276, 'Float homes, seafood shacks, and harbour seals that know where the fish and chips are.'],
  [LORE, 'Ogden Point Breakwater', -123.3884, 48.4113, 'A granite walkway out into the Strait of Juan de Fuca, with a lighthouse at the end.'],
  [LORE, 'Craigdarroch Castle', -123.34383, 48.42261, 'Built for the coal baron Robert Dunsmuir, who died in 1889 before it was finished.'],
  [LORE, 'Emily Carr House', -123.3662, 48.4128, 'Where the painter Emily Carr was born, in 1871.'],
  [LORE, 'Spinnakers', -123.3858, 48.4291, 'Opened in 1984 as Canada’s first brewpub to brew its own beer on site.'],
  [LORE, 'Fisgard Lighthouse', -123.44756, 48.43038, 'Lit in 1860, the first permanent lighthouse on Canada’s west coast.'],
  [LORE, 'Hatley Castle', -123.47258, 48.43449, 'It played Xavier’s School for Gifted Youngsters in the X-Men films.'],
].map(([kind, name, lon, lat, note]) => ({ kind, name, note, xy: toXY(lon, lat), sx: 0, sy: 0, on: false }));

const REACH = 22; // px: how close the cursor must come
const MAX_DIST = 3000; // camera distance beyond which nothing can be found

export function createEggs(scene, layer, surfaceY) {
  const v = new THREE.Vector3();
  const spark = document.createElement('div');
  spark.className = 'egg-spark';
  layer.appendChild(spark);
  const card = document.createElement('div');
  card.className = 'egg-card';
  document.body.appendChild(card);
  let near = null, open = null, camDist = Infinity;

  const nearest = (x, y) => {
    if (camDist > MAX_DIST) return null;
    let best = null, bd = REACH;
    for (const e of EGGS) {
      if (!e.on) continue;
      const d = Math.hypot(e.sx - x, e.sy - y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  };
  const place = (el, e) => {
    const w = el === card ? 290 : 0, h = el === card ? 130 : 0;
    el.style.left = Math.min(e.sx, innerWidth - w) + 'px';
    el.style.top = Math.min(e.sy, innerHeight - h) + 'px';
  };
  function hover(x, y) {
    near = nearest(x, y);
    spark.classList.toggle('on', !!near);
    if (near) place(spark, near);
    return !!near;
  }
  function tap(x, y) {
    const e = nearest(x, y);
    if (!e) { close(); return false; }
    open = e;
    card.innerHTML = '';
    const h = document.createElement('b'), p = document.createElement('p');
    h.textContent = e.name; p.textContent = e.note;
    card.append(h, p);
    card.classList.toggle('mine', e.kind === MINE);
    place(card, e);
    card.classList.add('on');
    return true;
  }
  const close = () => { open = null; card.classList.remove('on'); };

  // Orcas: three dorsal fins that rise and sink as the pod swims along the
  // shore from Clover Point toward Ogden Point.
  const finGeo = new THREE.BufferGeometry();
  finGeo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.35, 0, 0, -0.15, 1, 0], 3));
  const pod = [0, 1, 2].map((i) => {
    const m = new THREE.Mesh(finGeo, new THREE.MeshBasicMaterial({ color: '#141418', side: THREE.DoubleSide, transparent: true, fog: false }));
    m.renderOrder = 26;
    m.visible = false;
    scene.add(m);
    return { m, lag: i * 7 + Math.random() * 3, side: (i - 1) * 60, phase: Math.random() * 6, size: i === 1 ? 1.4 : 1 };
  });
  const [ax, ay] = toXY(-123.345, 48.4045), [bx, by] = toXY(-123.392, 48.4085);
  let swim = -1;
  const surface = () => { if (swim < 0) swim = 0; };
  // Now and then they come by on their own.
  setInterval(() => Math.random() < 0.25 && surface(), 6 * 60e3);

  function update(dt, camera, dist, mpp) {
    camDist = dist;
    for (const e of EGGS) {
      const [x, y] = e.xy;
      v.set(x, surfaceY(x, y) + 8, -y).project(camera);
      e.on = v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
      e.sx = ((v.x + 1) / 2) * innerWidth; e.sy = ((1 - v.y) / 2) * innerHeight;
    }
    if (near) place(spark, near);
    if (open) {
      if (!open.on || dist > MAX_DIST) close();
      else place(card, open);
    }
    if (swim >= 0) {
      swim += dt;
      const T = 70;
      for (const f of pod) {
        const u = (swim - f.lag) / T;
        const breath = Math.sin(swim * 1.1 + f.phase);
        f.m.visible = u > 0 && u < 1 && breath > -0.2;
        if (!f.m.visible) continue;
        const s = Math.max(9, 16 * mpp) * f.size;
        const x = ax + (bx - ax) * u, y = ay + (by - ay) * u + f.side;
        f.m.position.set(x, -s * 0.9 + s * 0.9 * Math.min(1, breath + 0.2), -y);
        f.m.scale.setScalar(s);
        f.m.rotation.y = Math.atan2(-(by - ay), bx - ax) + Math.PI;
        f.m.material.opacity = Math.min(1, u * 20, (1 - u) * 20);
      }
      if (swim > 70 + 20) swim = -1;
    }
  }

  return { update, hover, tap, orcas: surface };
}
