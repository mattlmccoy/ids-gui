/* ===== ui-operation.js — Operation tab (dashboard layout) ===== */

import store from './state.js';
import { connect as serialConnect, disconnect as serialDisconnect, send } from './serial.js';
import { flashSentButton } from './utils.js';
import { decodeAlarmStatus, isActiveError } from './errors.js';
import { CONFIRMATIONS, confirm } from './ui-dialogs.js';
import { getHeaterVisibility, setHeaterVisibility, isHeaterVisible, shouldSuppressHeaterError, describeHeaterFault } from './heater-visibility.js';
import { loadNominalConfig } from './nominal-config.js';
import { FLOATS, getFloatDisplayState, formatFloatState } from './float-state.js';

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
  { key: 'flushPump_STATE',        label: 'Flush Pump' },
];

const VALVES = [
  { key: 'ManifoldValve1_STATE', label: 'Manifold Valve' },
  { key: 'ManifoldValve2_STATE', label: 'Manifold Valve 2' },
  { key: 'DrainValve_STATE',     label: 'Drain Valve' },
  { key: 'BulkSupplyValve_STATE', label: 'Bulk Supply Valve' },
  { key: 'BypassValve_STATE', label: 'Bypass Valve' },
  { key: 'flushValve_STATE', label: 'Flush Valve' },
];

const HEATERS = [
  { name: 'MainHeater', key: 'MainHeaterSSR_STATE', tempKey: 'MainHeaterTemperature_STATE', label: 'Main SSR', kpiId: 'kpi-main-heater' },
  { name: 'AuxHeater', key: 'AUXHeaterSSR_STATE', tempKey: 'AUXHeaterTemperature_STATE', label: 'Aux SSR', kpiId: 'kpi-aux-heater' },
];

let configLoaded = false;
let configLoading = false;
let dismissedAlarmRaw = null;

export function initOperationTab() {
  const panel = document.getElementById('panel-operation');
  panel.innerHTML = buildHTML();
  bindEvents();
  initNominalSetpoints();
  store.on('data', updateDisplay);
  store.on('connection', updateConnectionUI);
  store.on('error', updateAlarmBanner);
  store.on('heater-visibility', () => {
    applyHeaterVisibilityUI();
    if (store.alarmRaw) updateErrorCard(store.alarmRaw);
    updateAlarmBanner({ raw: store.alarmRaw || '' });
  });
  store.on('float-config', () => updateDisplay(store.data));
}

const modeCache = {
  Purge_MODE: null,
  Flush_MODE: null,
  Drain_MODE: null,
  Bypass_MODE: null
};

const MODE_TIP_TEXT = {
  purge: 'Purge: clears/recirculates fluid in the line path while stopped. Use this to prep/clear lines before or after operation.',
  flush: 'Flush: runs the cleaning path with flush hardware (flush pump/valve). Best used with the system stopped for maintenance cleaning.',
  drain: 'Drain: routes fluid to waste and empties the system path using drain hardware. Use before service or shutdown cleanup.',
  bypass: 'Bypass: directly opens the bypass valve path, independent of Purge/Flush/Drain toggles.'
};

