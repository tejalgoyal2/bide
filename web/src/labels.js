// Place names, set like a hand-lettered map. Names come from OpenStreetMap,
// topped up with the neighbourhoods people in Victoria actually say.
import * as THREE from 'three';
import { toXY } from '../../shared/geo.js';
import { CORE_C, CORE_R } from './world.js';

// [name, lat, lon, tier, style]; tier 1 shows from far away, 3 only up close.
const CURATED = [
  ['Victoria', 48.4262, -123.3656, 1, 'city'],
  ['Saanich', 48.4740, -123.3610, 1, 'city'],
  ['Oak Bay', 48.4290, -123.3120, 1, 'city'],
  ['Esquimalt', 48.4320, -123.4160, 1, 'city'],
  ['View Royal', 48.4560, -123.4330, 2, 'city'],
  ['James Bay', 48.4140, -123.3760, 2],
  ['Fairfield', 48.4150, -123.3500, 2],
  ['Rockland', 48.4235, -123.3425, 3],
  ['Fernwood', 48.4325, -123.3470, 2],
  ['Gonzales', 48.4140, -123.3290, 3],
  ['Jubilee', 48.4375, -123.3330, 3],
  ['Oaklands', 48.4460, -123.3370, 3],
  ['Hillside', 48.4410, -123.3560, 3],
  ['North Park', 48.4320, -123.3580, 3],
  ['Burnside', 48.4470, -123.3800, 3],
  ['Vic West', 48.4300, -123.3880, 2],
  ['Tillicum', 48.4560, -123.3980, 3],
  ['Quadra', 48.4560, -123.3600, 3],
  ['Uptown', 48.4555, -123.3760, 3],
  ['Mount Tolmie', 48.4590, -123.3250, 3],
  ['Cadboro Bay', 48.4620, -123.2930, 2],
  ['Ten Mile Point', 48.4600, -123.2700, 3],
  ['UVic', 48.4633, -123.3117, 2],
  ['Gordon Head', 48.4930, -123.3150, 2],
  ['Lake Hill', 48.4720, -123.3580, 3],
  ['Royal Oak', 48.4930, -123.3870, 2],
  ['Cordova Bay', 48.5130, -123.3600, 2],
  ['Broadmead', 48.4980, -123.3640, 3],
  ['Downtown', 48.4275, -123.3640, 2, 'small'],
  ['Beacon Hill Park', 48.4128, -123.3640, 3, 'park'],
  ['PKOLS · Mount Doug', 48.4935, -123.3460, 2, 'park'],
  ['Strait of Juan de Fuca', 48.3800, -123.3600, 1, 'sea'],
  ['Haro Strait', 48.4600, -123.2350, 1, 'sea'],
  ['Victoria Harbour', 48.4220, -123.3870, 3, 'sea'],
  ['Portage Inlet', 48.4630, -123.4270, 3, 'sea'],
  ['Esquimalt Harbour', 48.4390, -123.4400, 3, 'sea'],
  ['Cadboro Bay', 48.4550, -123.2840, 3, 'sea'],
  ['Oak Bay', 48.4380, -123.2960, 3, 'sea'],
  ['Langford', 48.4500, -123.5050, 2, 'far'],
  ['Colwood', 48.4290, -123.4900, 2, 'far'],
  ['Central Saanich', 48.5600, -123.4100, 2, 'far'],
  ['Highlands', 48.5200, -123.5000, 3, 'far'],
];

const TIER_DIST = { 1: 40000, 2: 13000, 3: 6500 };

export function createLabels(container, getHeight) {
  const items = CURATED.map(([name, lat, lon, tier, style = '']) => {
    const [x, y] = toXY(lon, lat);
    const el = document.createElement('div');
    el.className = `label t${tier} ${style}`;
    el.textContent = name;
    container.appendChild(el);
    return { el, tier, style, p: new THREE.Vector3(x, 0, -y), x, y, o: -1 };
  });
  const v = new THREE.Vector3();

  function update(camera, dist, rise) {
    const w = container.clientWidth, h = container.clientHeight;
    for (const it of items) {
      it.p.y = it.style === 'sea' ? 4 : getHeight(it.x, it.y) * rise + 30;
      v.copy(it.p).project(camera);
      const r = Math.hypot((it.x - CORE_C.x) / CORE_R.x, (-it.y - CORE_C.y) / CORE_R.y);
      const edge = it.style === 'far' ? 1 : 1 - THREE.MathUtils.smoothstep(r, 1.1, 2.0);
      const near = dist < TIER_DIST[it.tier] ? 1 : 0;
      const tooClose = it.tier === 1 && it.style === 'city' && dist < 2200 ? 0.35 : 1;
      let o = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2 ? near * edge * tooClose * rise : 0;
      o = Math.round(o * 20) / 20;
      if (o !== it.o) {
        it.el.style.opacity = o;
        it.o = o;
      }
      if (o > 0) {
        it.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -50%)`;
      }
    }
  }
  return { update };
}
