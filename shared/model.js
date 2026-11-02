// bide's prediction models, shared by the nightly scoreboard and the live bus
// card, so the card shows exactly what gets scored. Times are unix seconds,
// already corrected for any whole-hour error in the feed's clock.

// bide v1: delay persistence with drift. The bus's current delay is the
// delay seen at the last stop it reached (prevA vs its timetable ps), or more
// if it still hasn't reached its next stop (timetable nextS). That delay
// decays with timetable distance ahead (rho when late, gamma when early),
// plus a drift of beta seconds per timetable minute. has = 0 when the bus
// hasn't been seen to reach any stop yet.
export function bideAt(made, s, has, prevA, ps, nextS, p) {
  const live = nextS ? made - nextS : -Infinity;
  if (!has) return Math.max(s + Math.max(0, live), made + 15);
  const d = Math.max(prevA - ps, live);
  const ahead = Math.max(0, s - ps);
  const k = (d >= 0 ? p.rho : p.gamma) ** (ahead / 600);
  return Math.max(s + d * k + (p.beta * ahead) / 60, prevA + 0.75 * ahead, made + 15);
}

// bide+: a blend of BC Transit's prediction, bide's own and the timetable.
// Each is turned into "seconds from now"; per band of BC Transit's lead time
// (known when the prediction is made), arrival = w0 + w1*official + w2*bide +
// w3*schedule, with weights learned on an earlier day (least absolute error).
// Days fitted before the blend existed carry only c, a drift per lead minute.
export const LEAD_BANDS = [120, 300, 600, 900, 1200, Infinity];
export const band = (lead) => LEAD_BANDS.findIndex((b) => lead <= b);
export function featuresAt(made, official, bide, s) {
  return [1, Math.max(0, official - made), Math.max(0, bide - made), s - made];
}
export function plusAt(made, official, bide, s, p) {
  const lead = Math.max(0, official - made);
  const w = p.w?.[band(lead)];
  if (!w) return Math.max(official + ((p.c || 0) * lead) / 60, made + 15);
  const x = featuresAt(made, official, bide, s);
  return Math.max(made + w[0] * x[0] + w[1] * x[1] + w[2] * x[2] + w[3] * x[3], made + 15);
}