function buildHTML() {
  const quickSetpoints = SETPOINTS.filter(sp => QUICK_SETPOINT_KEYS.has(sp.key));
  const otherSetpoints = SETPOINTS.filter(sp => !QUICK_SETPOINT_KEYS.has(sp.key));
  return `
    <!-- Row 1: KPI Tiles — at-a-glance readings -->
    <div class="kpi-grid mb-3">
      <div class="kpi-tile" id="kpi-tile-fluid">
        <span class="kpi-label">Fluid Temp</span>
        <span class="kpi-value" id="kpi-fluid-temp" style="color:var(--accent-blue)">--</span>
        <span class="kpi-unit">\u00B0C</span>
      </div>
      <div class="kpi-tile" id="kpi-tile-main-heater">
        <span class="kpi-label">Main Heater</span>
        <span class="kpi-value" id="kpi-main-heater" style="color:var(--accent-orange)">--</span>
        <span class="kpi-unit">\u00B0C</span>
      </div>
      <div class="kpi-tile" id="kpi-tile-aux-heater">
        <span class="kpi-label">Aux Heater</span>
        <span class="kpi-value" id="kpi-aux-heater" style="color:var(--accent-amber)">--</span>
        <span class="kpi-unit">\u00B0C</span>
      </div>
      <div class="kpi-tile" id="kpi-tile-vacuum">
        <span class="kpi-label">Vacuum</span>
        <span class="kpi-value" id="kpi-vacuum" style="color:var(--accent-cyan)">--</span>
        <span class="kpi-unit">cmH\u2082O</span>
        <span class="kpi-unit" id="kpi-vacuum-target-map">SP: --</span>
      </div>
      <div class="kpi-tile" id="kpi-tile-pressure">
        <span class="kpi-label">Pressure</span>
        <span class="kpi-value" id="kpi-pressure" style="color:var(--accent-purple)">--</span>
        <span class="kpi-unit">psi</span>
      </div>
      <div class="kpi-tile" id="kpi-tile-status">
        <span class="kpi-label">Status</span>
        <span class="kpi-value" id="kpi-status" style="font-size:1rem;color:var(--text-muted)">--</span>
        <span class="kpi-unit" id="kpi-error-code">&nbsp;</span>
      </div>
      <div class="kpi-tile kpi-error" id="kpi-error-card">
        <span class="kpi-label">Active Error</span>
        <span class="kpi-value" id="kpi-error-title" style="font-size:0.95rem;color:var(--text-muted)">--</span>
        <span class="kpi-unit" id="kpi-error-detail">&nbsp;</span>
        <button class="btn-control btn-disconnect mt-1 align-self-start" id="btn-error-dismiss" style="padding:0.2rem 0.5rem;font-size:0.72rem" disabled>Dismiss</button>
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
                <button class="btn-control btn-disconnect mode-help-btn" type="button" data-mode-tip
                        title="${MODE_TIP_TEXT.purge}"
                        style="padding:0.3rem 0.45rem;font-size:0.72rem">?</button>
              </div>
              <div class="d-flex gap-1">
                <button class="btn-control btn-mode-on" id="btn-flush-on" disabled>Flush ON</button>
                <button class="btn-control btn-mode-off" id="btn-flush-off" disabled>OFF</button>
                <button class="btn-control btn-disconnect mode-help-btn" type="button" data-mode-tip
                        title="${MODE_TIP_TEXT.flush}"
                        style="padding:0.3rem 0.45rem;font-size:0.72rem">?</button>
              </div>
              <div class="d-flex gap-1">
                <button class="btn-control btn-mode-on" id="btn-drain-on" disabled>Drain ON</button>
                <button class="btn-control btn-mode-off" id="btn-drain-off" disabled>OFF</button>
                <button class="btn-control btn-disconnect mode-help-btn" type="button" data-mode-tip
                        title="${MODE_TIP_TEXT.drain}"
                        style="padding:0.3rem 0.45rem;font-size:0.72rem">?</button>
              </div>
              <span style="width:1px;background:var(--border-color)"></span>
              <div class="d-flex gap-1">
                <button class="btn-control btn-mode-on" id="btn-bypass-on" disabled>Bypass</button>
                <button class="btn-control btn-mode-off" id="btn-bypass-off" disabled>OFF</button>
                <button class="btn-control btn-disconnect mode-help-btn" type="button" data-mode-tip
                        title="${MODE_TIP_TEXT.bypass}"
                        style="padding:0.3rem 0.45rem;font-size:0.72rem">?</button>
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
              <button class="btn-control btn-disconnect" id="btn-config-send-all" disabled>Send All</button>
              <button class="btn-control btn-stop" id="btn-config-nominal">Load Nominal + Send</button>
            </div>
            <div class="small mt-2" style="color:var(--text-muted)">
              'Load' fills inputs. 'Send' or 'Send All' applies values to the controller. 'Save' exports current input values.
            </div>
            <div class="small mt-1" style="color:var(--text-muted)" id="config-status"></div>
            <div class="small mt-1 d-none" id="send-all-progress-wrap" style="color:var(--text-muted)">
              <span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
              <span id="send-all-progress-text">Sending values...</span>
            </div>
            <div class="progress mt-1 d-none" id="send-all-progress-track" style="height:6px;max-width:360px">
              <div class="progress-bar progress-bar-striped progress-bar-animated" id="send-all-progress-bar" role="progressbar" style="width:0%"></div>
            </div>
          </div>
        </div>
        <!-- Heaters -->
        <div class="dash-card accent-amber mb-3">
          <div class="card-header"><i class="bi bi-fire me-1"></i> Heaters</div>
          <div class="card-body" style="padding:0.5rem 1rem">
            ${HEATERS.map(h => `
              <div class="indicator-row heater-row" id="heater-row-${h.name}">
                <span class="state-dot off" id="ind-${h.key}"></span>
                <span class="ind-label">${h.label}</span>
                <button class="btn-control btn-disconnect btn-heater-toggle" id="btn-heater-toggle-${h.name}" data-heater="${h.name}" style="padding:0.2rem 0.5rem;font-size:0.7rem">Mark unused</button>
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
                <span class="ind-value" id="ind-value-${f.key}">--</span>
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
  initModeTooltips();

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
    if (isRunModeActive()) {
      setModeStatusMessage('Purge cannot be enabled while Run is active. Stop first (firmware auto-clears Purge_MODE in Run).');
      return;
    }
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
    if (isRunModeActive()) {
      setModeStatusMessage('Flush cannot be enabled while Run is active. Stop first (firmware auto-clears Flush_MODE in Run).');
      return;
    }
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
    if (isRunModeActive()) {
      setModeStatusMessage('Drain cannot be enabled while Run is active. Stop first (firmware auto-clears Drain_MODE in Run).');
      return;
    }
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

  const sendAllBtn = document.getElementById('btn-config-send-all');
  if (sendAllBtn) {
    sendAllBtn.addEventListener('click', async () => {
      await sendAllConfigValues(sendAllBtn);
    });
  }

  document.querySelectorAll('.btn-send-sp').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      const input = document.getElementById(`input-${key}`);
      const val = input.value.trim();
      if (val === '') return;
      if (!input.checkValidity()) {
        input.reportValidity();
        store.log('warning', `Rejected out-of-range value for ${key}: ${val}`);
        return;
      }
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

  const configInput = document.getElementById('config-file-input');
  const configLoadBtn = document.getElementById('btn-config-load');
  const statusEl = document.getElementById('config-status');
  configLoadBtn?.addEventListener('click', () => {
    if (!configInput) return;
    if (configInput.files && configInput.files.length > 0) {
      loadConfigFile(configInput.files[0]);
      return;
    }
    if (statusEl) statusEl.textContent = 'Select a config file to load.';
    configInput.click();
  });
  configInput?.addEventListener('change', async () => {
    if (!configInput?.files?.length) return;
    await loadConfigFile(configInput.files[0]);
  });
  document.getElementById('btn-config-nominal')?.addEventListener('click', async (e) => {
    await loadNominalIntoInputsAndSend(e.currentTarget);
  });

  document.querySelectorAll('.btn-heater-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const heaterName = btn.dataset.heater;
      if (!heaterName) return;
      setHeaterVisibility(heaterName, !isHeaterVisible(heaterName));
      applyHeaterVisibilityUI();
      if (store.alarmRaw) updateErrorCard(store.alarmRaw);
      updateAlarmBanner({ raw: store.alarmRaw || '' });
    });
  });

  document.getElementById('btn-error-dismiss')?.addEventListener('click', async () => {
    const raw = store.alarmRaw || '';
    const { error } = decodeAlarmStatus(raw);
    if (!isActiveError(error.code)) return;
    const ok = await confirm(
      'Dismiss Active Error',
      `<p class="mb-1"><strong>${error.code} — ${error.title}</strong></p>` +
      `<p class="mb-1">${error.detail}</p>` +
      '<p class="text-warning mb-0">Dismiss hides this current error instance in the UI until the alarm state changes.</p>',
      'Dismiss',
      'btn-warning'
    );
    if (!ok) return;
    dismissedAlarmRaw = raw;
    store.log('info', `Dismissed active error instance (${error.code})`);
    updateErrorCard(raw);
    updateAlarmBanner({ raw });
  });

  applyHeaterVisibilityUI();
  syncSendAllButton();
  applyModeInterlocks();
}

