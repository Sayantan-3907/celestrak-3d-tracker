// Shared constants and pure helper functions used across the frontend.
// Kept dependency-free (no Three.js import) except where a plain
// {x,y,z} object is all that's needed, so these are easy to unit-test
// and reuse from both scene.js (rendering) and satellites.js (physics).

export const EARTH_RADIUS_KM = 6371;
// Radius of the Earth mesh in Three.js scene units. Everything else
// (satellite altitude, camera distance) is scaled from this.
export const SCENE_EARTH_RADIUS = 5;
export const KM_TO_SCENE = SCENE_EARTH_RADIUS / EARTH_RADIUS_KM;

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/**
 * Converts geodetic latitude/longitude (degrees) and altitude (km above the
 * Earth's surface) into an {x,y,z} point in the scene's Earth-fixed frame.
 * This mapping matches a standard equirectangular world texture where the
 * prime meridian runs through the center of the image.
 *
 * @param {number} latDeg latitude in degrees, -90..90
 * @param {number} lonDeg longitude in degrees, -180..180
 * @param {number} altKm altitude above the Earth's surface, in kilometers
 * @returns {{x:number,y:number,z:number}}
 */
export function geodeticToScenePosition(latDeg, lonDeg, altKm = 0) {
  const radius = SCENE_EARTH_RADIUS + altKm * KM_TO_SCENE;
  const phi = (90 - latDeg) * DEG2RAD;
  const theta = (lonDeg + 180) * DEG2RAD;
  return {
    x: -radius * Math.sin(phi) * Math.cos(theta),
    y: radius * Math.cos(phi),
    z: radius * Math.sin(phi) * Math.sin(theta),
  };
}

/**
 * Approximates the subsolar point (the latitude/longitude directly beneath
 * the sun) for a given Date. This is a well-known simplified approximation
 * (ignores the equation of time and uses a sinusoidal declination model) —
 * accurate to within roughly a degree, which is more than sufficient for
 * driving a visual day/night terminator.
 * @param {Date} date
 * @returns {{lat: number, lon: number}} degrees
 */
export function computeSubsolarPoint(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start) / 86400000);

  // Solar declination approximation (NOAA simplified formula).
  const declination = 23.44 * Math.sin(DEG2RAD * ((360 / 365) * (dayOfYear - 81)));

  // Subsolar longitude: the longitude currently experiencing local solar
  // noon. Ignoring the equation of time, that's simply where UTC clock
  // noon lines up with the sun.
  const utcHours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let lon = 180 - utcHours * 15;
  lon = ((lon + 180) % 360 + 360) % 360 - 180; // normalize to -180..180

  return { lat: declination, lon };
}

/** Clamps a number between min and max. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Formats a number with fixed decimals, padding sign for readability. */
export function formatSigned(value, decimals = 2) {
  if (!Number.isFinite(value)) return '—';
  const fixed = Math.abs(value).toFixed(decimals);
  return `${value < 0 ? '-' : ''}${fixed}`;
}

/** Formats a Date as an HH:MM:SS UTC string. */
export function formatClockUTC(date) {
  return date.toISOString().substring(11, 19);
}

/** Formats a Date as a compact "YYYY-MM-DD HH:MM:SS UTC" string. */
export function formatFullUTC(date) {
  return `${date.toISOString().substring(0, 19).replace('T', ' ')} UTC`;
}

/**
 * Simple deterministic hash → [0,1) used to jitter/color procedural content
 * (e.g. starfield brightness) without needing a seeded RNG library.
 */
export function hash01(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------------------
// Astronomical positioning helpers
// ---------------------------------------------------------------------------

/**
 * Julian Day Number for a given Date.
 * @param {Date} date
 * @returns {number}
 */
export function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Computes an accurate geocentric unit vector pointing FROM Earth TO the Sun,
 * in the scene's ECI-like frame (X = vernal equinox, Y = north ecliptic,
 * Z completes right hand).  Uses a low-precision VSOP87 series good to
 * ~0.01° for dates within a few centuries of J2000.
 *
 * @param {Date} date
 * @returns {{x:number, y:number, z:number}} unit vector, scene-space axes
 */
export function computeSunECI(date) {
  const jd  = julianDay(date);
  const T   = (jd - 2451545.0) / 36525.0; // Julian centuries from J2000

  // Geometric mean longitude and mean anomaly of the Sun (degrees)
  const L0  = (280.46646 + 36000.76983 * T) % 360;
  const M   = DEG2RAD * ((357.52911 + 35999.05029 * T - 0.0001537 * T * T) % 360);

  // Equation of centre
  const C   = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
            + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
            +  0.000289 * Math.sin(3 * M);

  // Sun's true longitude (degrees) → ecliptic latitude is ~0
  const sunLon = DEG2RAD * ((L0 + C) % 360);

  // Obliquity of the ecliptic
  const eps = DEG2RAD * (23.439291111 - 0.013004167 * T);

  // Geocentric equatorial unit vector (right-hand, X toward vernal equinox)
  const x =  Math.cos(sunLon);
  const y =  Math.cos(eps) * Math.sin(sunLon);
  const z =  Math.sin(eps) * Math.sin(sunLon);

  // Map to our scene frame: scene Y = ecliptic north, scene X = equinox,
  // scene Z completes the triad (same convention as geodeticToScenePosition).
  return { x, y: z, z: -y };
}

