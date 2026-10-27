import { geodeticToScenePosition, RAD2DEG } from './utils.js';

// `satellite` is loaded globally via the UMD build in index.html (satellite.js).
/* global satellite */

/**
 * Loads TLE data from our own backend (never CelesTrak directly — that's
 * the whole point of the proxy) and exposes real-time SGP4 propagation for
 * every satellite, keyed by a stable id.
 */
export class SatelliteManager {
  constructor() {
    /** @type {Map<string, object>} id -> record {id,name,noradId,group,satrec,periodMinutes,...} */
    this.records = new Map();
    /** @type {Map<string, object[]>} group key -> ordered records, used to size GPU buffers */
    this.byGroup = new Map();
    this.groupsMeta = [];
    this.fetchedAt = null;
    this.stale = false;
    /** @type {Map<string, object[]>} group key -> record refs in the exact order written to the GPU buffer this tick (used to map raycast hit index back to a record) */
    this._validOrder = new Map();
  }

  /**
   * Fetches TLE data for the requested groups from the local backend API.
   * @param {string[]} [groups] group keys; omit to fetch every known group
   */
  async load(groups) {
    // Fetch groups metadata and satellite TLEs in parallel.
    // /api/metadata is fetched separately and silently — a 404 or network
    // error there must never surface as a visible red toast.
    const [groupsRes, satsRes] = await Promise.all([
      fetch('/api/groups'),
      fetch(groups && groups.length ? `/api/satellites?groups=${groups.join(',')}` : '/api/satellites'),
    ]);

    // Silently probe /api/metadata; ignore any failure (404, network error, etc.).
    try {
      const metaRes = await fetch('/api/metadata');
      if (!metaRes.ok) {
        console.debug(`[orbital] /api/metadata returned ${metaRes.status} — ignoring.`);
      }
    } catch (_) {
      console.debug('[orbital] /api/metadata unreachable — ignoring.');
    }

    // /api/groups: non-ok is a soft warning, not a hard crash.
    if (!groupsRes.ok) {
      console.warn(`[orbital] Failed to load group metadata (HTTP ${groupsRes.status}); UI labels may be missing.`);
    }

    if (!satsRes.ok && satsRes.status !== 502) {
      throw new Error(`Failed to load satellite data (HTTP ${satsRes.status})`);
    }

    const groupsJson = groupsRes.ok ? await groupsRes.json() : { groups: [] };
    const satsJson = await satsRes.json();

    this.groupsMeta = groupsJson.groups ?? [];
    this.fetchedAt = satsJson.fetchedAt || Date.now();
    this.stale = Boolean(satsJson.stale);

    if (satsJson.errors && Object.keys(satsJson.errors).length > 0) {
      console.warn('[orbital] Some satellite groups failed to load:', satsJson.errors);
    }

    this.records.clear();
    this.byGroup.clear();

    for (const [groupKey, list] of Object.entries(satsJson.groups || {})) {
      const groupRecords = [];
      for (const item of list) {
        let satrec;
        try {
          satrec = satellite.twoline2satrec(item.line1, item.line2);
        } catch (err) {
          continue; // Skip malformed TLEs rather than crash the whole load.
        }
        if (!satrec) continue;

        const record = {
          id: item.id,
          name: item.name,
          noradId: item.noradId,
          group: groupKey,
          satrec,
          periodMinutes: item.periodMinutes,
          inclination: item.inclination,
          eccentricity: item.eccentricity,
          // Populated every propagation tick:
          lat: null,
          lon: null,
          altKm: null,
          velocityKmS: null,
          valid: false,
        };
        this.records.set(record.id, record);
        groupRecords.push(record);
      }
      this.byGroup.set(groupKey, groupRecords);
    }

    if (satsJson.count === 0 && Object.keys(satsJson.errors || {}).length > 0) {
      throw new Error('CelesTrak is unreachable and no cached data is available yet.');
    }

    return {
      totalCount: this.records.size,
      groups: this.groupsMeta,
      stale: this.stale,
      errors: satsJson.errors || null,
    };
  }