/* ---------- Display Updates ---------- */

function updateDisplay(data) {
  // KPI tiles
  if (data.FluidTemperature_STATE !== undefined)
    document.getElementById('kpi-fluid-temp').textContent = parseFloat(data.FluidTemperature_STATE).toFixed(1);
  if (data.MainHeaterTemperature_STATE !== undefined && isHeaterVisible('MainHeater'))
    document.getElementById('kpi-main-heater').textContent = parseFloat(data.MainHeaterTemperature_STATE).toFixed(1);
  if (data.AUXHeaterTemperature_STATE !== undefined && isHeaterVisible('AuxHeater'))
    document.getElementById('kpi-aux-heater').textContent = parseFloat(data.AUXHeaterTemperature_STATE).toFixed(1);
  if (data.Vacuum_STATE !== undefined)
    document.getElementById('kpi-vacuum').textContent = data.Vacuum_STATE;
  const vacTargetEl = document.getElementById('kpi-vacuum-target-map');
  if (vacTargetEl) {
    const pct = data.Vacuum_SETPOINT;
    vacTargetEl.textContent = pct === undefined ? 'SP(raw): -- %' : `SP(raw): ${pct}%`;
  }
  if (data.Pressure_STATE !== undefined)
    document.getElementById('kpi-pressure').textContent = data.Pressure_STATE;

  // Setpoint readbacks
  for (const sp of SETPOINTS) {
    const el = document.getElementById(`val-${sp.key}`);
    if (el && data[sp.key] !== undefined) {
      el.textContent = data[sp.key];
    }
  }

  // Binary indicators
  const allInds = [...PUMPS, ...VALVES];
  for (const ind of allInds) {
    const el = document.getElementById(`ind-${ind.key}`);
    if (!el || data[ind.key] === undefined) continue;
    el.className = 'state-dot ' + (parseInt(data[ind.key]) === 1 ? 'on' : 'off');
  }
  for (const ind of FLOATS) {
    const el = document.getElementById(`ind-${ind.key}`);
    const valueEl = document.getElementById(`ind-value-${ind.key}`);
    if (!el || data[ind.key] === undefined) continue;
    const state = getFloatDisplayState(ind.key, data[ind.key]);
    el.className = 'state-dot ' + (state === 1 ? 'on' : 'off');
    if (valueEl) valueEl.textContent = formatFloatState(ind.key, data[ind.key]);
  }
  for (const h of HEATERS) {
    const el = document.getElementById(`ind-${h.key}`);
    if (!el || data[h.key] === undefined) continue;
    if (!isHeaterVisible(h.name)) {
      el.className = 'state-dot off';
      continue;
    }
    el.className = 'state-dot ' + (parseInt(data[h.key]) === 1 ? 'heat' : 'off');
  }

  // Error / status
  if (data.ErrorCode_STATE !== undefined || data.AlarmStatus !== undefined) {
    const raw = data.AlarmStatus ?? data.ErrorCode_STATE ?? '';
    if (dismissedAlarmRaw && raw !== dismissedAlarmRaw) dismissedAlarmRaw = null;
    updateErrorCard(raw);
  }

  // Mode button visuals (highlight active selection)
  applyModeButtons('Purge_MODE', data);
  applyModeButtons('Flush_MODE', data);
  applyModeButtons('Drain_MODE', data);
  applyModeButtons('Bypass_MODE', data);
  applyModeInterlocks(data);
  applyHeaterVisibilityUI();
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
  const dismissBtn = document.getElementById('btn-error-dismiss');

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

  const isDismissed = dismissedAlarmRaw && raw === dismissedAlarmRaw;
  const isSuppressed = shouldSuppressHeaterError(error.code, raw);
  if (isActiveError(error.code) && !isSuppressed && !isDismissed) {
    kpiError.textContent = error.code;
    kpiError.style.color = 'var(--accent-red)';
    if (kpiErrorTitle) kpiErrorTitle.textContent = `${error.code} \u2014 ${error.title}`;
    if (kpiErrorDetail) {
      const evidence = String(error.code).includes('HTC') || String(error.code).includes('HEATER_TC')
        ? ` ${describeHeaterFault(dataForErrorDisplay())}` : '';
      kpiErrorDetail.textContent = `${error.action || error.detail || ''}${evidence}`;
    }
    if (kpiErrorTitle) kpiErrorTitle.style.color = 'var(--accent-red)';
    if (kpiErrorCard) {
      kpiErrorCard.classList.remove('severity-info', 'severity-warning', 'severity-critical', 'severity-ok');
      kpiErrorCard.classList.add(`severity-${error.severity || 'critical'}`);
    }
    if (dismissBtn) dismissBtn.disabled = false;
  } else {
    kpiError.innerHTML = '&nbsp;';
    kpiError.style.color = '';
    if (kpiErrorTitle) { kpiErrorTitle.textContent = 'No Active Errors'; kpiErrorTitle.style.color = 'var(--accent-green)'; }
    if (kpiErrorDetail) kpiErrorDetail.textContent = 'No active alarms detected. Happy printing :)';
    if (kpiErrorCard) {
      kpiErrorCard.classList.remove('severity-info', 'severity-warning', 'severity-critical');
      kpiErrorCard.classList.add('severity-ok');
    }
    if (dismissBtn) dismissBtn.disabled = true;
  }
}

