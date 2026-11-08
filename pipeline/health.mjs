// Daily health check of the live site. Fails (so GitHub emails the owner)
// when something needs a person; prints warnings for things that will
// probably sort themselves out.
//   fail: recorder stopped | storage near the cap | no scoreboard for 2 days
//         | an endpoint erroring | bide well behind BC Transit for 3 days
//   warn: no AI line | no headlines | timetable older than 60 days
// Usage: node pipeline/health.mjs    Env: BIDE_URL (default: the live site)

const URL_BASE = process.env.BIDE_URL || 'https://bide.tgoyal.me';
const fails = [], warns = [], notes = [];
const get = async (path) => {
  const res = await fetch(URL_BASE + path + (path.includes('?') ? '&' : '?') + 'health=' + Date.now(), { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res;
};
const check = async (name, fn) => {
  try { await fn(); } catch (e) { fails.push(`${name}: ${e.message}`); }
};
const now = Date.now() / 1000;
const ago = (s) => `${Math.round((now - s) / 60)} min ago`;

await check('recorder', async () => {
  const s = await (await get('/api/status')).json();
  if (now - s.vehicles.last > 30 * 60) fails.push(`recorder: last bus positions ${ago(s.vehicles.last)} (should be seconds)`);
  if (now - s.tripUpdates.last > 45 * 60) fails.push(`recorder: last predictions ${ago(s.tripUpdates.last)}`);
  const gb = s.bytes / 1e9;
  if (gb > 3.2) fails.push(`storage: ${gb.toFixed(2)} GB of the 4 GB cap; recording stops at 4`);
  notes.push(`recorder code v${s.code}, ${gb.toFixed(2)} GB stored, last positions ${ago(s.vehicles.last)}`);
  if (s.recentErrors?.length > 20) warns.push(`recorder: ${s.recentErrors.length} errors in the last week`);
});

await check('scoreboard', async () => {
  const days = await (await get('/api/scores')).json();
  if (!days.length) throw new Error('no scored days');
  const latest = days[0].date;
  const age = (Date.now() - Date.parse(latest + 'T12:00:00-08:00')) / 86400e3;
  if (age > 2.5) fails.push(`scoreboard: latest scored day is ${latest}; the nightly run may be failing`);
  // Fair comparison: BC Transit with its clock put right, where scored.
  const lost = days.slice(0, 3).filter((d) => {
    const bct = (d.overall.officialFixed || d.overall.official).mae;
    return Math.min(d.overall.bide.mae, d.overall.bidePlus.mae) > bct * 1.15;
  });
  if (days.length >= 3 && lost.length === 3) fails.push('model: bide has been more than 15% behind BC Transit for 3 days running');
  const d = days[0], o = d.overall;
  notes.push(`latest day ${latest}: BC Transit ${(o.officialFixed || o.official).mae} s, bide ${o.bide.mae} s, bide+ ${o.bidePlus.mae} s`);
});

await check('trip endpoint', async () => {
  const res = await fetch(`${URL_BASE}/api/trip?id=0`);
  if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
});
await check('AI line', async () => {
  const n = await (await get('/api/now')).json();
  if (!n?.text) warns.push('AI line: empty (Groq key or models?)');
});
await check('news', async () => {
  const n = await (await get('/api/news')).json();
  if (!n.length) warns.push('news: no headlines from any of the four feeds');
});
await check('outages', async () => { await get('/api/outages'); });
await check('timetable', async () => {
  const t = await (await get('/data/transit.json')).json();
  const baked = t.meta?.baked && Date.parse(t.meta.baked);
  if (!baked) warns.push('timetable: no bake date recorded');
  else if (Date.now() - baked > 60 * 86400e3) warns.push(`timetable: baked ${t.meta.baked}, over 60 days ago; the weekly refresh may be failing`);
  if (t.meta) notes.push(`timetable ${t.meta.version || '?'} baked ${t.meta.baked}`);
});

const out = [
  `## bide health, ${new Date().toISOString().slice(0, 16)}Z`,
  ...fails.map((f) => `- ❌ ${f}`),
  ...warns.map((w) => `- ⚠️ ${w}`),
  ...notes.map((n) => `- ${n}`),
].join('\n');
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) (await import('node:fs')).appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n');
process.exit(fails.length ? 1 : 0);
