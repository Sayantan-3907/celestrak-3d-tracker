/**
 * ORBITAL — Real-Time Satellite Tracker
 * Backend server (Node.js / Express)
 *
 * Responsibilities:
 *  - Fetch TLE (Two-Line Element) data from CelesTrak on behalf of the client,
 *    which avoids browser CORS restrictions and keeps CelesTrak from being
 *    hammered by every page load (they rate-limit / block abusive clients).
 *  - Cache each satellite group in memory with a TTL, serving stale cached
 *    data (rather than failing) if CelesTrak is unreachable.
 *  - Serve a small, clean JSON API for the frontend, plus the static SPA.
 *
 * Requires Node.js 18+ (uses the built-in global `fetch`).
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Satellite group configuration
// ---------------------------------------------------------------------------
// Each key is the identifier the frontend uses; `celestrakGroup` is the value
// CelesTrak expects for its `GROUP` query parameter. `label` and `color` are
// forwarded to the client so the UI can stay in sync with the backend's
// canonical list without duplicating it.
const SATELLITE_GROUPS = {
  stations: {
    celestrakGroup: 'stations',
    label: 'Space Stations',
    color: '#4FD1C5',
  },
  starlink: {
    celestrakGroup: 'starlink',
    label: 'Starlink',
    color: '#9F7AEA',
  },
  visual: {
    celestrakGroup: 'visual',
    label: 'Brightest',
    color: '#E8A33D',
  },
  gps: {
    celestrakGroup: 'gps-ops',
    label: 'GPS Operational',
    color: '#63B3ED',
  },
  weather: {
    celestrakGroup: 'weather',
    label: 'Weather',
    color: '#68D391',
  },
};

const CELESTRAK_BASE_URL = 'https://celestrak.org/NORAD/elements/gp.php';
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — CelesTrak asks clients not to poll more often than this
const FETCH_TIMEOUT_MS = 10000; // 10 seconds – fits Vercel serverless function timeout
// Starlink alone carries several thousand TLEs. We cap it so the browser
// stays responsive; raise/remove this if your machine can take it.
const MAX_SATELLITES_PER_GROUP = {
  starlink: 1200,
};

// ---------------------------------------------------------------------------
// Hardcoded TLE fallback — used when CelesTrak is unreachable and the cache
// is empty (first-run / cold-start scenario).  Only covers the "stations"
// group.  Update periodically; TLEs decay in accuracy after ~weeks.
// ---------------------------------------------------------------------------
const FALLBACK_TLE = {
  stations: [
    {
      name: 'ISS (ZARYA)',
      line1: '1 25544U 98067A   24287.54791667  .00020351  00000+0  36438-3 0  9993',
      line2: '2 25544  51.6402 208.9163 0006317 310.8535 203.8833 15.50099522476944',
    },
    {
      name: 'TIANGONG',
      line1: '1 48274U 21035A   24287.50000000  .00013916  00000+0  16064-3 0  9990',
      line2: '2 48274  41.4737 203.5350 0005708 239.9485 120.1101 15.61501709181931',
    },
  ],
};

/** In-memory cache: { [groupKey]: { data: Satellite[], fetchedAt: number, stale: boolean } } */
const cache = Object.create(null);

/**
 * Parses raw CelesTrak TLE text (3 lines per satellite: name, line1, line2)
 * into structured satellite objects.
 * @param {string} text Raw TLE text response from CelesTrak
 * @param {string} groupKey The internal group key this data belongs to
 * @returns {Array<object>}
 */
function parseTLEText(text, groupKey) {
  const rawLines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const satellites = [];
  for (let i = 0; i + 2 < rawLines.length; i += 3) {
    const name = rawLines[i] ? rawLines[i].trim() : null;
    const line1 = rawLines[i + 1];
    const line2 = rawLines[i + 2];

    if (!name || !line1 || !line2) continue;
    if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) continue;

    const noradId = line1.substring(2, 7).trim();
    const classification = line1.charAt(7);
    const meanMotion = parseFloat(line2.substring(52, 63));
    const eccentricity = parseFloat(`0.${line2.substring(26, 33).trim()}`);
    const inclination = parseFloat(line2.substring(8, 16));

    // Orbital period in minutes, derived from mean motion (revolutions/day).
    const periodMinutes =
      Number.isFinite(meanMotion) && meanMotion > 0 ? 1440 / meanMotion : null;

    satellites.push({
      id: `${groupKey}-${noradId}`,
      name,
      noradId,
      group: groupKey,
      classification,
      line1,
      line2,
      inclination: Number.isFinite(inclination) ? inclination : null,
      eccentricity: Number.isFinite(eccentricity) ? eccentricity : null,
      periodMinutes,
    });
  }
  return satellites;
}

