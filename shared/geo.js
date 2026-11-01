// One flat frame for the whole map: metres east (x) and north (y) of a point
// near Hillside. At this size an equirectangular projection is accurate to
// well under a metre, and every coordinate fits in an Int16.
export const LAT0 = 48.455;
export const LON0 = -123.36;
const R = Math.PI / 180;
export const M_LAT = 111132.92 - 559.82 * Math.cos(2 * LAT0 * R) + 1.175 * Math.cos(4 * LAT0 * R);
export const M_LON = 111412.84 * Math.cos(LAT0 * R) - 93.5 * Math.cos(3 * LAT0 * R);

// The baked region, and the part of it that is "home" for the camera.
export const BOUNDS = { west: -123.59, east: -123.13, south: 48.35, north: 48.6 };
export const CORE = { west: -123.44, east: -123.26, south: 48.405, north: 48.51 };

export const toXY = (lon, lat) => [(lon - LON0) * M_LON, (lat - LAT0) * M_LAT];
export const toLonLat = (x, y) => [LON0 + x / M_LON, LAT0 + y / M_LAT];
