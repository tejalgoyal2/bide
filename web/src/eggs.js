// Little discoveries for people who zoom in: a few favourite places and some
// Victoria lore, each a small pin that opens a note. And one hidden thing:
// tap the logo's dot and a pod of orcas passes along the shore.
import * as THREE from 'three';
import { toXY } from '../../shared/geo.js';

const MINE = 1, LORE = 0;
const EGGS = [
  [MINE, 'BCI', -123.36308, 48.42823, 'Where Tejal works: thirteen storeys of pension investing across from City Hall. After dark, the lights stay on.'],
  [MINE, 'Italian Food Imports', -123.36275, 48.42479, 'Tejal’s sandwich place. A downtown Italian deli since the late 1950s: order the sandwich, take the long way back.'],
  [MINE, 'Chipotle', -123.36583, 48.42446, 'Vancouver Island’s first Chipotle, opened July 2024. Burrito bowl o’clock.'],
  [MINE, 'Bold Butchery', -123.35949, 48.4272, 'A butcher counter that also does shawarma and burgers. A Tejal favourite.'],
  [LORE, 'Fan Tan Alley', -123.36792, 48.42894, 'The narrowest commercial street in Canada, barely over a metre at its tightest. Gambling dens once lined it.'],
  [LORE, 'Gate of Harmonious Interest', -123.3672, 48.4295, 'The gate into Chinatown, the oldest in Canada (1858).'],
  [LORE, 'B.C. Legislature', -123.3703, 48.4197, 'Outlined at night by 3,333 light bulbs, a tradition since Queen Victoria’s Diamond Jubilee in 1897.'],
  [LORE, 'The Empress', -123.3678, 48.4216, 'Afternoon tea has been poured here since 1908.'],
  [LORE, 'Mile 0', -123.369, 48.40910, 'Where the Trans-Canada Highway begins, and Terry Fox’s Marathon of Hope was meant to end.'],
  [LORE, 'Beacon Hill Children’s Farm', -123.36385, 48.41153, 'Home of the daily goat stampede, every summer.'],
  [LORE, 'Fisherman’s Wharf', -123.38257, 48.42276, 'Float homes, fish and chips, and harbour seals hoping for scraps.'],
  [LORE, 'Ogden Point breakwater', -123.3884, 48.4113, 'Granite blocks running out into the strait, with a lighthouse at the end. A good walk in any weather.'],
  [LORE, 'Craigdarroch Castle', -123.34383, 48.42261, 'A coal baron’s 39-room mansion, finished in 1890. He died before it was done.'],
  [LORE, 'Emily Carr House', -123.3662, 48.4128, 'Where the painter Emily Carr was born, in 1871.'],
  [LORE, 'Spinnakers', -123.3858, 48.4291, 'Canada’s first in-house brewpub, since 1984.'],
  [LORE, 'Fisgard Lighthouse', -123.44756, 48.43038, 'The first permanent lighthouse on Canada’s west coast, lit in 1860.'],
  [LORE, 'Hatley Castle', -123.47258, 48.43449, 'You may know it as Xavier’s school from the X-Men films.'],
].map(([kind, name, lon, lat, note]) => ({ kind, name, note, xy: toXY(lon, lat) }));

export function createEggs(scene, layer, surfaceY) {
  const v = new THREE.Vector3();
  const card = document.createElement('div');
  card.className = 'egg-card card hidden';
  document.body.appendChild(card);
  let open = null;
  for (const e of EGGS) {
    const el = document.createElement('button');
    el.className = 'egg' + (e.kind === MINE ? ' mine' : '');
    el.setAttribute('aria-label', e.name);
    el.innerHTML = '<i></i>';
    el.onclick = (ev) => {
      ev.stopPropagation();
      if (open === e) { close(); return; }
      open = e;
      card.innerHTML = `<b>${e.name}</b><p>${e.note}</p>`;
      card.classList.toggle('mine', e.kind === MINE);
      card.classList.remove('hidden');
    };
    layer.appendChild(el);
    e.el = el;
  }
  const close = () => { open = null; card.classList.add('hidden'); };
  addEventListener('pointerdown', (ev) => { if (open && !card.contains(ev.target) && !ev.target.closest('.egg')) close(); });

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
    const show = dist < 4200;
    for (const e of EGGS) {
      const [x, y] = e.xy;
      v.set(x, surfaceY(x, y) + 8, -y).project(camera);
      const on = show && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      e.el.style.opacity = on ? 1 - THREE.MathUtils.smoothstep(dist, 3200, 4200) : 0;
      e.el.style.pointerEvents = on ? '' : 'none';
      e.el.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px)`;
      if (e === open) {
        if (!on) close();
        else card.style.transform = `translate(${Math.min(innerWidth - 270, ((v.x + 1) / 2) * innerWidth + 14)}px, ${((1 - v.y) / 2) * innerHeight - 20}px)`;
      }
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

  return { update, orcas: surface };
}
