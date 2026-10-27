# ORBITAL — Real-Time Satellite Tracker

A localhost web app that renders live satellite positions on a realistic 3D
Earth, propagated with the real SGP4 algorithm from live CelesTrak TLE data.

- **Backend:** Node.js + Express. Fetches TLE data from CelesTrak, caches it
  in memory (2-hour TTL, serves stale data on outage), and exposes a small
  JSON API. This is what keeps the browser from hitting CORS/rate-limit
  issues talking to CelesTrak directly.
- **Frontend:** Vanilla ES modules + Three.js (3D globe) + `satellite.js`
  (SGP4/SDP4 propagation) + Tailwind CSS (UI), served as static files by the
  same Express server — no separate build step required.

---

## 1. Requirements

- Node.js **18 or newer** (the server uses the built-in global `fetch`).
- An internet connection (to reach CelesTrak and the CDN-hosted front-end
  libraries/fonts/textures).

## 2. Setup & run

```bash
# 1. Create the project folder and move into it (skip if you already have these files)
mkdir orbital-satellite-tracker && cd orbital-satellite-tracker

# 2. Install dependencies (package.json is already included)
npm install

# 3. Start the server
npm start

# You should see:
#   ORBITAL satellite tracker running at http://localhost:3000
```

Then open **http://localhost:3000** in your browser.

For auto-restart on file changes during development, use:

```bash
npm run dev
```

To run on a different port:

```bash
PORT=4000 npm start
```

## 3. Project structure

```
orbital-satellite-tracker/
├── package.json
├── server.js                # Express backend: CelesTrak proxy + cache + static hosting
├── public/
│   ├── index.html           # App shell, Tailwind config, CDN imports
│   ├── css/
│   │   └── style.css        # Supplementary styles (scrollbars, list rows, panel)
│   └── js/
│       ├── main.js          # Orchestrator: wires data, scene, UI, and the render loop
│       ├── scene.js         # Three.js: Earth shader, atmosphere, starfield, satellite points
│       ├── satellites.js    # TLE loading + SGP4 propagation via satellite.js
│       ├── ui.js            # Sidebar list, search/filter, telemetry panel, toasts
│       ├── timeControl.js   # Play/pause + time-warp speed controls
│       └── utils.js         # Shared math/formatting helpers
```

## 4. API endpoints

| Endpoint                         | Description                                                        |
|-----------------------------------|----------------------------------------------------------------------|
| `GET /api/satellites`             | All cached satellite groups (TLE + metadata). Accepts `?groups=stations,starlink` |
| `GET /api/groups`                 | Canonical list of known groups (key, label, color)                 |
| `GET /api/health`                 | Server uptime + cache status, useful for debugging                  |

Example:

```bash
curl "http://localhost:3000/api/satellites?groups=stations"
```

## 5. Using the app

- **Search & filter** — use the search box or the group chips (Stations,
  Starlink, Brightest, GPS, Weather) in the left sidebar.
- **Select a satellite** — click it in the sidebar list, or click its dot
  directly on the globe. This opens the telemetry panel (name, NORAD ID,
  live lat/lon/altitude/velocity) and locks the camera onto it.
- **Ground track** — the curved line behind the selected satellite is its
  orbital ground track, sampled across one full orbital period.
- **Time controls** (bottom bar) — play/pause the simulation clock, jump
  back to the current real time, or time-warp from 1x up to 3600x to watch
  orbits sweep across the globe.

## 6. Notes on accuracy & performance

- Positions come from real SGP4/SDP4 propagation (`satellite.js`) against
  live TLEs — accurate to the same degree any TLE-based tracker is (typically
  within a few km near the TLE epoch, degrading over time until CelesTrak's
  next refresh).
- The Starlink group is capped at 1200 satellites server-side
  (`MAX_SATELLITES_PER_GROUP` in `server.js`) since CelesTrak currently lists
  several thousand; raise or remove the cap if your machine can handle it.
- Satellite positions are recomputed 10 times per second (decoupled from the
  render loop), which is visually smooth and keeps CPU usage low even with
  thousands of satellites loaded at once.
- The day/night terminator and ocean specular highlight are driven by an
  approximate subsolar-point calculation (ignores the equation of time —
  accurate to roughly a degree), which is more than enough for a visual
  effect but shouldn't be used for precision solar-angle calculations.

## 7. Troubleshooting

- **"CelesTrak is unreachable and no cached data is available yet."** — your
  network can't reach `celestrak.org`. Check your connection/firewall and
  restart the server.
- **Blank Earth / missing textures** — the app loads Earth textures and
  fonts from CDNs (`threejs.org`, `unpkg.com`, `jsdelivr.net`,
  `fonts.googleapis.com`); make sure your network allows these.
- **Sluggish performance with many satellites** — lower
  `MAX_SATELLITES_PER_GROUP.starlink` in `server.js`, or use the group
  filter chips to view one group at a time.