function dataForErrorDisplay() {
  return store.data || {};
}

function updateConnectionUI(state) {
  const connected = state === 'CONNECTED';
  document.getElementById('btn-connect').disabled = connected || state === 'CONNECTING';
  document.getElementById('btn-disconnect').disabled = !connected;

  const btns = [
    'btn-run', 'btn-stop', 'btn-reboot',
    'btn-purge-on', 'btn-purge-off', 'btn-flush-on', 'btn-flush-off',
    'btn-drain-on', 'btn-drain-off',
    'btn-bypass-on', 'btn-bypass-off'
  ];
  btns.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !connected;
  });
  document.querySelectorAll('.btn-send-sp').forEach(btn => btn.disabled = !connected);
  syncSendAllButton();
  applyModeInterlocks();
}

function isRunModeActive(data = null) {
  const value = data && data.Run_MODE !== undefined ? data.Run_MODE : store.data?.Run_MODE;
  return parseInt(value, 10) === 1;
}

function setModeStatusMessage(message) {
  const statusEl = document.getElementById('config-status');
  if (statusEl) statusEl.textContent = message;
}

function applyModeInterlocks(data = null) {
  const connected = store.connection === 'CONNECTED';
  const running = isRunModeActive(data);
  const onButtonsToGate = ['btn-purge-on', 'btn-flush-on', 'btn-drain-on'];
  onButtonsToGate.forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = !connected || running;
  });
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
  const isDismissed = dismissedAlarmRaw && payload.raw === dismissedAlarmRaw;

  if (isActiveError(error.code) && !shouldSuppressHeaterError(error.code, payload.raw) && !isDismissed) {
    banner.className = `alarm-banner severity-${error.severity}`;
    msg.textContent = `${error.title}: ${error.detail}`;
    banner.classList.remove('d-none');
  } else {
    banner.classList.add('d-none');
  }
}

