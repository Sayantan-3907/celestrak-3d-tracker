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
    // ---------------------------------------------------------------------------
    // Try the backend API first.  If the server isn't running at all (static
    // file open, GitHub Pages, cold Vercel cold-start, etc.) every /api/* route
    // returns 404.  We detect that case and fall back to hardcoded TLEs so the
    // globe always renders something useful.
    // ---------------------------------------------------------------------------

    // Silently probe /api/metadata — never surface its failure as a toast.
    fetch('/api/metadata').catch(() => { });

    let groupsRes, satsRes;
    try {
      [groupsRes, satsRes] = await Promise.all([
        fetch('/api/groups'),
        fetch(groups && groups.length ? `/api/satellites?groups=${groups.join(',')}` : '/api/satellites'),
      ]);
    } catch (networkErr) {
      // Complete network failure (e.g. no server, offline).
      console.warn('[orbital] Backend unreachable:', networkErr.message, '— using built-in fallback TLEs.');
      return this._loadFallback();
    }

    // If both core endpoints 404, the backend is simply not running.
    if (groupsRes.status === 404 && satsRes.status === 404) {
      console.warn('[orbital] Backend not running (404 on /api/groups + /api/satellites) — using built-in fallback TLEs.');
      return this._loadFallback();
    }

    // /api/groups non-ok is a soft warning — labels may be missing but not fatal.
    if (!groupsRes.ok) {
      console.warn(`[orbital] Failed to load group metadata (HTTP ${groupsRes.status}); UI labels may be missing.`);
    }

    // /api/satellites non-ok (except 502, which means partial upstream failure) is fatal.
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

    this._ingestSatelliteGroups(satsJson.groups || {});

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
   * Hardcoded TLE fallback — used when the Express backend is not running
   * (static file open, GitHub Pages deployment, etc.).  TLEs are approximate
   * and will drift; they exist purely so the globe is never blank.
   * @private
   */
  _loadFallback() {
    const FALLBACK = [
      {
        id: 'stations-25544', name: 'ISS (ZARYA)', noradId: '25544', group: 'stations',
        line1: '1 25544U 98067A   24287.54791667  .00020351  00000+0  36438-3 0  9993',
        line2: '2 25544  51.6402 208.9163 0006317 310.8535 203.8833 15.50099522476944',
        periodMinutes: 92.9, inclination: 51.64, eccentricity: 0.0006317,
      },
      {
        id: 'stations-48274', name: 'TIANGONG', noradId: '48274', group: 'stations',
        line1: '1 48274U 21035A   24287.50000000  .00013916  00000+0  16064-3 0  9990',
        line2: '2 48274  41.4737 203.5350 0005708 239.9485 120.1101 15.61501709181931',
        periodMinutes: 92.2, inclination: 41.47, eccentricity: 0.0005708,
      },
    ];

    this.groupsMeta = [{ key: 'stations', label: 'Space Stations', color: '#4FD1C5' }];
    this.fetchedAt = Date.now();
    this.stale = true;

    this._ingestSatelliteGroups({ stations: FALLBACK });

    console.info(`[orbital] Fallback mode: loaded ${this.records.size} built-in satellite(s).`);
    return {
      totalCount: this.records.size,
      groups: this.groupsMeta,
      stale: true,
      errors: null,
    };
  }

  /**
   * Parses a {groupKey -> item[]} map into this.records / this.byGroup.
   * Each item must have {id, name, noradId, group, line1, line2, periodMinutes,
   * inclination, eccentricity}.
   * @private
   */
  _ingestSatelliteGroups(groupsMap) {
    this.records.clear();
    this.byGroup.clear();

    for (const [groupKey, list] of Object.entries(groupsMap)) {
      const groupRecords = [];
      for (const item of list) {
        let satrec;
        try {
          satrec = satellite.twoline2satrec(item.line1, item.line2);
        } catch (_) {
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
