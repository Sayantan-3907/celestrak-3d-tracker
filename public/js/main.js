import { OrbitalScene } from './scene.js';
import { SatelliteManager } from './satellites.js';
import { UIController } from './ui.js';
import { TimeController } from './timeControl.js';
import { formatClockUTC, geodeticToScenePosition } from './utils.js';

// How often (ms) satellite positions are recomputed via SGP4. Decoupled from
// the render loop (which stays at display refresh rate for smooth camera
// motion) — physics at 10Hz is visually indistinguishable from every-frame
// for orbital motion and keeps CPU usage sane with thousands of satellites.
const PROPAGATION_INTERVAL_MS = 100;
// How often (ms) the selected satellite's ground-track trail is resampled.
const TRAIL_REFRESH_INTERVAL_MS = 2000;

const dom = {
  sceneContainer: document.getElementById('scene-container'),
  searchInput: document.getElementById('search-input'),
  groupFilters: document.getElementById('group-filters'),
  satelliteList: document.getElementById('satellite-list'),
  satCount: document.getElementById('sat-count'),
  telemetryPanel: document.getElementById('telemetry-panel'),
  viewportHint: document.getElementById('viewport-hint'),
  sidebar: document.getElementById('sidebar'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  sidebarBackdrop: document.getElementById('sidebar-backdrop'),
  toast: document.getElementById('toast'),
  statusDot: document.getElementById('status-dot'),
  statusPing: document.getElementById('status-ping'),
  clockUtc: document.getElementById('clock-utc'),
  resetCameraBtn: document.getElementById('reset-camera'),
  playPauseBtn: document.getElementById('btn-play-pause'),
  resetTimeBtn: document.getElementById('btn-reset-time'),
  speedButtons: document.getElementById('speed-buttons'),
  simTimeLabel: document.getElementById('sim-time'),
};

const orbitalScene = new OrbitalScene(dom.sceneContainer);
const satelliteManager = new SatelliteManager();
const timeController = new TimeController({
  playPauseButton: dom.playPauseBtn,
  resetButton: dom.resetTimeBtn,
  speedContainer: dom.speedButtons,
  simTimeLabel: dom.simTimeLabel,
  clockLabel: null,
});

let selectedId = null;
let followEnabled = true;
let trailEnabled = true;
let lastTrailRefresh = 0;

const ui = new UIController(dom, {
  onSelect: (id) => selectSatellite(id),
  onDeselect: () => selectSatellite(null),
  onFilterChange: (groupKey) => {
    for (const g of satelliteManager.groupsMeta) {
      orbitalScene.setLayerVisible(g.key, groupKey === 'all' || groupKey === g.key);
    }
  },
  onToggleFollow: (enabled) => {
    followEnabled = enabled;
    if (!enabled) orbitalScene.clearFollow();
  },
  onToggleTrail: (enabled) => {
    trailEnabled = enabled;
    if (!enabled) orbitalScene.setTrail(null);
    else refreshTrail(true);
  },
});

dom.resetCameraBtn.addEventListener('click', () => orbitalScene.resetCamera());

// Click-to-select directly on the 3D globe, in addition to the sidebar list.
dom.sceneContainer.addEventListener('click', (event) => {
  const rect = dom.sceneContainer.getBoundingClientRect();
  const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
  const hit = orbitalScene.raycastSatellites(ndcX, ndcY);
  if (hit) {
    const record = satelliteManager.getRecordAtBufferIndex(hit.groupKey, hit.index);
    if (record) selectSatellite(record.id);
  }
});

/** Per-group GPU buffers sized to each group's satellite count. */
const groupBuffers = new Map();

async function bootstrap() {
  try {
    const { totalCount, groups, stale, errors } = await satelliteManager.load();

    ui.setGroups(groups);
    ui.setSatellites(satelliteManager.getAllRecords());
    ui.updateSatCount(totalCount);

    for (const g of groups) {
      const records = satelliteManager.getGroupRecords(g.key);
      const capacity = Math.max(records.length, 1);
      orbitalScene.ensureSatelliteLayer(g.key, g.color, capacity);
      groupBuffers.set(g.key, { buffer: new Float32Array(capacity * 3), count: 0 });
    }

    if (errors) {
      const failedGroups = Object.keys(errors).join(', ');
      ui.showToast(`Some groups failed to load from CelesTrak: ${failedGroups}`, 'warn');
    } else if (stale) {
      ui.showToast('Showing cached TLE data — CelesTrak refresh is pending.', 'warn');
    } else {
      ui.showToast(`Loaded ${totalCount.toLocaleString()} satellites.`, 'info');
    }

    setStatus(true);
  } catch (err) {
    console.error(err);
    setStatus(false);
    ui.showToast(err.message || 'Failed to load satellite data.', 'error');
  }
}

function setStatus(ok) {
  const color = ok ? '#E8A33D' : '#EF4444';
  dom.statusDot.style.background = color;
  dom.statusPing.style.background = color;
  if (!ok) dom.statusPing.style.display = 'none';
}

function selectSatellite(id) {
  selectedId = id;
  const record = id ? satelliteManager.getRecord(id) : null;
  ui.setActiveRow(id);
  ui.renderTelemetry(record);

  if (!record) {
    orbitalScene.setSelectionPosition(null);
    orbitalScene.setTrail(null);
    orbitalScene.clearFollow();
    return;
  }

  if (followEnabled && record.valid) {
    orbitalScene.followPosition(geodeticToScenePosition(record.lat, record.lon, record.altKm));
    orbitalScene.setSelectionPosition(geodeticToScenePosition(record.lat, record.lon, record.altKm));
  }
  refreshTrail(true);
}

function refreshTrail(force) {
  if (!trailEnabled || !selectedId) return;
  const now = performance.now();
  if (!force && now - lastTrailRefresh < TRAIL_REFRESH_INTERVAL_MS) return;
  lastTrailRefresh = now;

  const record = satelliteManager.getRecord(selectedId);
  if (!record) return;
  const color = ui.groupColorByKey.get(record.group) || '#E8A33D';
  const points = satelliteManager.computeGroundTrack(selectedId, timeController.simDate);
  orbitalScene.setTrail(points, color);
}

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------
let lastFrameTime = performance.now();
let lastPropagationTime = 0;

function animate(now) {
  requestAnimationFrame(animate);
  const realDeltaMs = now - lastFrameTime;
  lastFrameTime = now;

  timeController.tick(realDeltaMs);
  dom.clockUtc.textContent = formatClockUTC(timeController.simDate);

  if (now - lastPropagationTime >= PROPAGATION_INTERVAL_MS) {
    lastPropagationTime = now;
    satelliteManager.propagateAll(timeController.simDate, groupBuffers);

    for (const [groupKey, buf] of groupBuffers) {
      orbitalScene.updateGroupPositions(groupKey, buf.buffer, buf.count);
    }

    orbitalScene.updateSolarSystem(timeController.simDate);

    if (selectedId) {
      const record = satelliteManager.getRecord(selectedId);
      if (record && record.valid) {
        ui.updateTelemetryValues(record);
        const pos = geodeticToScenePosition(record.lat, record.lon, record.altKm);
        orbitalScene.setSelectionPosition(pos);
        if (followEnabled) orbitalScene.followPosition(pos);
      }
      refreshTrail(false);
    }
  }

  orbitalScene.render();
}

bootstrap();
requestAnimationFrame(animate);
