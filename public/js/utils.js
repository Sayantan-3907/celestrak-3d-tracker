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
