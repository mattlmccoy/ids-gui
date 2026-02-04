/* ===== ui-operation.js — Operation tab (dashboard layout) ===== */

import store from './state.js';
import { connect as serialConnect, disconnect as serialDisconnect, send } from './serial.js';
import { flashSentButton } from './utils.js';
import { decodeAlarmStatus, isActiveError } from './errors.js';
import { CONFIRMATIONS } from './ui-dialogs.js';

/* ---------- Setpoint Definitions ---------- */
const SETPOINTS = [
  { key: 'Vacuum_SETPOINT',    label: 'Vacuum',         min: 0, max: 100, step: 1, unit: '%' },
  { key: 'Flow_SETPOINT',      label: 'Flow',           min: 0, max: 100, step: 1, unit: '%' },
  { key: 'Temperature_SETPOINT', label: 'Fluid Temp',   min: 0, max: 70,  step: 1, unit: '\u00B0C' },
  { key: 'TemperatureMAX_SETPOINT', label: 'Max Heater', min: 20, max: 100, step: 1, unit: '\u00B0C' },
  { key: 'InputPumpSpeed_SETPOINT', label: 'Input Pump', min: 0, max: 100, step: 1, unit: '%' },
  { key: 'FlushPumpSpeed_SETPOINT', label: 'Flush Pump', min: 0, max: 100, step: 1, unit: '%' },
  { key: 'DrainPumpSpeed_SETPOINT', label: 'Drain Pump', min: 0, max: 100, step: 1, unit: '%' },
  { key: 'ServiceRecirculationPumpSpeed_SETPOINT', label: 'Svc Recirc', min: 0, max: 100, step: 1, unit: '%' },
  { key: 'HeaterTemperature_SETPOINT', label: 'Heater Temp', min: 20, max: 100, step: 1, unit: '\u00B0C' },
  { key: 'PressureMAX_SETPOINT', label: 'Max Pressure', min: 0, max: 100, step: 1, unit: 'psi' },
  { key: 'BulkSupplyTimeout_SETPOINT', label: 'Bulk Timeout', min: 0, max: 3600, step: 1, unit: 's' },
];
const QUICK_SETPOINT_KEYS = new Set(['Vacuum_SETPOINT', 'Flow_SETPOINT', 'Temperature_SETPOINT']);

const nominalSetpoints = {};
const setpointHistory = {};

/* ---------- Indicator Lists ---------- */
const PUMPS = [
  { key: 'InputPump_STATE',        label: 'Input Pump' },
  { key: 'RecirculationPump_STATE', label: 'Recirc Pump' },
  { key: 'DrainPump_STATE',        label: 'Drain Pump' },
  { key: 'BulkSupplyPump_STATE',   label: 'Bulk Supply' },
  { key: 'VacuumPump_STATE',       label: 'Vacuum Pump' },
  { key: 'FlushPump_STATE',        label: 'Flush Pump' },
];

const VALVES = [
  { key: 'ManifoldValve1_STATE', label: 'Manifold Valve' },
  { key: 'DrainValve_STATE',     label: 'Drain Valve' },
  { key: 'BulkSupplyValve_STATE', label: 'Bulk Supply Valve' },
];

const FLOATS = [
  { key: 'SupplyFloat_STATE',         label: 'Supply' },
  { key: 'WeirFloat_STATE',           label: 'Weir' },
  { key: 'WasteFloat_STATE',          label: 'Waste' },
  { key: 'SupplyOverflowFloat_STATE', label: 'Supply OVF' },
  { key: 'WeirOverflowFloat_STATE',   label: 'Weir OVF' },
  { key: 'FlushFloat_STATE',          label: 'Flush' },
  { key: 'ServiceFloat_STATE',        label: 'Service' },
];

const HEATERS = [
  { key: 'MainHeaterSSR_STATE', label: 'Main SSR' },
  { key: 'AUXHeaterSSR_STATE',  label: 'Aux SSR' },
];

