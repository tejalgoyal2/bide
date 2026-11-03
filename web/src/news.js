// Local news: headlines from Victoria newsrooms (via /api/news), one at a
// time in the header, and pinned to the map when they name a neighbourhood
// or landmark. A pin opens the story at its source.
import * as THREE from 'three';
import { toXY } from '../../shared/geo.js';

// Places a headline might name, with a point to pin it to. Longest names
// first, so "Oak Bay Avenue" isn't read as "Oak Bay" before it's read whole.
const PLACES = Object.entries({
  'University of Victoria': [-123.312, 48.463], UVic: [-123.312, 48.463], 'Royal Jubilee': [-123.327, 48.433],
  'Victoria General': [-123.433, 48.466], 'Beacon Hill': [-123.364, 48.413], 'Dallas Road': [-123.36, 48.408],
  'Inner Harbour': [-123.37, 48.422], Legislature: [-123.3707, 48.4197], 'Ogden Point': [-123.386, 48.413],
  'Cook Street Village': [-123.351, 48.414], 'James Bay': [-123.3752, 48.4135], Chinatown: [-123.3671, 48.4293],
  Fairfield: [-123.3505, 48.4135], Fernwood: [-123.347, 48.431], Rockland: [-123.341, 48.422], 'Oak Bay': [-123.315, 48.4265],
  Esquimalt: [-123.414, 48.431], 'Vic West': [-123.388, 48.43], 'Gordon Head': [-123.317, 48.492], 'Cadboro Bay': [-123.293, 48.46],
  Langford: [-123.5, 48.45], Colwood: [-123.487, 48.436], 'View Royal': [-123.44, 48.456], Saanich: [-123.372, 48.484],
  Uptown: [-123.374, 48.454], Hillside: [-123.35, 48.441], Burnside: [-123.385, 48.45], Tillicum: [-123.396, 48.456],
  Oaklands: [-123.336, 48.44], Gonzales: [-123.329, 48.413], 'Mount Tolmie': [-123.324, 48.458], 'Swan Lake': [-123.37, 48.466],
  'Elk Lake': [-123.4, 48.525], 'Royal Oak': [-123.395, 48.495], Camosun: [-123.34, 48.441], 'Harris Green': [-123.359, 48.4265],
  'Pandora Avenue': [-123.364, 48.427], 'Fisherman’s Wharf': [-123.3826, 48.4228], "Fisherman's Wharf": [-123.3826, 48.4228],
  'Mile Zero': [-123.369, 48.409], 'Mile 0': [-123.369, 48.409], Highlands: [-123.5, 48.52], Metchosin: [-123.54, 48.38],
}).sort((a, b) => b[0].length - a[0].length).map(([name, [lon, lat]]) => [new RegExp(`\\b${name.replace(/[’']/g, "['’]")}\\b`), name, ...toXY(lon, lat)]);

export function createNews(layer, tickerEl, surfaceY) {
  let items = [], pins = [], enabled = true, at = 0;
  const v = new THREE.Vector3();

  async function load() {
    try {
      items = (await (await fetch('/api/news')).json()) || [];
    } catch { return; }
    for (const p of pins) p.el.remove();
    pins = [];
    const used = new Map();
    for (const it of items) {
      if (Date.now() - it.at > 3 * 86400e3) continue;
      const hit = PLACES.find(([re]) => re.test(it.title)) || PLACES.find(([re]) => re.test(it.text));
      if (!hit) continue;
      // Stories in the same place fan out a little instead of stacking.
      const k = used.get(hit[1]) || 0;
      used.set(hit[1], k + 1);
      if (k > 2 || pins.length >= 12) continue;
      const el = document.createElement('a');
      el.className = 'news-pin';
      el.href = it.link; el.target = '_blank'; el.rel = 'noopener';
      el.innerHTML = '<i></i><span></span>';
      el.querySelector('span').textContent = it.title;
      el.title = `${it.source} · ${hit[1]}`;
      layer.appendChild(el);
      pins.push({ el, x: hit[2] + k * 140, y: hit[3] - k * 90, it });
    }
    show(true);
  }

  // The header ticker: one headline at a time, gently cross-faded.
  function show(now) {
    if (!items.length) { tickerEl.hidden = true; return; }
    tickerEl.hidden = false;
    const it = items[at++ % Math.min(items.length, 12)];
    const swap = () => {
      tickerEl.href = it.link;
      tickerEl.innerHTML = '<b></b><span></span>';
      tickerEl.querySelector('b').textContent = it.source;
      tickerEl.querySelector('span').textContent = it.title;
      tickerEl.classList.remove('out');
    };
    if (now) swap();
    else { tickerEl.classList.add('out'); setTimeout(swap, 450); }
  }
  load();
  setInterval(load, 15 * 60e3);
  setInterval(() => show(false), 9000);

  function update(camera, dist) {
    for (const p of pins) {
      v.set(p.x, surfaceY(p.x, p.y) + 10, -p.y).project(camera);
      const on = enabled && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      p.el.style.opacity = on ? THREE.MathUtils.clamp(1.4 - dist / 20000, 0.5, 1) : 0;
      p.el.style.pointerEvents = on ? '' : 'none';
      p.el.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px)`;
    }
  }

  return { update, setEnabled: (on) => (enabled = on), get count() { return pins.length; } };
}
