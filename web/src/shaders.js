// GLSL shared by every surface in the scene.

export const NOISE_GLSL = /* glsl */ `
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) {
      s += a * noise(p);
      p = p * 2.03 + 17.1;
      a *= 0.5;
    }
    return s;
  }
`;

// Light, time and the haze that softens the map into the sea and sky. The
// city has no hard edge: everything past the core fades into the haze colour,
// and so does anything far from the camera.
export const HAZE_GLSL = /* glsl */ `
  uniform float uTime, uNight, uCloud, uFogDist;
  uniform vec3 uSun, uSunColor, uAmbient, uHaze, uCamPos;
  uniform vec2 uWind, uCoreC, uCoreR;
  uniform vec4 uExtent;
  vec3 applyHaze(vec3 col, vec3 w) {
    vec2 d = (w.xz - uCoreC) / uCoreR;
    float edge = smoothstep(0.95, 2.2, length(d));
    float cd = distance(w, uCamPos);
    float fog = 1.0 - exp(-pow(cd / uFogDist, 2.0));
    return mix(col, uHaze, clamp(max(edge, fog), 0.0, 1.0));
  }
`;