/**
 * Keplerian mean-element table for the 8 major planets + Pluto.
 * Elements referenced to J2000.0 ecliptic / mean equinox.
 * Source: JPL Horizons simplified table (Standish 1992).
 * Each entry: [a0, da,  e0,  de,  I0,  dI,  L0,  dL,  peri0, dperi, node0, dnode]
 *   a   = semi-major axis (AU)
 *   e   = eccentricity
 *   I   = inclination (deg)
 *   L   = mean longitude (deg)
 *   peri= longitude of perihelion (deg)
 *   node= longitude of ascending node (deg)
 *   d*  = rate per Julian century
 */
const PLANET_ELEMENTS = {
  mercury: { a0:0.38709927, da:0.00000037,  e0:0.20563593, de:0.00001906,  I0:7.00497902,  dI:-0.00594749, L0:252.25032350, dL:149472.67411175, w0:77.45779628,  dw:0.16047689,  O0:48.33076593, dO:-0.12534081 },
  venus:   { a0:0.72333566, da:0.00000390,  e0:0.00677672, de:-0.00004107, I0:3.39467605,  dI:-0.00078890, L0:181.97909950, dL: 58517.81538729, w0:131.60246718, dw:0.00268329,  O0:76.67984255, dO:-0.27769418 },
  earth:   { a0:1.00000261, da:0.00000562,  e0:0.01671123, de:-0.00004392, I0:-0.00001531, dI:-0.01294668, L0:100.46457166, dL: 35999.37244981, w0:102.93768193, dw:0.32327364,  O0:0.0,         dO:0.0         },
  mars:    { a0:1.52371034, da:0.00001847,  e0:0.09339410, de:0.00007882,  I0:1.84969142,  dI:-0.00813131, L0: -4.55343205, dL: 19140.30268499, w0:-23.94362959, dw:0.44441088,  O0:49.55953891, dO:-0.29257343 },
  jupiter: { a0:5.20288700, da:-0.00011607, e0:0.04838624, de:-0.00013253, I0:1.30439695,  dI:-0.00183714, L0: 34.39644051, dL:  3034.74612775, w0:14.72847983,  dw:0.21252668,  O0:100.47390909,dO:0.20469106  },
  saturn:  { a0:9.53667594, da:-0.00125060, e0:0.05386179, de:-0.00050991, I0:2.48599187,  dI:0.00193609,  L0: 49.95424423, dL:  1222.49362201, w0:92.59887831,  dw:-0.41897216, O0:113.66242448, dO:-0.28867794 },
  uranus:  { a0:19.18916464,da:-0.00196176, e0:0.04725744, de:-0.00004397, I0:0.77263783,  dI:-0.00242939, L0:313.23810451, dL:   428.48202785, w0:170.95427630, dw:0.40805281,  O0:74.01692503, dO:0.04240589  },
  neptune: { a0:30.06992276,da:0.00026291,  e0:0.00859048, de:0.00005105,  I0:1.77004347,  dI:0.00035372,  L0:-55.12002969,dL:   218.45945325, w0:44.96476227,  dw:-0.32241464, O0:131.78422574, dO:-0.00508664 },
};

/**
 * Computes the heliocentric position of a planet (or Earth) in scene-space
 * units (scene-AU scale) for a given Date.
 *
 * @param {string} name  key of PLANET_ELEMENTS
 * @param {Date}   date
 * @param {number} [sceneAU=80] scene units per 1 AU
 * @returns {{x:number, y:number, z:number}}
 */
export function computePlanetHeliocentricXYZ(name, date, sceneAU = 80) {
  const el = PLANET_ELEMENTS[name];
  if (!el) return { x: 0, y: 0, z: 0 };

  const jd = julianDay(date);
  const T  = (jd - 2451545.0) / 36525.0;

  const a    = el.a0 + el.da * T;
  const e    = el.e0 + el.de * T;
  const I    = DEG2RAD * (el.I0  + el.dI  * T);
  const L    = DEG2RAD * ((el.L0 + el.dL  * T) % 360);
  const wPer = DEG2RAD * (el.w0  + el.dw  * T);
  const O    = DEG2RAD * (el.O0  + el.dO  * T);

  // Argument of perihelion
  const w = wPer - O;
  // Mean anomaly
  let M = (L - wPer + Math.PI * 2) % (Math.PI * 2);
  if (M > Math.PI) M -= Math.PI * 2;

  // Solve Kepler's equation: E - e*sin(E) = M  (Newton iteration)
  let E = M;
  for (let i = 0; i < 6; i++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));

  // Heliocentric position in orbital plane
  const xOrb = a * (Math.cos(E) - e);
  const yOrb = a * Math.sqrt(1 - e * e) * Math.sin(E);

  // Rotate to ecliptic frame
  const cosO = Math.cos(O), sinO = Math.sin(O);
  const cosI = Math.cos(I), sinI = Math.sin(I);
  const cosW = Math.cos(w), sinW = Math.sin(w);

  const xEcl = (cosO * cosW - sinO * sinW * cosI) * xOrb + (-cosO * sinW - sinO * cosW * cosI) * yOrb;
  const yEcl = (sinO * cosW + cosO * sinW * cosI) * xOrb + (-sinO * sinW + cosO * cosW * cosI) * yOrb;
  const zEcl = (sinW * sinI) * xOrb + (cosW * sinI) * yOrb;

  // Map ecliptic XYZ → scene frame (same convention as computeSunECI)
  return {
    x:  xEcl * sceneAU,
    y:  zEcl * sceneAU,
    z: -yEcl * sceneAU,
  };
}
