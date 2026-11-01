// A tiny GTFS-Realtime protobuf reader. It decodes only the fields bide uses,
// fast enough to run inside a free-plan Worker (10 ms CPU) and in the browser.

const td = new TextDecoder();

class Reader {
  constructor(u8) {
    this.b = u8;
    this.p = 0;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }
  // Unsigned varint as a JS number. Exact up to 2^53, which covers timestamps.
  uint() {
    let r = 0, s = 1, x;
    do {
      x = this.b[this.p++];
      r += (x & 127) * s;
      s *= 128;
    } while (x & 128);
    return r;
  }
  // int32 fields are sign-extended to 10 bytes on the wire; keep the low 32 bits.
  int32() {
    let lo = 0, i = 0, x;
    do {
      x = this.b[this.p++];
      if (i < 5) lo |= (x & 127) << (7 * i);
      i++;
    } while (x & 128);
    return lo | 0;
  }
  str() {
    const l = this.uint();
    const s = td.decode(this.b.subarray(this.p, this.p + l));
    this.p += l;
    return s;
  }
  f32() {
    const v = this.dv.getFloat32(this.p, true);
    this.p += 4;
    return v;
  }
  f64() {
    const v = this.dv.getFloat64(this.p, true);
    this.p += 8;
    return v;
  }
  end() {
    const l = this.uint();
    return this.p + l;
  }
  skip(wt) {
    if (wt === 0) this.uint();
    else if (wt === 2) {
      const l = this.uint();
      this.p += l;
    }
    else if (wt === 5) this.p += 4;
    else if (wt === 1) this.p += 8;
    else throw new Error('bad wire type ' + wt);
  }
}

// Walk the fields of one message, calling fn(field, wireType) for each.
function each(r, end, fn) {
  while (r.p < end) {
    const k = r.uint();
    if (fn(k >>> 3, k & 7) === false) r.skip(k & 7);
  }
}

function header(r, end) {
  const h = { ts: 0 };
  each(r, end, (f) => {
    if (f === 3) h.ts = r.uint();
    else return false;
  });
  return h;
}

function trip(r, end) {
  const t = { tripId: '', routeId: '', dir: -1, startTime: '', startDate: '' };
  each(r, end, (f) => {
    if (f === 1) t.tripId = r.str();
    else if (f === 5) t.routeId = r.str();
    else if (f === 6) t.dir = r.uint();
    else if (f === 2) t.startTime = r.str();
    else if (f === 3) t.startDate = r.str();
    else return false;
  });
  return t;
}

function vehicleId(r, end) {
  let id = '';
  each(r, end, (f) => {
    if (f === 1) id = r.str();
    else return false;
  });
  return id;
}

// The whole feed's header timestamp, without decoding the entities.
export function feedTimestamp(u8) {
  const r = new Reader(u8);
  let ts = 0;
  each(r, u8.length, (f, wt) => {
    if (f === 1 && wt === 2) ts = header(r, r.end()).ts;
    else return false;
  });
  return ts;
}

export function decodeVehicles(u8) {
  const r = new Reader(u8);
  const out = [];
  let ts = 0;
  each(r, u8.length, (f, wt) => {
    if (f === 1 && wt === 2) ts = header(r, r.end()).ts;
    else if (f === 2 && wt === 2) {
      each(r, r.end(), (f2, wt2) => {
        if (f2 !== 4 || wt2 !== 2) return false;
        const v = {
          id: '', tripId: '', routeId: '', dir: -1, startDate: '',
          lat: 0, lon: 0, bearing: -1, speed: -1, odometer: -1,
          seq: -1, stopId: '', status: 2, ts: 0, occ: -1,
        };
        each(r, r.end(), (f3) => {
          if (f3 === 1) {
            const t = trip(r, r.end());
            v.tripId = t.tripId; v.routeId = t.routeId; v.dir = t.dir; v.startDate = t.startDate;
          } else if (f3 === 2) {
            each(r, r.end(), (f4) => {
              if (f4 === 1) v.lat = r.f32();
              else if (f4 === 2) v.lon = r.f32();
              else if (f4 === 3) v.bearing = r.f32();
              else if (f4 === 4) v.odometer = r.f64();
              else if (f4 === 5) v.speed = r.f32();
              else return false;
            });
          } else if (f3 === 3) v.seq = r.uint();
          else if (f3 === 7) v.stopId = r.str();
          else if (f3 === 4) v.status = r.uint();
          else if (f3 === 5) v.ts = r.uint();
          else if (f3 === 8) v.id = vehicleId(r, r.end());
          else if (f3 === 9) v.occ = r.uint();
          else return false;
        });
        out.push(v);
      });
    } else return false;
  });
  return { ts, vehicles: out };
}

// Stop-time updates come back flat: [seq, time, delay, seq, time, delay, ...].
// time is the arrival time, or the departure time when no arrival is given.
export function decodeTripUpdates(u8) {
  const r = new Reader(u8);
  const out = [];
  let ts = 0;
  each(r, u8.length, (f, wt) => {
    if (f === 1 && wt === 2) ts = header(r, r.end()).ts;
    else if (f === 2 && wt === 2) {
      each(r, r.end(), (f2, wt2) => {
        if (f2 !== 3 || wt2 !== 2) return false;
        const u = { tripId: '', routeId: '', startDate: '', vehicle: '', ts: 0, stops: [] };
        each(r, r.end(), (f3) => {
          if (f3 === 1) {
            const t = trip(r, r.end());
            u.tripId = t.tripId; u.routeId = t.routeId; u.startDate = t.startDate;
          } else if (f3 === 3) u.vehicle = vehicleId(r, r.end());
          else if (f3 === 4) u.ts = r.uint();
          else if (f3 === 2) {
            let seq = -1, arr = 0, dep = 0, delay = 0, skipped = false;
            each(r, r.end(), (f4) => {
              if (f4 === 1) seq = r.uint();
              else if (f4 === 2 || f4 === 3) {
                each(r, r.end(), (f5) => {
                  if (f5 === 1) delay = r.int32();
                  else if (f5 === 2) {
                    if (f4 === 2) arr = r.uint();
                    else dep = r.uint();
                  } else return false;
                });
              } else if (f4 === 5) skipped = r.uint() === 1;
              else return false;
            });
            if (!skipped) u.stops.push(seq, arr || dep, delay);
          } else return false;
        });
        out.push(u);
      });
    } else return false;
  });
  return { ts, trips: out };
}