  /**
   * Propagates every loaded satellite to the given simulated Date, updating
   * each record's lat/lon/altitude/velocity in place, and writes scene-space
   * positions into the provided Float32Array buffers (one per group).
   *
   * @param {Date} date simulated time to propagate to
   * @param {Map<string, {buffer: Float32Array, count: number}>} groupBuffers
   *   pre-allocated output buffers per group key, mutated in place
   * @returns {number} total number of valid (successfully propagated) satellites
   */
  propagateAll(date, groupBuffers) {
    const gmst = satellite.gstime(date);
    let totalValid = 0;

    for (const [groupKey, records] of this.byGroup) {
      const out = groupBuffers.get(groupKey);
      if (!out) continue;
      let writeIndex = 0;
      const order = [];

      for (const record of records) {
        const posVel = safePropagate(record.satrec, date);
        if (!posVel) {
          record.valid = false;
          continue;
        }
        const geo = satellite.eciToGeodetic(posVel.position, gmst);
        const latDeg = geo.latitude * RAD2DEG;
        const lonDeg = geo.longitude * RAD2DEG;
        const altKm = geo.height;

        record.lat = latDeg;
        record.lon = lonDeg;
        record.altKm = altKm;
        record.velocityKmS = vectorMagnitude(posVel.velocity);
        record.valid = true;

        const p = geodeticToScenePosition(latDeg, lonDeg, altKm);
        out.buffer[writeIndex * 3] = p.x;
        out.buffer[writeIndex * 3 + 1] = p.y;
        out.buffer[writeIndex * 3 + 2] = p.z;
        order.push(record);
        writeIndex += 1;
        totalValid += 1;
      }
      out.count = writeIndex;
      this._validOrder.set(groupKey, order);
    }

    return totalValid;
  }

  /**
   * Maps a raycast hit index (into a group's GPU point buffer) back to the
   * satellite record it currently represents. Must be called with the same
   * `groupBuffers` state produced by the most recent `propagateAll` call.
   * @param {string} groupKey
   * @param {number} index
   * @returns {object|null}
   */
  getRecordAtBufferIndex(groupKey, index) {
    const order = this._validOrder.get(groupKey);
    if (!order || index < 0 || index >= order.length) return null;
    return order[index];
  }

  /**
   * Samples a satellite's ground track across roughly one full orbital
   * period, centered on `date`, for drawing a trail behind it.
   * @param {string} id
   * @param {Date} date center time
   * @param {number} [samples] number of points along the track
   * @returns {Array<{x:number,y:number,z:number}>|null}
   */
  computeGroundTrack(id, date, samples = 160) {
    const record = this.records.get(id);
    if (!record) return null;

    const periodMinutes = record.periodMinutes && record.periodMinutes > 0 ? record.periodMinutes : 100;
    const spanMs = periodMinutes * 60 * 1000;
    const startMs = date.getTime() - spanMs / 2;
    const stepMs = spanMs / samples;

    const points = [];
    for (let i = 0; i <= samples; i++) {
      const t = new Date(startMs + i * stepMs);
      const posVel = safePropagate(record.satrec, t);
      if (!posVel) continue;
      const gmst = satellite.gstime(t);
      const geo = satellite.eciToGeodetic(posVel.position, gmst);
      points.push(
        geodeticToScenePosition(geo.latitude * RAD2DEG, geo.longitude * RAD2DEG, geo.height)
      );
    }
    return points.length >= 2 ? points : null;
  }

  getRecord(id) {
    return this.records.get(id) || null;
  }

  getGroupRecords(groupKey) {
    return this.byGroup.get(groupKey) || [];
  }

  getAllRecords() {
    return Array.from(this.records.values());
  }
}

/** Wraps satellite.propagate with error handling for decayed/invalid TLEs. */
function safePropagate(satrec, date) {
  try {
    const result = satellite.propagate(satrec, date);
    if (!result || !result.position || !result.velocity) return null;
    if (
      !Number.isFinite(result.position.x) ||
      !Number.isFinite(result.position.y) ||
      !Number.isFinite(result.position.z)
    ) {
      return null;
    }
    return result;
  } catch (err) {
    return null;
  }
}

function vectorMagnitude(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}
