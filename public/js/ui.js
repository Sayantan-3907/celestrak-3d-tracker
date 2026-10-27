const MAX_RENDERED_ROWS = 500;

/**
 * Owns all non-3D DOM: the searchable/filterable satellite list, the
 * telemetry panel, group filter chips, and toast notifications. Pure
 * rendering + event wiring — all orbital math lives in satellites.js.
 */
export class UIController {
  /**
   * @param {object} dom object of DOM element references (see main.js)
   * @param {object} callbacks {onSelect(id), onDeselect(), onSearch(q), onFilterChange(key), onToggleFollow(bool), onToggleTrail(bool)}
   */
  constructor(dom, callbacks) {
    this.dom = dom;
    this.callbacks = callbacks;

    this.allRecords = [];
    this.groupsMeta = [];
    this.groupColorByKey = new Map();
    this.activeGroup = 'all';
    this.searchQuery = '';
    this.selectedId = null;
    this.followEnabled = true;
    this.trailEnabled = true;

    this._wireSearch();
    this._wireSidebarToggle();
  }

  _wireSearch() {
    this.dom.searchInput.addEventListener('input', (e) => {
      this.searchQuery = e.target.value.trim().toLowerCase();
      this.renderList();
    });
  }

  _wireSidebarToggle() {
    const open = () => {
      this.dom.sidebar.classList.add('drawer-open');
      this.dom.sidebarBackdrop.classList.remove('hidden');
    };
    const close = () => {
      this.dom.sidebar.classList.remove('drawer-open');
      this.dom.sidebarBackdrop.classList.add('hidden');
    };
    this.dom.sidebarToggle.addEventListener('click', open);
    this.dom.sidebarBackdrop.addEventListener('click', close);
    this._closeSidebarDrawer = close;
  }

  /** @param {Array<{key:string,label:string,color:string}>} groups */
  setGroups(groups) {
    this.groupsMeta = groups;
    for (const g of groups) this.groupColorByKey.set(g.key, g.color);

    this.dom.groupFilters.innerHTML = '';
    const allChip = this._makeChip('all', 'All', null);
    this.dom.groupFilters.appendChild(allChip);
    for (const g of groups) {
      this.dom.groupFilters.appendChild(this._makeChip(g.key, g.label, g.color));
    }
    this._refreshChips();
  }