/**
 * Fetches a single TLE text resource with a timeout, throwing on any
 * non-2xx response or network failure.
 */
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'orbital-satellite-tracker/1.0 (localhost demo)' },
    });
    if (!response.ok) {
      throw new Error(`CelesTrak responded with HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns cached satellite data for a group, refreshing from CelesTrak when
 * the cache is missing or expired. Falls back to stale cache data (marking
 * it as such) if a refresh attempt fails, so a CelesTrak outage never takes
 * the whole app down.
 * @param {string} groupKey
 * @returns {Promise<{ data: object[], fetchedAt: number, stale: boolean }>}
 */
async function getGroupData(groupKey) {
  const groupConfig = SATELLITE_GROUPS[groupKey];
  if (!groupConfig) {
    throw new Error(`Unknown satellite group: ${groupKey}`);
  }

  const cached = cache[groupKey];
  const isFresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
  if (isFresh) {
    return cached;
  }

  const url = `${CELESTRAK_BASE_URL}?GROUP=${encodeURIComponent(
    groupConfig.celestrakGroup
  )}&FORMAT=tle`;

  try {
    const text = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    let satellites = parseTLEText(text, groupKey);

    if (satellites.length === 0) {
      throw new Error('CelesTrak returned no parsable TLE records');
    }

    const cap = MAX_SATELLITES_PER_GROUP[groupKey];
    if (cap && satellites.length > cap) {
      satellites = satellites.slice(0, cap);
    }

    const entry = { data: satellites, fetchedAt: Date.now(), stale: false };
    cache[groupKey] = entry;
    return entry;
  } catch (err) {
    if (cached) {
      // Serve what we have rather than fail outright.
      console.error(
        `[orbital] Refresh failed for "${groupKey}" (${err.message}); serving stale cache from ${new Date(
          cached.fetchedAt
        ).toISOString()}.`
      );
      return { ...cached, stale: true };
    }

    // No cache yet — try the hardcoded fallback so the app never 502s on
    // a cold start when CelesTrak is temporarily unreachable.
    if (FALLBACK_TLE[groupKey]) {
      console.warn(
        `[orbital] CelesTrak unreachable for "${groupKey}" (${err.message}); falling back to hardcoded TLE data.`
      );
      const fallbackSats = parseTLEText(
        FALLBACK_TLE[groupKey].map((t) => `${t.name}\n${t.line1}\n${t.line2}`).join('\n'),
        groupKey
      );
      const entry = { data: fallbackSats, fetchedAt: Date.now(), stale: true };
      cache[groupKey] = entry;
      return entry;
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json());

// Basic request logging, useful when running locally.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `[orbital] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

/**
 * GET /api/groups
 * Returns the canonical list of satellite groups the backend knows about,
 * so the frontend never has to hard-code labels/colors independently.
 */
app.get('/api/groups', (req, res) => {
  const groups = Object.entries(SATELLITE_GROUPS).map(([key, cfg]) => ({
    key,
    label: cfg.label,
    color: cfg.color,
  }));
  res.json({ groups });
});

/**
 * GET /api/satellites?groups=stations,starlink,visual
 * Returns TLE + metadata for the requested groups (defaults to all known
 * groups). Each group is fetched/cached independently, and a failure in one
 * group does not prevent the others from being returned.
 */
app.get('/api/satellites', async (req, res) => {
  const requested =
    typeof req.query.groups === 'string' && req.query.groups.trim().length > 0
      ? req.query.groups.split(',').map((g) => g.trim()).filter(Boolean)
      : Object.keys(SATELLITE_GROUPS);

  const unknown = requested.filter((g) => !SATELLITE_GROUPS[g]);
  if (unknown.length > 0) {
    return res.status(400).json({
      error: `Unknown satellite group(s): ${unknown.join(', ')}`,
      knownGroups: Object.keys(SATELLITE_GROUPS),
    });
  }

  const results = await Promise.allSettled(requested.map((key) => getGroupData(key)));

  const groups = {};
  const errors = {};
  let totalCount = 0;
  let anyStale = false;
  let oldestFetch = Date.now();

  requested.forEach((key, i) => {
    const outcome = results[i];
    if (outcome.status === 'fulfilled') {
      groups[key] = outcome.value.data;
      totalCount += outcome.value.data.length;
      anyStale = anyStale || outcome.value.stale;
      oldestFetch = Math.min(oldestFetch, outcome.value.fetchedAt);
    } else {
      groups[key] = [];
      errors[key] = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    }
  });

  const httpStatus = Object.keys(errors).length === requested.length ? 502 : 200;

  res.status(httpStatus).json({
    groups,
    count: totalCount,
    stale: anyStale,
    fetchedAt: oldestFetch,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
  });
});

/**
 * GET /api/metadata
 * Returns a minimal status object so frontend code that probes this endpoint
 * never receives a 404 (which would surface as a red toast in the UI).
 */
app.get('/api/metadata', (req, res) => {
  res.json({ status: 'ok', group: 'stations' });
});

/**
 * GET /api/health
 * Lightweight health/status endpoint, also useful for confirming the server
 * is up during local development.
 */
app.get('/api/health', (req, res) => {
  const cacheStatus = Object.fromEntries(
    Object.entries(cache).map(([key, entry]) => [
      key,
      { count: entry.data.length, fetchedAt: entry.fetchedAt, stale: entry.stale },
    ])
  );
  res.json({ status: 'ok', uptimeSeconds: process.uptime(), cache: cacheStatus });
});

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// SPA fallback: any non-API GET request falls through to index.html.
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ---------------------------------------------------------------------------
// Central error handler (catches thrown/rejected errors from routes above)
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('[orbital] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  ORBITAL satellite tracker running at http://localhost:${PORT}\n`);
    console.log('  API endpoints:');
    console.log(`    GET http://localhost:${PORT}/api/satellites`);
    console.log(`    GET http://localhost:${PORT}/api/groups`);
    console.log(`    GET http://localhost:${PORT}/api/health`);
    console.log(`    GET http://localhost:${PORT}/api/metadata\n`);
  });
}
module.exports = app;