async function loadConfigFile(file) {
  const statusEl = document.getElementById('config-status');
  if (configLoading) return;
  configLoading = true;
  const startedAt = Date.now();
  if (statusEl) statusEl.textContent = `Loading ${file.name}...`;
  try {
    let json;
    try {
      const text = await file.text();
      json = JSON.parse(text);
    } catch (_) {
      await ensureMinLoadDisplay(startedAt);
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

    configLoaded = (appliedSettings + appliedSetpoints) > 0;
    syncSendAllButton();
    await ensureMinLoadDisplay(startedAt);
    if (statusEl) statusEl.textContent = configLoaded
      ? `Loaded ${file.name}: ${appliedSettings} settings and ${appliedSetpoints} setpoints.`
      : 'Loaded file had no recognized settings/setpoints.';
  } finally {
    configLoading = false;
  }
}

async function sendAllConfigValues(buttonEl) {
  const statusEl = document.getElementById('config-status');
  if (store.connection !== 'CONNECTED') {
    if (statusEl) statusEl.textContent = 'Connect to the controller before using Send All.';
    return;
  }

  const invalid = Array.from(document.querySelectorAll('[id^="set-"], [id^="input-"]'))
    .filter(input => input.value?.trim() && !input.checkValidity());
  if (invalid.length > 0) {
    invalid[0].reportValidity();
    if (statusEl) statusEl.textContent = `Correct ${invalid.length} out-of-range value${invalid.length === 1 ? '' : 's'} before sending.`;
    return;
  }

  const payloads = collectConfigInputs();
  if (payloads.length === 0) {
    if (statusEl) statusEl.textContent = 'No setpoint/setting values available to send.';
    return;
  }

  await sendValueEntries(payloads, buttonEl, buttonEl?.textContent?.trim() || 'Send All');
}

async function sendValueEntries(payloads, buttonEl, restoreLabel = 'Send All') {
  const statusEl = document.getElementById('config-status');
  if (!payloads || payloads.length === 0) return;

  const startedAt = Date.now();
  setSendAllProgress(0, payloads.length, 'Sending values...');
  buttonEl.disabled = true;

  let sentCount = 0;
  let failedCount = 0;
  try {
    const combinedPayload = Object.fromEntries(payloads.map(({ key, value }) => [key, String(value)]));
    const combinedOk = await send(JSON.stringify(combinedPayload));
    setSendAllProgress(payloads.length, payloads.length, `Applying ${payloads.length} values...`);
    await delay(60);

    const failed = [];
    for (let idx = 0; idx < payloads.length; idx++) {
      const { key, value } = payloads[idx];
      const reflected = await waitForReadback(key, value, 350);
      if (reflected) sentCount++;
      else failed.push({ key, value });
      setSendAllProgress(idx + 1, payloads.length, `Verifying ${idx + 1}/${payloads.length}...`);
    }

    for (let idx = 0; idx < failed.length; idx++) {
      const { key, value } = failed[idx];
      const ok = await send(`{"${key}":"${value}"}`);
      await delay(20);
      const reflected = ok ? await waitForReadback(key, value, 500) : false;
      if (reflected) sentCount++;
      else failedCount++;
      setSendAllProgress(payloads.length, payloads.length, `Retrying ${idx + 1}/${failed.length} failed values...`);
    }

    if (!combinedOk && failed.length === 0) {
      failedCount = payloads.length;
      sentCount = 0;
    }
  } finally {
    const minDisplayMs = 350;
    const elapsed = Date.now() - startedAt;
    if (elapsed < minDisplayMs) await delay(minDisplayMs - elapsed);
    setSendAllProgress(0, 0, '', true);
    syncSendAllButton();
  }

  if (sentCount > 0) {
    flashSentButton(buttonEl, restoreLabel);
    store.log('command', `Send All applied ${sentCount} values`);
  }
  if (failedCount > 0) {
    store.log('warning', `Send All had ${failedCount} failed writes`);
  }
  if (statusEl) statusEl.textContent = failedCount === 0
    ? `Sent ${sentCount} settings/setpoints to controller.`
    : `Sent ${sentCount} values, ${failedCount} failed.`;
}

function collectConfigInputs() {
  const payloadByKey = new Map();
  document.querySelectorAll('[id^="set-"]').forEach(input => {
    const key = input.id.replace('set-', '');
    const value = input.value?.trim();
    if (value) payloadByKey.set(key, value);
  });
  document.querySelectorAll('[id^="input-"]').forEach(input => {
    const key = input.id.replace('input-', '');
    const value = input.value?.trim();
    if (value) payloadByKey.set(key, value);
  });
  return Array.from(payloadByKey.entries()).map(([key, value]) => ({ key, value }));
}

function syncSendAllButton() {
  const sendAllBtn = document.getElementById('btn-config-send-all');
  if (!sendAllBtn) return;
  sendAllBtn.disabled = !(configLoaded && store.connection === 'CONNECTED');
}

function applyHeaterVisibilityUI() {
  const visibility = getHeaterVisibility();
  for (const h of HEATERS) {
    const visible = !!visibility[h.name];
    const row = document.getElementById(`heater-row-${h.name}`);
    const btn = document.getElementById(`btn-heater-toggle-${h.name}`);
    const kpi = document.getElementById(h.kpiId);
    const kpiTile = document.getElementById(`kpi-tile-${h.name === 'MainHeater' ? 'main-heater' : 'aux-heater'}`);
    if (row) row.classList.toggle('heater-row-hidden', !visible);
    if (btn) {
      btn.textContent = visible ? 'Mark unused' : 'Mark installed';
      btn.classList.toggle('btn-connect', !visible);
      btn.classList.toggle('btn-disconnect', visible);
    }
    if (kpi && !visible) {
      kpi.textContent = '--';
      kpi.classList.add('kpi-muted');
    } else if (kpi) {
      kpi.classList.remove('kpi-muted');
    }
    if (kpiTile) {
      kpiTile.classList.toggle('kpi-disabled', !visible);
      kpiTile.style.order = visible ? (h.name === 'MainHeater' ? '2' : '3') : (h.name === 'MainHeater' ? '92' : '93');
    }
  }
}

async function initNominalSetpoints() {
  const nominal = await loadNominalConfig();
  if (!nominal?.setpoints) return;
  for (const sp of SETPOINTS) {
    const val = nominal.setpoints[sp.key];
    if (val === undefined) continue;
    nominalSetpoints[sp.key] = val;
    refreshValueChips(sp.key);
  }
}

async function loadNominalIntoInputsAndSend(buttonEl) {
  const statusEl = document.getElementById('config-status');
  const nominal = await loadNominalConfig();
  if (!nominal) {
    if (statusEl) statusEl.textContent = 'No nominal-config available.';
    return;
  }

  let loaded = 0;
  const nominalEntries = [];
  for (const [key, val] of Object.entries(nominal.settings || {})) {
    const el = document.getElementById(`set-${key}`);
    if (el) {
      el.value = val;
      loaded++;
      nominalEntries.push({ key, value: String(val) });
    }
  }
  for (const [key, val] of Object.entries(nominal.setpoints || {})) {
    const el = document.getElementById(`input-${key}`);
    if (el) {
      el.value = val;
      loaded++;
      nominalEntries.push({ key, value: String(val) });
    }
  }
  configLoaded = loaded > 0;
  syncSendAllButton();
  if (statusEl) statusEl.textContent = `Loaded ${loaded} nominal values into inputs.`;

  if (store.connection !== 'CONNECTED') {
    if (statusEl) statusEl.textContent += ' Connect to controller, then click Send All.';
    return;
  }

  const btn = buttonEl || document.getElementById('btn-config-send-all');
  await sendValueEntries(nominalEntries, btn, btn?.textContent?.trim() || 'Send All');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureMinLoadDisplay(startedAtMs) {
  const minMs = 180;
  const elapsed = Date.now() - startedAtMs;
  if (elapsed < minMs) await delay(minMs - elapsed);
}

async function waitForReadback(key, expected, timeoutMs) {
  const want = String(expected);
  if (store.data && store.data[key] !== undefined && valuesEquivalent(store.data[key], want)) return true;

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      off?.();
      resolve(false);
    }, timeoutMs);

    const off = store.on('data', data => {
      if (data[key] === undefined) return;
      if (!valuesEquivalent(data[key], want)) return;
      clearTimeout(timer);
      off?.();
      resolve(true);
    });
  });
}

