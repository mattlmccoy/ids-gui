/* ===== ui-operation.js — Operation tab (dashboard layout) ===== */

import store from './state.js';
import { connect as serialConnect, disconnect as serialDisconnect } from './serial.js';
import { send } from './transport.js';
import { flashSentButton } from './utils.js';
import { decodeAlarmStatus, isActiveError } from './errors.js';
import { CONFIRMATIONS, confirm } from './ui-dialogs.js';
import { getHeaterVisibility, setHeaterVisibility, isHeaterVisible, shouldSuppressHeaterError, describeHeaterFault } from './heater-visibility.js';
import { loadNominalConfig } from './nominal-config.js';
import { FLOATS, getFloatDisplayState, formatFloatState } from './float-state.js';
import {
  MODE_DEFINITIONS, MAINTENANCE_MODE_KEYS, activeMaintenanceMode,
  GUI_AUTO_OFF_DEFAULTS, GUI_AUTO_OFF_OPTIONS, allModesOffCommands,
  formatCountdown, modeReadbackMatches, normalizeAutoOffSeconds
} from './mode-control.js';
import { downloadDiagnosticBundle } from './diagnostics.js';
import { syncExperienceControls } from './experience-mode.js';
import { calculateDualPressure, isDualPressureEnabled } from './pressure-sensing.js';
import { stopFirmwareSimulator } from './firmware-simulator.js';
import { createPairCode } from './pairing.js';
import { redeemPairCode, getMirrorSession, clearMirrorSession } from './mirror-session.js';
import { isMirror } from './transport.js';