  _makeChip(key, label, color) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.dataset.key = key;
    if (color) {
      chip.innerHTML = `<span class="inline-block h-1.5 w-1.5 rounded-full mr-1.5 align-middle" style="background:${color}"></span>${label}`;
    } else {
      chip.textContent = label;
    }
    chip.addEventListener('click', () => {
      this.activeGroup = key;
      this._refreshChips();
      this.renderList();
      if (this.callbacks.onFilterChange) this.callbacks.onFilterChange(key);
    });
    return chip;
  }

  _refreshChips() {
    this.dom.groupFilters.querySelectorAll('.chip').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.key === this.activeGroup);
    });
  }

  /** @param {object[]} records full list from SatelliteManager.getAllRecords() */
  setSatellites(records) {
    this.allRecords = records;
    this.renderList();
  }

  getFilteredRecords() {
    let list = this.allRecords;
    if (this.activeGroup !== 'all') {
      list = list.filter((r) => r.group === this.activeGroup);
    }
    if (this.searchQuery) {
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(this.searchQuery) ||
          String(r.noradId).includes(this.searchQuery)
      );
    }
    return list;
  }

  renderList() {
    const container = this.dom.satelliteList;
    const filtered = this.getFilteredRecords();

    if (this.allRecords.length === 0) {
      container.innerHTML = `<div class="p-6 text-center text-ink-500 text-sm">Fetching TLE data from CelesTrak…</div>`;
      return;
    }

    if (filtered.length === 0) {
      container.innerHTML = `<div class="p-6 text-center text-ink-500 text-sm">No satellites match "${escapeHtml(
        this.searchQuery
      )}".</div>`;
      return;
    }

    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    const shown = sorted.slice(0, MAX_RENDERED_ROWS);

    const frag = document.createDocumentFragment();
    for (const record of shown) {
      frag.appendChild(this._buildRow(record));
    }
    container.innerHTML = '';
    container.appendChild(frag);

    if (sorted.length > MAX_RENDERED_ROWS) {
      const note = document.createElement('div');
      note.className = 'px-4 py-3 text-center text-xs text-ink-500 border-t border-space-600/60';
      note.textContent = `Showing first ${MAX_RENDERED_ROWS} of ${sorted.length} — refine your search to see more.`;
      container.appendChild(note);
    }
  }

  _buildRow(record) {
    const row = document.createElement('div');
    row.className = 'sat-row' + (record.id === this.selectedId ? ' active' : '');
    row.dataset.id = record.id;
    const color = this.groupColorByKey.get(record.group) || '#8C9AB5';
    row.innerHTML = `
      <span class="dot" style="background:${color}"></span>
      <span class="meta">
        <div class="name">${escapeHtml(record.name)}</div>
        <div class="norad">NORAD ${escapeHtml(String(record.noradId))}</div>
      </span>
    `;
    row.addEventListener('click', () => {
      if (this.callbacks.onSelect) this.callbacks.onSelect(record.id);
      this._closeSidebarDrawer();
    });
    return row;
  }

  /** Highlights the active row in the sidebar list (scrolling it into view). */
  setActiveRow(id) {
    this.selectedId = id;
    this.dom.satelliteList.querySelectorAll('.sat-row').forEach((el) => {
      const active = el.dataset.id === id;
      el.classList.toggle('active', active);
      if (active) el.scrollIntoView({ block: 'nearest' });
    });
  }

  updateSatCount(n) {
    this.dom.satCount.textContent = `${n.toLocaleString()} sats`;
  }

  /**
   * Renders the telemetry panel for a selected satellite's latest computed
   * state. Pass `null` to clear/hide the panel.
   * @param {object|null} record
   */
  renderTelemetry(record) {
    const panel = this.dom.telemetryPanel;
    const HIDDEN_CLASS = 'translate-x-[calc(100%+1rem)]';
    if (!record) {
      panel.classList.add(HIDDEN_CLASS);
      panel.innerHTML = '';
      this.dom.viewportHint.style.opacity = '1';
      return;
    }

    this.dom.viewportHint.style.opacity = '0';
    panel.classList.remove(HIDDEN_CLASS);
    const color = this.groupColorByKey.get(record.group) || '#8C9AB5';
    const groupLabel = this.groupsMeta.find((g) => g.key === record.group)?.label || record.group;

    panel.innerHTML = `
      <div class="p-4 sm:p-5">
        <div class="flex items-start justify-between gap-2">
          <div>
            <div class="flex items-center gap-2 mb-1">
              <span class="h-2 w-2 rounded-full" style="background:${color}"></span>
              <span class="text-xs uppercase tracking-wide text-ink-500">${escapeHtml(groupLabel)}</span>
            </div>
            <h2 class="text-base font-semibold leading-snug">${escapeHtml(record.name)}</h2>
          </div>
          <button id="telemetry-close" class="p-1.5 rounded-md hover:bg-space-700 text-ink-500 hover:text-ink-100 transition shrink-0" aria-label="Close telemetry panel">
            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="mt-4 bg-space-800/70 rounded-xl px-4 py-1 border border-space-600/50">
          <div class="telem-row"><span class="telem-label">NORAD ID</span><span class="telem-value">${escapeHtml(String(record.noradId))}</span></div>
          <div class="telem-row"><span class="telem-label">Latitude</span><span class="telem-value" id="tm-lat">—</span></div>
          <div class="telem-row"><span class="telem-label">Longitude</span><span class="telem-value" id="tm-lon">—</span></div>
          <div class="telem-row"><span class="telem-label">Altitude</span><span class="telem-value" id="tm-alt">—</span></div>
          <div class="telem-row"><span class="telem-label">Velocity</span><span class="telem-value" id="tm-vel">—</span></div>
          <div class="telem-row"><span class="telem-label">Orbital period</span><span class="telem-value">${
            record.periodMinutes ? record.periodMinutes.toFixed(1) + ' min' : '—'
          }</span></div>
          <div class="telem-row"><span class="telem-label">Inclination</span><span class="telem-value">${
            record.inclination != null ? record.inclination.toFixed(2) + '°' : '—'
          }</span></div>
        </div>

        <div class="mt-4 flex flex-col gap-2">
          <label class="flex items-center justify-between text-sm text-ink-300 bg-space-800/70 border border-space-600/50 rounded-lg px-3 py-2 cursor-pointer">
            Follow camera
            <input type="checkbox" id="toggle-follow" class="accent-amber-400 h-4 w-4" ${this.followEnabled ? 'checked' : ''} />
          </label>
          <label class="flex items-center justify-between text-sm text-ink-300 bg-space-800/70 border border-space-600/50 rounded-lg px-3 py-2 cursor-pointer">
            Show ground track
            <input type="checkbox" id="toggle-trail" class="accent-amber-400 h-4 w-4" ${this.trailEnabled ? 'checked' : ''} />
          </label>
        </div>
      </div>
    `;

    panel.querySelector('#telemetry-close').addEventListener('click', () => {
      if (this.callbacks.onDeselect) this.callbacks.onDeselect();
    });
    panel.querySelector('#toggle-follow').addEventListener('change', (e) => {
      this.followEnabled = e.target.checked;
      if (this.callbacks.onToggleFollow) this.callbacks.onToggleFollow(this.followEnabled);
    });
    panel.querySelector('#toggle-trail').addEventListener('change', (e) => {
      this.trailEnabled = e.target.checked;
      if (this.callbacks.onToggleTrail) this.callbacks.onToggleTrail(this.trailEnabled);
    });

    this.updateTelemetryValues(record);
  }

  /** Cheap update of just the numeric readouts, called every propagation tick without rebuilding the DOM. */
  updateTelemetryValues(record) {
    const panel = this.dom.telemetryPanel;
    const latEl = panel.querySelector('#tm-lat');
    if (!latEl || !record || !record.valid) return;
    panel.querySelector('#tm-lat').textContent = `${record.lat >= 0 ? 'N' : 'S'} ${Math.abs(record.lat).toFixed(3)}°`;
    panel.querySelector('#tm-lon').textContent = `${record.lon >= 0 ? 'E' : 'W'} ${Math.abs(record.lon).toFixed(3)}°`;
    panel.querySelector('#tm-alt').textContent = `${record.altKm.toFixed(1)} km`;
    panel.querySelector('#tm-vel').textContent = `${record.velocityKmS.toFixed(3)} km/s`;
  }

  showToast(message, variant = 'info') {
    const toast = this.dom.toast;
    const colors = {
      info: 'bg-space-800 border-space-600 text-ink-100',
      error: 'bg-red-950/90 border-red-800 text-red-200',
      warn: 'bg-amber-950/80 border-amber-700 text-amber-200',
    };
    toast.className = `pointer-events-none fixed top-20 left-1/2 -translate-x-1/2 z-50 transition-opacity duration-300 px-4 py-2.5 rounded-lg border text-sm shadow-panel ${
      colors[variant] || colors.info
    }`;
    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.style.opacity = '0';
    }, 4500);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}