function valuesEquivalent(actual, expected) {
  const a = String(actual).trim();
  const e = String(expected).trim();
  if (a === e) return true;
  const an = Number(a);
  const en = Number(e);
  if (Number.isFinite(an) && Number.isFinite(en)) {
    return Math.abs(an - en) < 0.0001;
  }
  return false;
}

function initModeTooltips() {
  if (typeof bootstrap === 'undefined' || !bootstrap.Tooltip) return;
  document.querySelectorAll('[data-mode-tip]').forEach(el => {
    try { bootstrap.Tooltip.getInstance(el)?.dispose(); } catch (_) { /* ignore */ }
    new bootstrap.Tooltip(el, {
      trigger: 'hover focus',
      placement: 'top',
      container: 'body'
    });
  });
}

function setSendAllProgress(current, total, label, clear = false) {
  const wrap = document.getElementById('send-all-progress-wrap');
  const track = document.getElementById('send-all-progress-track');
  const bar = document.getElementById('send-all-progress-bar');
  const text = document.getElementById('send-all-progress-text');
  if (!wrap || !track || !bar || !text) return;

  if (clear) {
    wrap.classList.add('d-none');
    track.classList.add('d-none');
    bar.style.width = '0%';
    bar.setAttribute('aria-valuenow', '0');
    return;
  }

  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  wrap.classList.remove('d-none');
  track.classList.remove('d-none');
  text.textContent = label || 'Working...';
  bar.style.width = `${pct}%`;
  bar.setAttribute('aria-valuenow', String(pct));
}