export function initOperationTab() {
  const panel = document.getElementById('panel-operation');
  panel.innerHTML = buildHTML();
  bindEvents();
  store.on('data', updateDisplay);
  store.on('connection', updateConnectionUI);
  store.on('error', updateAlarmBanner);
}

const modeCache = {
  Purge_MODE: null,
  Flush_MODE: null,
  Drain_MODE: null,
  Service_MODE: null,
  Bypass_MODE: null
};

function buildHTML() {
  const quickSetpoints = SETPOINTS.filter(sp => QUICK_SETPOINT_KEYS.has(sp.key));
  const otherSetpoints = SETPOINTS.filter(sp => !QUICK_SETPOINT_KEYS.has(sp.key));
  return `
    <!-- Row 1: KPI Tiles — at-a-glance readings -->
    <div class="kpi-grid mb-3">
      <div class="kpi-tile">
        <span class="kpi-label">Fluid Temp</span>
        <span class="kpi-value" id="kpi-fluid-temp" style="color:var(--accent-blue)">--</span>
        <span class="kpi-unit">\u00B0C</span>
      </div>
      <div class="kpi-tile">
        <span class="kpi-label">Main Heater</span>
        <span class="kpi-value" id="kpi-main-heater" style="color:var(--accent-orange)">--</span>
        <span class="kpi-unit">\u00B0C</span>
      </div>
      <div class="kpi-tile">
        <span class="kpi-label">Aux Heater</span>
        <span class="kpi-value" id="kpi-aux-heater" style="color:var(--accent-amber)">--</span>
        <span class="kpi-unit">\u00B0C</span>
      </div>
      <div class="kpi-tile">
        <span class="kpi-label">Vacuum</span>
        <span class="kpi-value" id="kpi-vacuum" style="color:var(--accent-cyan)">--</span>
        <span class="kpi-unit">cmH\u2082O</span>
      </div>
      <div class="kpi-tile">
        <span class="kpi-label">Pressure</span>
        <span class="kpi-value" id="kpi-pressure" style="color:var(--accent-purple)">--</span>
        <span class="kpi-unit">psi</span>
      </div>
      <div class="kpi-tile">
        <span class="kpi-label">Status</span>
        <span class="kpi-value" id="kpi-status" style="font-size:1rem;color:var(--text-muted)">--</span>
        <span class="kpi-unit" id="kpi-error-code">&nbsp;</span>
      </div>
      <div class="kpi-tile kpi-error" id="kpi-error-card">
        <span class="kpi-label">Active Error</span>
        <span class="kpi-value" id="kpi-error-title" style="font-size:0.95rem;color:var(--text-muted)">--</span>
        <span class="kpi-unit" id="kpi-error-detail">&nbsp;</span>
      </div>
    </div>

    <div class="row g-3">
      <!-- Left: Controls + Setpoints -->
      <div class="col-xl-7">
        <!-- System Controls -->
        <div class="dash-card accent-blue mb-3">
          <div class="card-header d-flex align-items-center justify-content-between">
            <span><i class="bi bi-toggles me-1"></i> System Control</span>
            <span class="op-badge op-badge-stop" id="op-status-badge">IDLE</span>
          </div>
          <div class="card-body">
            <div class="d-flex flex-wrap gap-2 mb-3">
              <button class="btn-control btn-connect" id="btn-connect">
                <i class="bi bi-usb-plug me-1"></i>Connect
              </button>
              <button class="btn-control btn-disconnect" id="btn-disconnect" disabled>
                <i class="bi bi-x-circle me-1"></i>Disconnect
              </button>
              <span style="width:1px;background:var(--border-color)"></span>
              <button class="btn-control btn-run" id="btn-run" disabled>
                <i class="bi bi-play-fill me-1"></i>Run
              </button>
              <button class="btn-control btn-stop" id="btn-stop" disabled>
                <i class="bi bi-stop-fill me-1"></i>Stop
              </button>
              <span style="width:1px;background:var(--border-color)"></span>
              <button class="btn-control btn-reboot" id="btn-reboot" disabled>
                <i class="bi bi-arrow-clockwise me-1"></i>Reboot
              </button>
            </div>
            <div class="d-flex flex-wrap gap-2">
              <div class="d-flex gap-1">
                <button class="btn-control btn-mode-on" id="btn-purge-on" disabled>Purge ON</button>
                <button class="btn-control btn-mode-off" id="btn-purge-off" disabled>OFF</button>
              </div>
              <div class="d-flex gap-1">
                <button class="btn-control btn-mode-on" id="btn-flush-on" disabled>Flush ON</button>
                <button class="btn-control btn-mode-off" id="btn-flush-off" disabled>OFF</button>
              </div>
              <div class="d-flex gap-1">
                <button class="btn-control btn-mode-on" id="btn-drain-on" disabled>Drain ON</button>
                <button class="btn-control btn-mode-off" id="btn-drain-off" disabled>OFF</button>
              </div>
              <span style="width:1px;background:var(--border-color)"></span>
              <div class="d-flex gap-1">
                <button class="btn-control btn-mode-on" id="btn-service-on" disabled>Service</button>
                <button class="btn-control btn-mode-off" id="btn-service-off" disabled>OFF</button>
              </div>
              <div class="d-flex gap-1">
                <button class="btn-control btn-mode-on" id="btn-bypass-on" disabled>Bypass</button>
                <button class="btn-control btn-mode-off" id="btn-bypass-off" disabled>OFF</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Quick Setpoints (elevated) -->
        <div class="dash-card accent-purple mb-3">
          <div class="card-header"><i class="bi bi-sliders2 me-1"></i> Quick Setpoints</div>
          <div class="card-body">
            <div class="sp-grid">
              ${quickSetpoints.map(sp => `
                <div class="sp-item">
                  <label>${sp.label}</label>
                  <input type="number" id="input-${sp.key}"
                         min="${sp.min}" max="${sp.max}" step="${sp.step}"
                         placeholder="${sp.min}-${sp.max}">
                  <button class="btn-sp-send btn-send-sp" data-key="${sp.key}">Send</button>
                  <span class="sp-readback" id="val-${sp.key}">--</span>
                  <span class="sp-unit">${sp.unit}</span>
                  <div class="sp-meta">
                    <span>Nominal:</span>
                    <button class="value-chip muted" data-kind="nominal" data-key="${sp.key}">--</button>
                    <span>Recent:</span>
                    <button class="value-chip muted" data-kind="recent" data-idx="0" data-key="${sp.key}">--</button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>

        <!-- Setpoints (2-column grid) -->
        <div class="dash-card accent-purple mb-3">
          <div class="card-header"><i class="bi bi-sliders2 me-1"></i> Setpoints</div>
          <div class="card-body">
            <div class="sp-grid">
              ${otherSetpoints.map(sp => `
                <div class="sp-item">
                  <label>${sp.label}</label>
                  <input type="number" id="input-${sp.key}"
                         min="${sp.min}" max="${sp.max}" step="${sp.step}"
                         placeholder="${sp.min}-${sp.max}">
                  <button class="btn-sp-send btn-send-sp" data-key="${sp.key}">Send</button>
                  <span class="sp-readback" id="val-${sp.key}">--</span>
                  <span class="sp-unit">${sp.unit}</span>
                  <div class="sp-meta">
                    <span>Nominal:</span>
                    <button class="value-chip muted" data-kind="nominal" data-key="${sp.key}">--</button>
                    <span>Recent:</span>
                    <button class="value-chip muted" data-kind="recent" data-idx="0" data-key="${sp.key}">--</button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>

      </div>

      <!-- Right: Indicators -->
      <div class="col-xl-5">
        <!-- Config Files -->
        <div class="dash-card accent-cyan mb-3">
          <div class="card-header"><i class="bi bi-file-earmark-text me-1"></i> Config Files</div>
          <div class="card-body">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <input type="file" id="config-file-input" accept="application/json" class="form-control form-control-sm" style="max-width:260px">
              <button class="btn-control btn-connect" id="btn-config-load">Load Config</button>
              <button class="btn-control btn-run" id="btn-config-save">Save Config</button>
            </div>
            <div class="small mt-2" style="color:var(--text-muted)">
              Load fills inputs only; use Send to apply. Save exports current input values.
            </div>
            <div class="small mt-1" style="color:var(--text-muted)" id="config-status"></div>
          </div>
        </div>
        <!-- Heaters -->
        <div class="dash-card accent-amber mb-3">
          <div class="card-header"><i class="bi bi-fire me-1"></i> Heaters</div>
          <div class="card-body" style="padding:0.5rem 1rem">
            ${HEATERS.map(h => `
              <div class="indicator-row">
                <span class="state-dot off" id="ind-${h.key}"></span>
                <span class="ind-label">${h.label}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Pumps -->
        <div class="dash-card accent-green mb-3">
          <div class="card-header"><i class="bi bi-water me-1"></i> Pumps</div>
          <div class="card-body" style="padding:0.5rem 1rem">
            ${PUMPS.map(p => `
              <div class="indicator-row">
                <span class="state-dot off" id="ind-${p.key}"></span>
                <span class="ind-label">${p.label}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Valves -->
        <div class="dash-card accent-cyan mb-3">
          <div class="card-header"><i class="bi bi-diagram-3 me-1"></i> Valves</div>
          <div class="card-body" style="padding:0.5rem 1rem">
            ${VALVES.map(v => `
              <div class="indicator-row">
                <span class="state-dot off" id="ind-${v.key}"></span>
                <span class="ind-label">${v.label}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Float Switches -->
        <div class="dash-card accent-blue mb-3">
          <div class="card-header"><i class="bi bi-life-preserver me-1"></i> Float Switches</div>
          <div class="card-body" style="padding:0.5rem 1rem">
            ${FLOATS.map(f => `
              <div class="indicator-row">
                <span class="state-dot off" id="ind-${f.key}"></span>
                <span class="ind-label">${f.label}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

/* ---------- Event Binding ---------- */

function bindEvents() {
  document.getElementById('btn-connect').addEventListener('click', () => serialConnect());
  document.getElementById('btn-disconnect').addEventListener('click', () => serialDisconnect());

  document.getElementById('btn-run').addEventListener('click', async () => {
    if (await CONFIRMATIONS.run()) { send('{"Run_MODE":"1"}'); store.log('command', 'Run mode enabled'); }
  });
  document.getElementById('btn-stop').addEventListener('click', async () => {
    if (await CONFIRMATIONS.stop()) { send('{"Run_MODE":"0"}'); store.log('command', 'Run mode stopped'); }
  });
  document.getElementById('btn-reboot').addEventListener('click', async () => {
    if (await CONFIRMATIONS.reboot()) { send('{"WatchdogTrigger_MODE":"1"}'); store.log('command', 'Watchdog reboot triggered'); }
  });

  document.getElementById('btn-purge-on').addEventListener('click', async () => {
    if (await CONFIRMATIONS.purgeOn()) {
      modeCache.Purge_MODE = 1;
      applyModeButtons('Purge_MODE');
      send('{"Purge_MODE":"1"}');
      store.log('command', 'Purge ON');
    }
  });
  document.getElementById('btn-purge-off').addEventListener('click', () => {
    modeCache.Purge_MODE = 0;
    applyModeButtons('Purge_MODE');
    send('{"Purge_MODE":"0"}'); store.log('command', 'Purge OFF');
  });
  document.getElementById('btn-flush-on').addEventListener('click', async () => {
    if (await CONFIRMATIONS.flushOn()) {
      modeCache.Flush_MODE = 1;
      applyModeButtons('Flush_MODE');
      send('{"Flush_MODE":"1"}');
      store.log('command', 'Flush ON');
    }
  });
  document.getElementById('btn-flush-off').addEventListener('click', () => {
    modeCache.Flush_MODE = 0;
    applyModeButtons('Flush_MODE');
    send('{"Flush_MODE":"0"}'); store.log('command', 'Flush OFF');
  });
  document.getElementById('btn-drain-on').addEventListener('click', async () => {
    if (await CONFIRMATIONS.drainOn()) {
      modeCache.Drain_MODE = 1;
      applyModeButtons('Drain_MODE');
      send('{"Drain_MODE":"1"}');
      store.log('command', 'Drain ON');
    }
  });
  document.getElementById('btn-drain-off').addEventListener('click', () => {
    modeCache.Drain_MODE = 0;
    applyModeButtons('Drain_MODE');
    send('{"Drain_MODE":"0"}'); store.log('command', 'Drain OFF');
  });

  document.getElementById('btn-service-on').addEventListener('click', () => {
    modeCache.Service_MODE = 1;
    applyModeButtons('Service_MODE');
    send('{"Service_MODE":"1"}'); store.log('command', 'Service mode ON');
  });
  document.getElementById('btn-service-off').addEventListener('click', () => {
    modeCache.Service_MODE = 0;
    applyModeButtons('Service_MODE');
    send('{"Service_MODE":"0"}'); store.log('command', 'Service mode OFF');
  });
  document.getElementById('btn-bypass-on').addEventListener('click', () => {
    modeCache.Bypass_MODE = 1;
    applyModeButtons('Bypass_MODE');
    send('{"Bypass_MODE":"1"}'); store.log('command', 'Bypass mode ON');
  });
  document.getElementById('btn-bypass-off').addEventListener('click', () => {
    modeCache.Bypass_MODE = 0;
    applyModeButtons('Bypass_MODE');
    send('{"Bypass_MODE":"0"}'); store.log('command', 'Bypass mode OFF');
  });

  document.querySelectorAll('.btn-send-sp').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      const input = document.getElementById(`input-${key}`);
      const val = input.value.trim();
      if (val === '') return;
      pushHistory(setpointHistory, key, val);
      refreshValueChips(key);
      send(`{"${key}":"${val}"}`);
      flashSentButton(btn, 'Send');
      store.log('command', `Set ${key} = ${val}`);
    });
  });

  document.querySelectorAll('.value-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const key = chip.dataset.key;
      const kind = chip.dataset.kind;
      const idx = chip.dataset.idx ? parseInt(chip.dataset.idx, 10) : null;
      let val = null;
      if (kind === 'nominal') val = nominalSetpoints[key];
      if (kind === 'recent' && idx !== null) val = (setpointHistory[key] || [])[idx];
      if (val === undefined || val === null || val === '--') return;
      const input = document.getElementById(`input-${key}`);
      if (input) input.value = val;
    });
  });

  document.getElementById('btn-config-save')?.addEventListener('click', () => {
    const payload = {
      savedAt: new Date().toISOString(),
      settings: {},
      setpoints: {}
    };
    const settingsInputs = document.querySelectorAll('[id^="set-"]');
    settingsInputs.forEach(input => {
      const key = input.id.replace('set-', '');
      if (input.value !== '') payload.settings[key] = input.value;
    });
    const spInputs = document.querySelectorAll('[id^="input-"]');
    spInputs.forEach(input => {
      const key = input.id.replace('input-', '');
      if (input.value !== '') payload.setpoints[key] = input.value;
    });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ids-config.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('btn-config-load')?.addEventListener('click', async () => {
    const input = document.getElementById('config-file-input');
    const statusEl = document.getElementById('config-status');
    if (!input) return;
    if (!input.files || input.files.length === 0) {
      input.click();
      if (statusEl) statusEl.textContent = 'Select a config file to load.';
      return;
    }
    const file = input.files[0];
    const text = await file.text();
    let json;
    try { json = JSON.parse(text); } catch (_) {
      if (statusEl) statusEl.textContent = 'Invalid JSON file.';
      return;
    }
    let appliedSettings = 0;
    let appliedSetpoints = 0;
    if (json.settings) {
      for (const [key, val] of Object.entries(json.settings)) {
        const el = document.getElementById(`set-${key}`);
        if (el) { el.value = val; appliedSettings++; }
      }
    }
    if (json.setpoints) {
      for (const [key, val] of Object.entries(json.setpoints)) {
        const el = document.getElementById(`input-${key}`);
        if (el) { el.value = val; appliedSetpoints++; }
      }
    }
    if (statusEl) statusEl.textContent = `Loaded ${appliedSettings} settings and ${appliedSetpoints} setpoints.`;
  });
}

/* ---------- Display Updates ---------- */

function updateDisplay(data) {
  // KPI tiles
  if (data.FluidTemperature_STATE !== undefined)
    document.getElementById('kpi-fluid-temp').textContent = parseFloat(data.FluidTemperature_STATE).toFixed(1);
  if (data.MainHeaterTemperature_STATE !== undefined)
    document.getElementById('kpi-main-heater').textContent = parseFloat(data.MainHeaterTemperature_STATE).toFixed(1);
  if (data.AUXHeaterTemperature_STATE !== undefined)
    document.getElementById('kpi-aux-heater').textContent = parseFloat(data.AUXHeaterTemperature_STATE).toFixed(1);
  if (data.Vacuum_STATE !== undefined)
    document.getElementById('kpi-vacuum').textContent = data.Vacuum_STATE;
  if (data.Pressure_STATE !== undefined)
    document.getElementById('kpi-pressure').textContent = data.Pressure_STATE;

  // Setpoint readbacks
  for (const sp of SETPOINTS) {
    const el = document.getElementById(`val-${sp.key}`);
    if (el && data[sp.key] !== undefined) {
      el.textContent = data[sp.key];
      if (nominalSetpoints[sp.key] === undefined) {
        nominalSetpoints[sp.key] = data[sp.key];
        refreshValueChips(sp.key);
      }
    }
  }

  // Binary indicators
  const allInds = [...PUMPS, ...VALVES, ...FLOATS];
  for (const ind of allInds) {
    const el = document.getElementById(`ind-${ind.key}`);
    if (!el || data[ind.key] === undefined) continue;
    el.className = 'state-dot ' + (parseInt(data[ind.key]) === 1 ? 'on' : 'off');
  }
  for (const h of HEATERS) {
    const el = document.getElementById(`ind-${h.key}`);
    if (!el || data[h.key] === undefined) continue;
    el.className = 'state-dot ' + (parseInt(data[h.key]) === 1 ? 'heat' : 'off');
  }

  // Error / status
  if (data.ErrorCode_STATE !== undefined || data.AlarmStatus !== undefined) {
    const raw = data.AlarmStatus ?? data.ErrorCode_STATE ?? '';
    updateErrorCard(raw);
  }

  // Mode button visuals (highlight active selection)
  applyModeButtons('Purge_MODE', data);
  applyModeButtons('Flush_MODE', data);
  applyModeButtons('Drain_MODE', data);
  applyModeButtons('Service_MODE', data);
  applyModeButtons('Bypass_MODE', data);
}

function pushHistory(map, key, val) {
  if (!map[key]) map[key] = [];
  const list = map[key];
  list.unshift(val);
  if (list.length > 1) list.length = 1;
}

function refreshValueChips(key) {
  const nom = nominalSetpoints[key];
  const recent = setpointHistory[key] || [];
  document.querySelectorAll(`.value-chip[data-key="${key}"][data-kind="nominal"]`).forEach(el => {
    el.textContent = nom !== undefined ? nom : '--';
    el.classList.toggle('muted', nom === undefined);
  });
  document.querySelectorAll(`.value-chip[data-key="${key}"][data-kind="recent"][data-idx="0"]`).forEach(el => {
    const v = recent[0];
    el.textContent = v !== undefined ? v : '--';
    el.classList.toggle('muted', v === undefined);
  });
}

function updateErrorCard(raw) {
  const { opStatus, error } = decodeAlarmStatus(raw);
  const badge = document.getElementById('op-status-badge');
  const kpiStatus = document.getElementById('kpi-status');
  const kpiError = document.getElementById('kpi-error-code');
  const kpiErrorTitle = document.getElementById('kpi-error-title');
  const kpiErrorDetail = document.getElementById('kpi-error-detail');
  const kpiErrorCard = document.getElementById('kpi-error-card');

  // Op status badge
  if (opStatus) {
    const key = opStatus.label.toUpperCase();
    const badgeMap = { RUNNING: 'op-badge-run', STOPPED: 'op-badge-stop', PURGING: 'op-badge-purge', FLUSHING: 'op-badge-flush', DRAINING: 'op-badge-drain' };
    badge.textContent = opStatus.label;
    badge.className = `op-badge ${badgeMap[key] || 'op-badge-stop'}`;
    kpiStatus.textContent = opStatus.label;
    kpiStatus.style.color = '';
  } else {
    badge.textContent = 'IDLE';
    badge.className = 'op-badge op-badge-stop';
    kpiStatus.textContent = raw || '--';
  }

  if (isActiveError(error.code)) {
    kpiError.textContent = error.code;
    kpiError.style.color = 'var(--accent-red)';
    if (kpiErrorTitle) kpiErrorTitle.textContent = `${error.code} \u2014 ${error.title}`;
    if (kpiErrorDetail) kpiErrorDetail.textContent = error.action || error.detail || '';
    if (kpiErrorTitle) kpiErrorTitle.style.color = 'var(--accent-red)';
    if (kpiErrorCard) {
      kpiErrorCard.classList.remove('severity-info', 'severity-warning', 'severity-critical');
      kpiErrorCard.classList.add(`severity-${error.severity || 'critical'}`);
    }
  } else {
    kpiError.innerHTML = '&nbsp;';
    kpiError.style.color = '';
    if (kpiErrorTitle) { kpiErrorTitle.textContent = '--'; kpiErrorTitle.style.color = 'var(--text-muted)'; }
    if (kpiErrorDetail) kpiErrorDetail.innerHTML = '&nbsp;';
    if (kpiErrorCard) kpiErrorCard.classList.remove('severity-info', 'severity-warning', 'severity-critical');
  }
}

function updateConnectionUI(state) {
  const connected = state === 'CONNECTED';
  document.getElementById('btn-connect').disabled = connected || state === 'CONNECTING';
  document.getElementById('btn-disconnect').disabled = !connected;

  const btns = [
    'btn-run', 'btn-stop', 'btn-reboot',
    'btn-purge-on', 'btn-purge-off', 'btn-flush-on', 'btn-flush-off',
    'btn-drain-on', 'btn-drain-off',
    'btn-service-on', 'btn-service-off', 'btn-bypass-on', 'btn-bypass-off'
  ];
  btns.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !connected;
  });
  document.querySelectorAll('.btn-send-sp').forEach(btn => btn.disabled = !connected);
}

function applyModeButtons(modeKey, data = null) {
  const onId = `btn-${modeKey.toLowerCase().replace('_mode', '')}-on`;
  const offId = `btn-${modeKey.toLowerCase().replace('_mode', '')}-off`;
  const onBtn = document.getElementById(onId);
  const offBtn = document.getElementById(offId);
  if (!onBtn || !offBtn) return;

  // Prefer live data, fallback to last user selection
  let value = data && data[modeKey] !== undefined ? data[modeKey] : modeCache[modeKey];
  if (value === null || value === undefined) return;
  const isOn = parseInt(value) === 1;

  // Highlight the active selection (ON or OFF)
  if (isOn) {
    onBtn.classList.add('btn-mode-on');
    onBtn.classList.remove('btn-mode-off');
    offBtn.classList.add('btn-mode-off');
    offBtn.classList.remove('btn-mode-on');
  } else {
    offBtn.classList.add('btn-mode-on');
    offBtn.classList.remove('btn-mode-off');
    onBtn.classList.add('btn-mode-off');
    onBtn.classList.remove('btn-mode-on');
  }
}

function updateAlarmBanner(payload) {
  const banner = document.getElementById('alarm-banner');
  const msg = document.getElementById('alarm-banner-msg');
  const { error } = decodeAlarmStatus(payload.raw);

  if (isActiveError(error.code)) {
    banner.className = `alarm-banner severity-${error.severity}`;
    msg.textContent = `${error.title}: ${error.detail}`;
    banner.classList.remove('d-none');
  } else {
    banner.classList.add('d-none');
  }
}