/* ---------- Setpoint Definitions ---------- */
const SETPOINTS = [
  { key: 'Vacuum_SETPOINT',    label: 'Vacuum',         min: 0, max: 100, step: 1, unit: '%' },
  { key: 'Flow_SETPOINT',      label: 'Recirc Drive (Flow)',   min: 0, max: 100, step: 1, unit: '%' },
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
  store.on('pressure-sensing-config', () => updateDisplay(store.data));
  store.on('simulation', () => updateConnectionUI(store.connection));
  syncExperienceControls();
  window.addEventListener('beforeunload', event => {
    if (!autoOffTimers.size) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

const pendingModes = new Map();
const autoOffTimers = new Map();
const guiAutoOffArmed = new Set();
let countdownTimer = null;
let countdownPurpose = '';
let lastRunReadback = null;
let lastFlushReadback = null;
let dataSequence = 0;

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
        ${tachometerHTML('fluid', 'Measured', '0 to 70 °C', 'var(--accent-blue)')}
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
        ${tachometerHTML('aux', 'Measured', '0 to 100 \u00B0C', 'var(--accent-amber)')}
      </div>
      <div class="kpi-tile" id="kpi-tile-vacuum">
        <span class="kpi-label">Vacuum</span>
        <span class="kpi-value" id="kpi-vacuum" style="color:var(--accent-cyan)">--</span>
        <span class="kpi-unit">cmH\u2082O</span>
        <span class="kpi-unit" id="kpi-vacuum-target-map">SP: --</span>
        ${tachometerHTML('vacuum', 'Measured', '0 to -70 cmH₂O', 'var(--accent-cyan)')}
      </div>
      <div class="kpi-tile" id="kpi-tile-pressure">
        <span class="kpi-label">Pressure</span>
        <span class="kpi-value" id="kpi-pressure" style="color:var(--accent-purple)">--</span>
        <span class="kpi-unit" title="R17 reports this field but the NANO 700 has no system pressure sensor, so it reads 0.">psi · not measured in R17</span>
      </div>
      <div class="kpi-tile kpi-dual-pressure" id="kpi-tile-dual-pressure" style="display:none">
        <span class="kpi-label">Printhead Pressures</span>
        <span class="kpi-value" id="kpi-pressure-differential">--</span>
        <span class="kpi-unit" id="kpi-pressure-ports">ΔP · sensors not configured</span>
        <span class="kpi-unit" id="kpi-meniscus-estimate">Estimated meniscus: --</span>
      </div>
      <div class="kpi-tile" id="kpi-tile-status">
        <span class="kpi-label">Status</span>
        <span class="kpi-value" id="kpi-status" style="font-size:1rem;color:var(--text-muted)">--</span>
        <span class="kpi-unit" id="kpi-error-code">&nbsp;</span>
      </div>
      <div class="kpi-tile kpi-error severity-unknown" id="kpi-error-card">
        <span class="kpi-label">Active Error</span>
        <span class="kpi-value" id="kpi-error-title">Status Unknown</span>
        <span class="kpi-unit" id="kpi-error-detail">Waiting for controller telemetry.</span>
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
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <button class="btn btn-sm btn-info" id="btn-op-pair-laptop"><i class="bi bi-link-45deg me-1"></i>Pair a laptop</button>
              <button class="btn btn-sm btn-outline-info" id="btn-op-mirror-connect"><i class="bi bi-display me-1"></i>Control a machine</button>
              <button class="btn btn-sm btn-outline-secondary d-none" id="btn-op-mirror-leave">Leave remote session</button>
              <span class="small" id="op-pair-status" style="color:var(--text-muted)"></span>
              <span class="mini-countdown d-none" id="mode-countdown"><i class="bi bi-clock"></i><span>0:00</span></span><span class="op-badge op-badge-stop" id="op-status-badge">IDLE</span>
            </div>
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
                <i class="bi bi-stop-fill me-1"></i>Stop Run
              </button>
              <button class="btn-control btn-all-off" id="btn-all-off" disabled>
                <i class="bi bi-power me-1"></i>All Modes Off
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
                <span class="mode-ack d-none" id="ack-Purge_MODE"></span>
                <span class="mode-autooff d-none" id="timer-Purge_MODE"></span>
              </div>
              <div class="d-flex gap-1">
                <button class="btn-control btn-mode-on" id="btn-flush-on" disabled>Flush ON</button>
                <button class="btn-control btn-mode-off" id="btn-flush-off" disabled>OFF</button>
                <span class="mode-ack d-none" id="ack-Flush_MODE"></span>
              </div>
              <div class="d-flex gap-1">
                <button class="btn-control btn-mode-on" id="btn-drain-on" disabled>Drain ON</button>
                <button class="btn-control btn-mode-off" id="btn-drain-off" disabled>OFF</button>
                <span class="mode-ack d-none" id="ack-Drain_MODE"></span>
                <span class="mode-autooff d-none" id="timer-Drain_MODE"></span>
              </div>
            </div>
            <div class="d-flex align-items-center justify-content-between gap-2 flex-wrap mt-3">
              <div class="mode-command-status" id="mode-command-status" role="status">Buttons reflect live controller state.</div>
              <div class="d-flex gap-2 flex-wrap"><button class="btn btn-sm btn-outline-secondary" data-experience-reveal data-show-label="Show advanced controls" data-hide-label="Hide advanced controls"></button><button class="btn btn-sm btn-outline-info" id="btn-open-system-map"><i class="bi bi-diagram-3 me-1"></i>System map & mode guide</button></div>
            </div>
            ${modeHelpHTML()}
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
        <div class="dash-card accent-purple mb-3 experience-advanced">
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
        <div class="dash-card accent-cyan mb-3 experience-advanced">
          <div class="card-header"><i class="bi bi-file-earmark-text me-1"></i> Config Files</div>
          <div class="card-body">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <input type="file" id="config-file-input" accept="application/json" class="form-control form-control-sm" style="max-width:260px">
              <button class="btn-control btn-connect" id="btn-config-load">Load Config</button>
              <button class="btn-control btn-run" id="btn-config-save">Save Config</button>
              <button class="btn-control btn-disconnect" id="btn-config-send-all" disabled>Send All</button>
              <button class="btn-control btn-stop" id="btn-config-nominal">Load Nominal + Send</button>
              <button class="btn-control btn-disconnect" id="btn-export-diagnostics"><i class="bi bi-download me-1"></i>Diagnostic Bundle</button>
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
        <div class="dash-card accent-amber mb-3 experience-advanced">
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
        <div class="dash-card accent-green mb-3 experience-advanced">
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
        <div class="dash-card accent-cyan mb-3 experience-advanced">
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

function tachometerHTML(id, kind, range, color = 'var(--accent-cyan)') {
  return `<div class="mini-tach" id="tach-${id}" style="--tach-color:${color}" role="meter" aria-label="${kind} ${id}" aria-valuemin="0" aria-valuemax="100">
    <svg viewBox="0 0 100 55" aria-hidden="true">
      <path class="mini-tach-track" pathLength="100" d="M10 49 A40 40 0 0 1 90 49"></path>
      <path class="mini-tach-fill" pathLength="100" d="M10 49 A40 40 0 0 1 90 49"></path>
      <line class="mini-tach-needle" x1="50" y1="49" x2="50" y2="14"></line>
      <circle cx="50" cy="49" r="3" class="mini-tach-hub"></circle>
    </svg>
    <span>${kind} · ${range}</span>
  </div>`;
}

function modeHelpHTML() {
  const timers = Object.entries(GUI_AUTO_OFF_DEFAULTS).map(([key, fallback]) => {
    const label = MODE_DEFINITIONS[key].label;
    const options = GUI_AUTO_OFF_OPTIONS.map(seconds => `<option value="${seconds}"${seconds === fallback ? ' selected' : ''}>${seconds ? `${seconds < 60 ? `${seconds} s` : `${seconds / 60} min`}` : 'Off'}</option>`).join('');
    return `<label class="mode-autooff-setting"><span>${label}</span><select id="autooff-${key}" data-autooff-key="${key}" class="form-select form-select-sm">${options}</select></label>`;
  }).join('');
  const cards = Object.entries(MODE_DEFINITIONS).map(([key, mode]) => `
    <article class="mode-help-card">
      <header><strong>${mode.label}</strong><span id="mode-help-state-${key}">${Number(store.data?.[key]) === 1 ? 'ON' : 'OFF'}</span></header>
      <p>${mode.purpose}</p>
      <div class="mode-output-flow">${mode.outputs.map(output => `<span>${output}</span>`).join('<i class="bi bi-arrow-right"></i>')}</div>
      <p><strong>Use when:</strong> ${mode.use}</p>
      <small><strong>R17 behavior:</strong> ${mode.warning}</small>
    </article>`).join('');
  return `<details class="operation-mode-help mt-3" id="operation-mode-help">
    <summary><i class="bi bi-question-circle"></i><span>What do these modes do?</span><small>Outputs, fluid-path intent, and R17 limitations</small></summary>
    <div class="operation-mode-help-body">
      <div class="mode-help-grid">${cards}</div>
      <div class="mode-safeguard-panel">
        <div><strong>GUI auto-off assist</strong><p>After this page commands ON and sees matching live readback, it sends OFF after the selected time.</p></div>
        <div class="mode-autooff-settings">${timers}</div>
        <small><i class="bi bi-shield-exclamation me-1"></i>This depends on this browser remaining open, awake, and connected. It is not a safety timer or emergency stop. Flush is excluded because R17's internal five-second timer is defective and cannot be repaired by repeated GUI commands.</small>
      </div>
    </div>
  </details>`;
}

/* ---------- Event Binding ---------- */

function bindEvents() {
  initModeTooltips();
  initAutoOffControls();

  document.getElementById('btn-connect').addEventListener('click', () => serialConnect());

  document.getElementById('btn-op-pair-laptop')?.addEventListener('click', async () => {
    const out = document.getElementById('op-pair-status');
    if (!out) return;
    out.textContent = 'Requesting code…';
    try {
      const { code, controlArmed, controlError } = await createPairCode();
      out.innerHTML = `Code <span class="fs-5 font-monospace fw-bold">${code}</span> · 5 min` +
        (controlArmed
          ? ' · <span class="text-success">remote control armed 30 min</span>'
          : ` · <span class="text-warning">control not armed: ${escapeHtml(controlError)}</span>`);
    } catch (error) {
      out.textContent = error.message;
    }
  });

  document.getElementById('btn-op-mirror-connect')?.addEventListener('click', async () => {
    const out = document.getElementById('op-pair-status');
    const code = window.prompt('Enter the 4-digit code shown on the connected machine:');
    if (!code) return;
    out.textContent = 'Pairing…';
    try {
      await redeemPairCode(code.trim());
      out.textContent = 'Paired. Loading mirror…';
      window.location.reload();
    } catch (error) {
      out.textContent = `Could not connect: ${error.message}`;
    }
  });

  document.getElementById('btn-op-mirror-leave')?.addEventListener('click', () => {
    clearMirrorSession();
    window.location.reload();
  });

  syncOperationMirrorUI();
  document.getElementById('btn-disconnect').addEventListener('click', () => store.simulationActive ? stopFirmwareSimulator() : serialDisconnect());
  document.getElementById('btn-open-system-map')?.addEventListener('click', () => {
    const trigger = document.getElementById('tab-debug');
    if (trigger) bootstrap.Tab.getOrCreateInstance(trigger).show();
  });

  document.getElementById('btn-run').addEventListener('click', async () => {
    const maintenance = activeMaintenanceMode(store.data);
    if (maintenance) {
      setModeStatusMessage(`Run blocked: ${MODE_DEFINITIONS[maintenance].label} is active. Turn it off and wait for controller confirmation first.`);
      return;
    }
    if (await CONFIRMATIONS.run()) requestMode('Run_MODE', 1, 'Run requested');
  });
  document.getElementById('btn-stop').addEventListener('click', async () => {
    if (await CONFIRMATIONS.stop()) requestMode('Run_MODE', 0, 'Run stop requested; maintenance modes are unchanged');
  });
  document.getElementById('btn-all-off').addEventListener('click', commandAllModesOff);
  document.getElementById('btn-reboot').addEventListener('click', async () => {
    if (await CONFIRMATIONS.reboot()) {
      if (await send('{"WatchdogTrigger_MODE":"1"}')) startCompactCountdown('Controller restart', 10, 'reboot');
      store.log('command', 'Watchdog reboot triggered');
    }
  });

  document.getElementById('btn-purge-on').addEventListener('click', async () => {
    if (!maintenanceModeAllowed('Purge_MODE')) return;
    if (await CONFIRMATIONS.purgeOn()) requestMode('Purge_MODE', 1, 'Purge requested');
  });
  document.getElementById('btn-purge-off').addEventListener('click', () => requestMode('Purge_MODE', 0, 'Purge stop requested'));
  document.getElementById('btn-flush-on').addEventListener('click', async () => {
    if (!maintenanceModeAllowed('Flush_MODE')) return;
    if (await CONFIRMATIONS.flushOn()) requestMode('Flush_MODE', 1, 'Flush requested; watching for the known R17 timer defect');
  });
  document.getElementById('btn-flush-off').addEventListener('click', () => requestMode('Flush_MODE', 0, 'Flush stop requested'));
  document.getElementById('btn-drain-on').addEventListener('click', async () => {
    if (!maintenanceModeAllowed('Drain_MODE')) return;
    if (await CONFIRMATIONS.drainOn()) requestMode('Drain_MODE', 1, 'Drain requested');
  });
  document.getElementById('btn-drain-off').addEventListener('click', () => requestMode('Drain_MODE', 0, 'Drain stop requested'));

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
  document.getElementById('btn-export-diagnostics')?.addEventListener('click', downloadDiagnosticBundle);

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
  dataSequence += 1;
  // KPI tiles
  if (data.FluidTemperature_STATE !== undefined) {
    document.getElementById('kpi-fluid-temp').textContent = parseFloat(data.FluidTemperature_STATE).toFixed(1);
    updateTachometer('fluid', data.FluidTemperature_STATE, 0, 70);
  }
  if (data.MainHeaterTemperature_STATE !== undefined && isHeaterVisible('MainHeater'))
    document.getElementById('kpi-main-heater').textContent = parseFloat(data.MainHeaterTemperature_STATE).toFixed(1);
  if (data.AUXHeaterTemperature_STATE !== undefined && isHeaterVisible('AuxHeater')) {
    document.getElementById('kpi-aux-heater').textContent = parseFloat(data.AUXHeaterTemperature_STATE).toFixed(1);
    updateTachometer('aux', data.AUXHeaterTemperature_STATE, 0, 100);
  }
  if (data.Vacuum_STATE !== undefined) {
    document.getElementById('kpi-vacuum').textContent = data.Vacuum_STATE;
    // Vacuum is a negative value; full scale is -70 cmH₂O, so the gauge fills as it grows more negative.
    updateTachometer('vacuum', data.Vacuum_STATE, 0, -70);
  }
  const vacTargetEl = document.getElementById('kpi-vacuum-target-map');
  if (vacTargetEl) {
    const pct = data.Vacuum_SETPOINT;
    vacTargetEl.textContent = pct === undefined ? 'SP(raw): -- %' : `SP(raw): ${pct}%`;
  }
  if (data.Pressure_STATE !== undefined) {
    document.getElementById('kpi-pressure').textContent = data.Pressure_STATE;
  }
  updateDualPressureDisplay(data);

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
  applyModeButtons('Run_MODE', data);
  reconcilePendingModes(data);
  observeRunTimer(data);
  applyModeInterlocks(data);
  applyHeaterVisibilityUI();
  for (const key of Object.keys(MODE_DEFINITIONS)) {
    const state = document.getElementById(`mode-help-state-${key}`);
    if (state && data[key] !== undefined) state.textContent = Number(data[key]) === 1 ? 'ON' : 'OFF';
  }
  for (const key of [...autoOffTimers.keys()]) {
    if (data[key] !== undefined && Number(data[key]) === 0) cancelAutoOffTimer(key);
  }
}

function updateDualPressureDisplay(data) {
  const result = calculateDualPressure(data);
  const differential = document.getElementById('kpi-pressure-differential');
  const ports = document.getElementById('kpi-pressure-ports');
  const meniscus = document.getElementById('kpi-meniscus-estimate');
  const tile = document.getElementById('kpi-tile-dual-pressure');
  if (!differential || !ports || !meniscus || !tile) return;
  if (!isDualPressureEnabled()) {
    tile.style.display = 'none';
    return;
  }
  tile.style.display = '';
  if (!result.available) {
    differential.textContent = '--';
    ports.textContent = result.reason;
    meniscus.textContent = 'Estimated meniscus: --';
    tile.classList.add('kpi-disabled');
    return;
  }
  tile.classList.remove('kpi-disabled');
  differential.textContent = `${result.differentialPsi.toFixed(2)} psi ΔP`;
  ports.textContent = `In ${result.inletPsi.toFixed(2)} · Return ${result.returnPsi.toFixed(2)} psi`;
  meniscus.textContent = `Estimated meniscus: ${result.estimatedMeniscusPsi.toFixed(2)} psi`;
}

const TACH_UNITS = { fluid: '°C', aux: '°C', vacuum: 'cmH₂O' };

function updateTachometer(id, rawValue, min, max) {
  const el = document.getElementById(`tach-${id}`);
  const value = Number(rawValue);
  // Allow reversed ranges (e.g. vacuum 0 → -70) — only an equal min/max is invalid.
  if (!el || !Number.isFinite(value) || !Number.isFinite(max) || max === min) return;
  const percentage = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  el.style.setProperty('--tach-angle', `${-90 + percentage * 1.8}deg`);
  el.style.setProperty('--tach-fill', `${percentage} 100`);
  el.setAttribute('aria-valuemin', String(min));
  el.setAttribute('aria-valuemax', String(max));
  el.setAttribute('aria-valuenow', String(value));
  const caption = el.querySelector('span');
  if (caption) caption.textContent = `Measured · ${min} to ${max} ${TACH_UNITS[id] || ''}`.trim();
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
    if (kpiErrorCard) kpiErrorCard.classList.remove('d-none');
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
    const severityColor = error.severity === 'critical' ? 'var(--accent-red)' : 'var(--accent-amber)';
    kpiError.style.color = severityColor;
    if (kpiErrorTitle) kpiErrorTitle.style.color = severityColor;
    if (dismissBtn) dismissBtn.disabled = false;
  } else if (isActiveError(error.code) && isDismissed) {
    kpiError.textContent = error.code;
    kpiError.style.color = 'var(--accent-amber)';
    if (kpiErrorTitle) { kpiErrorTitle.textContent = `Dismissed — ${error.title}`; kpiErrorTitle.style.color = 'var(--accent-amber)'; }
    if (kpiErrorDetail) kpiErrorDetail.textContent = 'This alarm is still reported by the controller. It has only been hidden from the banner.';
    if (kpiErrorCard) {
      kpiErrorCard.classList.remove('d-none', 'severity-info', 'severity-critical', 'severity-ok', 'severity-unknown');
      kpiErrorCard.classList.add('severity-warning');
    }
    if (dismissBtn) dismissBtn.disabled = true;
  } else if (isActiveError(error.code) && isSuppressed) {
    // A heater/HTC alarm attributable to a channel the operator marked not-installed.
    // Render it as a calm, non-alarming note (green) so it does not block the operator,
    // while staying honest that the controller is still reporting it.
    kpiError.innerHTML = '&nbsp;';
    kpiError.style.color = '';
    if (kpiErrorTitle) { kpiErrorTitle.textContent = 'No active errors'; kpiErrorTitle.style.color = 'var(--accent-green)'; }
    if (kpiErrorDetail) kpiErrorDetail.textContent = `Ignoring an unused-heater thermocouple alarm (channel marked not installed in Settings). ${describeHeaterFault(dataForErrorDisplay())}`;
    if (kpiErrorCard) {
      kpiErrorCard.classList.remove('d-none', 'severity-info', 'severity-warning', 'severity-critical', 'severity-unknown');
      kpiErrorCard.classList.add('severity-ok');
    }
    if (dismissBtn) dismissBtn.disabled = true;
  } else {
    kpiError.innerHTML = '&nbsp;';
    kpiError.style.color = '';
    if (kpiErrorTitle) { kpiErrorTitle.textContent = 'No Active Errors'; kpiErrorTitle.style.color = 'var(--accent-green)'; }
    if (kpiErrorDetail) kpiErrorDetail.textContent = 'No active alarms detected. Happy printing :)';
    if (kpiErrorCard) {
      kpiErrorCard.classList.remove('severity-info', 'severity-warning', 'severity-critical', 'severity-unknown');
      kpiErrorCard.classList.add('severity-ok');
      kpiErrorCard.classList.remove('d-none');
    }
    if (dismissBtn) dismissBtn.disabled = true;
  }
}

function dataForErrorDisplay() {
  return store.data || {};
}

function updateConnectionUI(state) {
  const connected = state === 'CONNECTED' || store.simulationActive;
  const busy = state === 'CONNECTING' || state === 'RECONNECTING';
  document.getElementById('btn-connect').disabled = connected || busy;
  // Keep Disconnect available while busy so the operator can cancel an in-progress (re)connect.
  document.getElementById('btn-disconnect').disabled = !connected && !busy;
  const disconnectButton = document.getElementById('btn-disconnect');
  if (disconnectButton) disconnectButton.innerHTML = store.simulationActive
    ? '<i class="bi bi-stop-circle me-1"></i>Stop simulation'
    : '<i class="bi bi-x-circle me-1"></i>Disconnect';

  const btns = [
    'btn-run', 'btn-stop', 'btn-all-off', 'btn-reboot',
    'btn-purge-on', 'btn-purge-off', 'btn-flush-on', 'btn-flush-off',
    'btn-drain-on', 'btn-drain-off'
  ];
  btns.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !connected;
  });
  document.querySelectorAll('.btn-send-sp').forEach(btn => btn.disabled = !connected);
  syncSendAllButton();
  applyModeInterlocks();
  if (!connected && autoOffTimers.size) {
    cancelAllAutoOffTimers();
    guiAutoOffArmed.clear();
    setModeStatusMessage('Connection lost while GUI auto-off was armed. Verify every active mode at the machine.');
    store.log('warning', 'GUI auto-off canceled by controller disconnect; local verification required');
  }
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

/** On a mirror the pairing controls are inert; show the session state and a way out. */
function syncOperationMirrorUI() {
  const mirror = isMirror() ? getMirrorSession() : null;
  document.getElementById('btn-op-pair-laptop')?.classList.toggle('d-none', Boolean(mirror));
  document.getElementById('btn-op-mirror-connect')?.classList.toggle('d-none', Boolean(mirror));
  document.getElementById('btn-op-mirror-leave')?.classList.toggle('d-none', !mirror);
  const out = document.getElementById('op-pair-status');
  if (out && mirror) out.textContent = 'Mirroring a remote machine';
}

function isRunModeActive(data = null) {
  const value = data && data.Run_MODE !== undefined ? data.Run_MODE : store.data?.Run_MODE;
  return parseInt(value, 10) === 1;
}

function setModeStatusMessage(message) {
  const statusEl = document.getElementById('mode-command-status');
  if (statusEl) statusEl.textContent = message;
}

function applyModeInterlocks(data = null) {
  const connected = store.connection === 'CONNECTED' || store.simulationActive;
  const running = isRunModeActive(data);
  const source = data || store.data || {};
  const active = activeMaintenanceMode(source);
  const pendingMaintenance = MAINTENANCE_MODE_KEYS.find(key => pendingModes.has(key) && pendingModes.get(key).value === 1);
  const buttonModes = { 'btn-purge-on': 'Purge_MODE', 'btn-flush-on': 'Flush_MODE', 'btn-drain-on': 'Drain_MODE' };
  Object.entries(buttonModes).forEach(([id, key]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = !connected || running || Boolean(active && active !== key) || Boolean(pendingMaintenance && pendingMaintenance !== key) || pendingModes.has(key);
  });
  const runButton = document.getElementById('btn-run');
  if (runButton) runButton.disabled = !connected || Boolean(active) || Boolean(pendingMaintenance) || pendingModes.has('Run_MODE');
  const stopButton = document.getElementById('btn-stop');
  if (stopButton) stopButton.disabled = !connected || pendingModes.has('Run_MODE');
}

function applyModeButtons(modeKey, data = null) {
  const onId = `btn-${modeKey.toLowerCase().replace('_mode', '')}-on`;
  const offId = `btn-${modeKey.toLowerCase().replace('_mode', '')}-off`;
  const onBtn = document.getElementById(onId);
  const offBtn = document.getElementById(offId);
  if (!onBtn || !offBtn) return;

  const value = data && data[modeKey] !== undefined ? data[modeKey] : store.data?.[modeKey];
  if (value === undefined) return;
  const isOn = parseInt(value) === 1;
  if (modeKey !== 'Run_MODE' && !pendingModes.has(modeKey)) updateCommandFeedback(modeKey, 'confirmed');

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

function maintenanceModeAllowed(key) {
  if (isRunModeActive()) {
    setModeStatusMessage(`${MODE_DEFINITIONS[key].label} cannot start while Run is active. Use Stop Run and wait for the readback.`);
    return false;
  }
  const active = activeMaintenanceMode(store.data, key);
  if (active) {
    setModeStatusMessage(`${MODE_DEFINITIONS[key].label} blocked: ${MODE_DEFINITIONS[active].label} is active. Turn it OFF and wait for its readback first.`);
    return false;
  }
  const pending = MAINTENANCE_MODE_KEYS.find(modeKey => modeKey !== key && pendingModes.has(modeKey) && pendingModes.get(modeKey).value === 1);
  if (pending) {
    setModeStatusMessage(`${MODE_DEFINITIONS[key].label} blocked while ${MODE_DEFINITIONS[pending].label} is waiting for controller confirmation.`);
    return false;
  }
  return true;
}

async function requestMode(key, value, message) {
  if (pendingModes.has(key)) {
    if (Number(value) !== 0) return false;
    pendingModes.delete(key);
    guiAutoOffArmed.delete(key);
    updateCommandFeedback(key, 'pending');
  }
  const ok = await send(JSON.stringify({ [key]: String(value) }));
  if (!ok) {
    setModeStatusMessage(`Could not send ${key}. Check the USB connection.`);
    if (key !== 'Run_MODE') updateCommandFeedback(key, 'failed');
    return false;
  }
  if (Number(value) === 1 && Object.hasOwn(GUI_AUTO_OFF_DEFAULTS, key)) guiAutoOffArmed.add(key);
  if (Number(value) === 0) {
    guiAutoOffArmed.delete(key);
    cancelAutoOffTimer(key);
  }
  const pending = { value: Number(value), at: Date.now(), sequence: dataSequence };
  pendingModes.set(key, pending);
  setTimeout(() => {
    if (pendingModes.get(key) === pending) reconcilePendingModes(store.data);
  }, 8100);
  setModeStatusMessage(`${message}. Waiting for controller confirmation…`);
  store.log('command', message);
  updateCommandFeedback(key, 'pending');
  applyModeInterlocks();
  return true;
}

async function commandAllModesOff() {
  const ok = await confirm('Command all modes OFF',
    '<p><strong>This sends OFF for Run, Purge, Flush, and Drain.</strong></p><p class="mb-0">Stay at the machine until every controller readback confirms OFF. This is a controlled shutdown command, not an emergency stop.</p>',
    'Command all OFF', 'btn-danger');
  if (!ok) return;
  cancelAllAutoOffTimers();
  guiAutoOffArmed.clear();
  for (const command of allModesOffCommands()) {
    const [key] = Object.keys(JSON.parse(command));
    if (!await send(command)) {
      setModeStatusMessage(`All Modes Off interrupted while sending ${key}. Verify the machine locally.`);
      return;
    }
    const pending = { value: 0, at: Date.now(), sequence: dataSequence };
    pendingModes.set(key, pending);
    setTimeout(() => {
      if (pendingModes.get(key) === pending) reconcilePendingModes(store.data);
    }, 8100);
    if (key !== 'Run_MODE') updateCommandFeedback(key, 'pending');
  }
  setModeStatusMessage('All Modes Off sent. Waiting for the controller to confirm all five modes are off…');
  startCompactCountdown('All modes OFF verification', 8, 'all-off');
  store.log('command', 'All operating modes commanded OFF');
}

function reconcilePendingModes(data) {
  for (const [key, pending] of [...pendingModes]) {
    if (dataSequence > pending.sequence && modeReadbackMatches(data, key, pending.value)) {
      pendingModes.delete(key);
      if (key !== 'Run_MODE') updateCommandFeedback(key, 'confirmed');
      if (pending.value === 1 && guiAutoOffArmed.has(key)) {
        guiAutoOffArmed.delete(key);
        scheduleAutoOffTimer(key);
      }
      if (pending.value === 0) cancelAutoOffTimer(key);
      const timer = autoOffTimers.get(key);
      setModeStatusMessage(`${key.replace('_MODE', '')} is confirmed ${pending.value ? 'on' : 'off'}${timer ? `; GUI auto-off is armed for ${timer.seconds} seconds` : ''}.`);
    } else if (Date.now() - pending.at > 8000) {
      pendingModes.delete(key);
      guiAutoOffArmed.delete(key);
      if (key !== 'Run_MODE') updateCommandFeedback(key, 'failed');
      setModeStatusMessage(`${key.replace('_MODE', '')} was not confirmed within 8 seconds. Verify locally.`);
      store.log('warning', `${key} command was not confirmed`);
    }
  }
}

function initAutoOffControls() {
  document.querySelectorAll('[data-autooff-key]').forEach(select => {
    const key = select.dataset.autooffKey;
    const fallback = GUI_AUTO_OFF_DEFAULTS[key] || 0;
    select.value = String(readAutoOffPreference(key, fallback));
    select.addEventListener('change', () => {
      const seconds = normalizeAutoOffSeconds(select.value, fallback);
      select.value = String(seconds);
      try { localStorage.setItem(`ids.guiAutoOff.${key}`, String(seconds)); } catch { /* non-persistent browser */ }
      if (autoOffTimers.has(key)) scheduleAutoOffTimer(key);
    });
  });
}

function readAutoOffPreference(key, fallback) {
  try { return normalizeAutoOffSeconds(localStorage.getItem(`ids.guiAutoOff.${key}`), fallback); }
  catch { return fallback; }
}

function scheduleAutoOffTimer(key) {
  cancelAutoOffTimer(key);
  const select = document.getElementById(`autooff-${key}`);
  const seconds = normalizeAutoOffSeconds(select?.value, GUI_AUTO_OFF_DEFAULTS[key] || 0);
  if (!seconds) return;
  const end = Date.now() + seconds * 1000;
  const timer = { seconds, interval: null };
  const tick = async () => {
    const remaining = end - Date.now();
    const el = document.getElementById(`timer-${key}`);
    if (el) {
      el.className = 'mode-autooff';
      el.innerHTML = `<i class="bi bi-clock"></i>${formatCountdown(remaining)}`;
      el.title = 'Browser-assisted auto-off countdown';
    }
    if (remaining > 0) return;
    cancelAutoOffTimer(key);
    if (store.connection !== 'CONNECTED') {
      setModeStatusMessage(`${MODE_DEFINITIONS[key].label} auto-off could not send because the controller disconnected. Verify locally.`);
      store.log('warning', `${key} GUI auto-off could not send after disconnect`);
      return;
    }
    await requestMode(key, 0, `${MODE_DEFINITIONS[key].label} GUI auto-off requested`);
  };
  timer.interval = setInterval(tick, 250);
  autoOffTimers.set(key, timer);
  tick();
}

function cancelAutoOffTimer(key) {
  const timer = autoOffTimers.get(key);
  if (timer?.interval) clearInterval(timer.interval);
  autoOffTimers.delete(key);
  const el = document.getElementById(`timer-${key}`);
  if (el) { el.className = 'mode-autooff d-none'; el.textContent = ''; }
}

function cancelAllAutoOffTimers() {
  for (const key of [...autoOffTimers.keys()]) cancelAutoOffTimer(key);
}

function updateCommandFeedback(key, state) {
  const el = document.getElementById(`ack-${key}`);
  if (!el) return;
  if (state === 'confirmed') {
    el.textContent = '';
    el.className = 'mode-ack d-none';
    return;
  }
  el.textContent = state === 'pending' ? 'Sending…' : 'No response';
  el.className = `mode-ack ${state}`;
}

function observeRunTimer(data) {
  if (data.Run_MODE === undefined) return;
  const current = Number(data.Run_MODE);
  if (lastRunReadback !== null && current !== lastRunReadback) {
    startCompactCountdown(current ? 'Run startup' : 'Run wind-down', current ? 15 : 14, 'run');
  }
  lastRunReadback = current;
  if (data.Flush_MODE !== undefined) {
    const flush = Number(data.Flush_MODE);
    if (lastFlushReadback === 0 && flush === 1) startCompactCountdown('Flush cycle', 5, 'flush');
    lastFlushReadback = flush;
  }
}

function startCompactCountdown(label, seconds, purpose = '') {
  stopCompactCountdown();
  countdownPurpose = purpose;
  const el = document.getElementById('mode-countdown');
  if (!el) return;
  const end = Date.now() + seconds * 1000;
  const tick = () => {
    const remaining = end - Date.now();
    el.classList.remove('d-none');
    el.title = label;
    el.querySelector('span').textContent = `${label} ${formatCountdown(remaining)}`;
    if (remaining <= 0) stopCompactCountdown();
  };
  tick(); countdownTimer = setInterval(tick, 250);
}

function stopCompactCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  countdownPurpose = '';
  document.getElementById('mode-countdown')?.classList.add('d-none');
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
