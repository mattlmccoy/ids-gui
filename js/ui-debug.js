/* ===== ui-debug.js — engineering diagnostics and conceptual plumbing map ===== */

import store from './state.js';
import { send, getPollIntervalMs } from './serial.js';
import { MODE_DEFINITIONS } from './mode-control.js';
import { downloadDiagnosticBundle, getDiagnosticSnapshot } from './diagnostics.js';
import { confirm } from './ui-dialogs.js';
import { syncExperienceControls } from './experience-mode.js';
import { getFirmwareSimulatorState, startFirmwareSimulator, stopFirmwareSimulator } from './firmware-simulator.js';

// No flush preview: this build has no flush hardware (FIRMWARE_SPEC_R17 §3 shows a
// flushValve/flushPump output, but nothing is plumbed to it here).
const MODE_PREVIEWS = ['live', 'run', 'purge', 'drain'];
// Element id -> telemetry readback key. node-mv1 is the single physical ball valve.
// Per FIRMWARE_SPEC_R17 §4.2/§4.3, manifoldValve1 and manifoldValve2 are always driven
// to the SAME value in the SAME places (both open in Run and Drain, both closed
// otherwise), so MV2 has no independent function and is not drawn separately — the ball
// valve tracks ManifoldValve1.
const NODE_STATES = {
  'node-input-pump': 'InputPump_STATE', 'node-recirc-pump': 'RecirculationPump_STATE',
  'node-drain-pump': 'DrainPump_STATE', 'node-vacuum-pump': 'VacuumPump_STATE',
  'node-mv1': 'ManifoldValve1_STATE',
  'node-weir-float': 'WeirFloat_STATE', 'node-weir-ovf-float': 'WeirOverflowFloat_STATE'
};

let selectedPreview = 'live';
let telemetryFilter = '';
let lastDataAt = 0;
let refreshTimer = null;
let mapZoom = 1;

export function initDebugTab() {
  const panel = document.getElementById('panel-debug');
  if (!panel) return;
  panel.innerHTML = buildHTML();
  bindEvents(panel);
  store.on('data', data => {
    lastDataAt = Date.now();
    updateLiveSummary(data);
    updateSchematic(data);
    renderTelemetry();
  });
  store.on('connection', () => { updateLiveSummary(store.data); updateSimulatorUI(); });
  store.on('simulation', updateSimulatorUI);
  store.on('log', renderEventHistory);
  store.on('command-sent', renderEventHistory);
  refreshTimer = setInterval(() => updateLiveSummary(store.data), 1000);
  window.addEventListener('beforeunload', () => clearInterval(refreshTimer), { once: true });
  updateLiveSummary(store.data);
  updateSchematic(store.data);
  applyMapZoom();
  renderTelemetry();
  renderEventHistory();
  syncExperienceControls();
  updateSimulatorUI();
}

function buildHTML() {
  return `
    <div class="debug-toolbar mb-3">
      <div><h1 class="h4 mb-1">Debug & system map</h1><div class="text-muted small">Engineering detail, raw telemetry, and support tools live here so Operation can stay focused.</div></div>
      <div class="d-flex gap-2 flex-wrap"><button class="btn btn-sm btn-outline-secondary" data-experience-reveal data-show-label="Show engineering details" data-hide-label="Hide engineering details"></button><button class="btn btn-outline-primary" id="debug-export"><i class="bi bi-download me-1"></i>Export diagnostic bundle</button></div>
    </div>

    <div class="debug-summary-grid mb-3">
      ${summaryCard('debug-connection', 'Connection', '—', 'bi-usb-symbol')}
      ${summaryCard('debug-frame-age', 'Last telemetry', 'No frames', 'bi-broadcast')}
      ${summaryCard('debug-firmware', 'Firmware', '—', 'bi-cpu')}
      ${summaryCard('debug-poll', 'Polling', `${getPollIntervalMs()} ms`, 'bi-arrow-repeat')}
      ${summaryCard('debug-alarm', 'Alarm', 'Unknown', 'bi-shield-check')}
    </div>

    <div class="dash-card accent-purple mb-3 experience-advanced">
      <div class="card-header d-flex justify-content-between align-items-center"><span><i class="bi bi-bezier2 me-1"></i>Firmware simulator</span><span class="badge text-bg-secondary" id="simulator-status">Stopped</span></div>
      <div class="card-body">
        <div class="d-flex gap-2 align-items-center flex-wrap">
          <select class="form-select form-select-sm" id="simulator-scenario" style="max-width:240px"><option value="normal">Normal startup</option><option value="no-response">Commanded, no hydraulic response</option><option value="vacuum-decay">Rapid vacuum decay</option><option value="excessive-cycling">Excessive pump cycling</option><option value="slow-start">Slow hydraulic start</option></select>
          <button class="btn btn-sm btn-outline-primary" id="simulator-start"><i class="bi bi-play-fill me-1"></i>Start simulation</button>
          <button class="btn btn-sm btn-outline-danger" id="simulator-stop" disabled><i class="bi bi-stop-fill me-1"></i>Stop</button>
        </div>
        <div class="small text-muted mt-2">Available only while USB is disconnected. Simulated frames use the real dashboard, trends, commissioning guards, and diagnostic rules; hardware commands remain disabled and remote alerts are suppressed. A yellow SIMULATION badge remains visible globally.</div>
        <div class="small mt-2" id="simulator-feedback" role="status"></div>
      </div>
    </div>

    <div class="dash-card accent-cyan mb-3">
      <div class="card-header d-flex align-items-center justify-content-between gap-2 flex-wrap">
        <span><i class="bi bi-diagram-3 me-1"></i>Conceptual plumbing map <span class="badge text-bg-secondary ms-1">DIAGRAM-TRACED</span></span>
        <div class="schematic-mode-picker" role="group" aria-label="Diagram mode preview">
          ${MODE_PREVIEWS.map(mode => `<button type="button" class="btn btn-sm ${mode === 'live' ? 'btn-info' : 'btn-outline-secondary'}" data-map-preview="${mode}">${capitalize(mode)}</button>`).join('')}
        </div>
      </div>
      <div class="card-body">
        <div class="map-context mb-2"><span id="map-context-title">Live controller state</span><span id="map-context-detail">Layout follows the traced fluid diagram. Colored lines highlight the electronically active path for the current mode.</span></div>
        <div class="d-flex align-items-center justify-content-end gap-1 mb-2">
          <span class="small text-muted me-1">Zoom</span>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-map-zoom="out" aria-label="Zoom out">−</button>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-map-zoom="fit">Fit</button>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-map-zoom="in" aria-label="Zoom in">+</button>
          <span class="small text-muted ms-1" id="map-zoom-level" style="min-width:3.2em;text-align:right">100%</span>
        </div>
        ${plumbingSvg()}
        <div class="schematic-legend mt-2">
          <span><i class="legend-line live"></i>Active / previewed flow</span>
          <span><i class="legend-line known"></i>Firmware-backed connection</span>
          <span><i class="legend-line unknown"></i>Physical route to verify</span>
          <span><i class="legend-node"></i>Component readback ON</span>
        </div>
        <details class="debug-disclosure mt-3">
          <summary>Assumptions and known R17 limitations</summary>
          <div class="pt-2 small text-muted">Topology matches an owner-supplied trace of the machine: ink supply/recirc through the APS box pumps (I/R/D + vacuum), an inline heater, a Xaar Aquinox recirculating printhead (2 inlets, 2 outlets converging to one), a fluid-temperature thermistor, a return tee, and the ball-valve → pressure-control-box (WEIR + WEIR OVF floats) → vacuum branch with a catch pot for overflow. Inside the APS box the vacuum is regulated by an SMC ITV2090 and the heaters switch through a ZGT-25 SSR. <strong>Manifold V2:</strong> per FIRMWARE_SPEC_R17 §4.2/§4.3 the firmware always drives manifoldValve1 and manifoldValve2 to the same value at the same time (both open in Run and Drain, both closed otherwise), so MV2 has no independent function — this build has a single ball valve, shown here tracking MV1. <strong>Flush:</strong> no dedicated flush hardware exists on this build, so the flush pump/valve outputs and Flush preview are omitted. Still lab-verification items: raw float polarity and the exact firmware key behind the ball valve.</div>
        </details>
      </div>
    </div>

    <div class="row g-3 mb-3">
      <div class="col-xl-7 experience-advanced">
        <div class="dash-card h-100">
          <div class="card-header d-flex justify-content-between align-items-center gap-2"><span><i class="bi bi-list-columns-reverse me-1"></i>Raw telemetry</span><input id="debug-filter" class="form-control form-control-sm debug-filter" placeholder="Filter key or value" aria-label="Filter raw telemetry"></div>
          <div class="debug-table-wrap"><table class="table table-sm monitor-table mb-0"><thead><tr><th>Key</th><th>Value</th><th>Type</th></tr></thead><tbody id="debug-telemetry-body"></tbody></table></div>
        </div>
      </div>
      <div class="col-xl-5" id="debug-diagnostics-side">
        <div class="dash-card mb-3">
          <div class="card-header"><i class="bi bi-activity me-1"></i>Automatic findings</div>
          <div class="card-body" id="debug-findings"></div>
        </div>
        <div class="dash-card experience-advanced">
          <div class="card-header"><i class="bi bi-clock-history me-1"></i>Recent commands & events</div>
          <div class="debug-event-list" id="debug-event-list"></div>
        </div>
      </div>
    </div>

    <div class="dash-card accent-red mb-3 experience-advanced">
      <div class="card-header"><i class="bi bi-terminal me-1"></i>Advanced raw command</div>
      <div class="card-body">
        <div class="d-flex gap-2 flex-wrap"><input type="text" class="form-control form-control-sm font-monospace flex-grow-1" id="debug-raw-input" placeholder='{"GET":"ALL"}'><button class="btn btn-outline-danger" id="debug-raw-send" disabled>Review & send</button></div>
        <div class="small text-muted mt-2">For engineering diagnosis only. JSON is validated, shown for confirmation, sent once, and recorded in the diagnostic history.</div>
        <div class="small mt-2" id="debug-raw-feedback" role="status"></div>
      </div>
    </div>

    <div class="dash-card mb-3 experience-advanced">
      <div class="card-header"><i class="bi bi-book me-1"></i>R17 mode reference</div>
      <div class="card-body"><div class="debug-mode-grid">${Object.entries(MODE_DEFINITIONS).map(([key, mode]) => `
        <details class="debug-mode-card"><summary><span>${mode.label}</span><small>${mode.outputs.join(' · ')}</small></summary><div class="pt-2"><p>${mode.purpose}</p><p><strong>When to use:</strong> ${mode.use}</p><p class="text-muted mb-0"><strong>R17 note:</strong> ${mode.warning}</p></div></details>`).join('')}</div></div>
    </div>`;
}

function summaryCard(id, label, value, icon) {
  return `<div class="debug-summary-card"><i class="bi ${icon}"></i><div><span>${label}</span><strong id="${id}">${value}</strong></div></div>`;
}

function plumbingSvg() {
  return `<div class="plumbing-map-wrap"><svg class="plumbing-map" viewBox="0 0 1240 645" role="img" aria-labelledby="plumbing-title plumbing-desc">
    <title id="plumbing-title">Conceptual IDS plumbing map</title><desc id="plumbing-desc">Traced diagram: ink supply and recirculation through the APS box pumps, an inline heater, a Xaar Aquinox recirculating printhead, a fluid-temperature thermistor, a return tee, and the ball-valve / pressure-control-box / vacuum branch. This build has no flush hardware; manifold valve 2 has no independent function.</desc>
    <defs><marker id="map-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z"></path></marker></defs>

    <!-- region labels -->
    <text x="60" y="58" fill="#64748b" font-size="12" font-weight="700" letter-spacing="1.5">INK &amp; APS BOX</text>
    <text x="560" y="58" fill="#64748b" font-size="12" font-weight="700" letter-spacing="1.5">CONDITIONING · WEIR · RETURN</text>
    <text x="1010" y="58" fill="#64748b" font-size="12" font-weight="700" letter-spacing="1.5">PRINTHEAD</text>

    <!-- APS box: solid container holding the pumps + vacuum -->
    <rect x="50" y="210" width="300" height="290" rx="14" fill="rgba(148,163,184,.06)" stroke="#3a4353" stroke-width="2"></rect>
    <text x="285" y="236" fill="#94a3b8" font-size="13" font-weight="700" letter-spacing="1">APS BOX</text>
    ${mapPort(200,210)}${mapPort(121,210)}${mapPort(70,500)}${mapPort(350,289)}${mapPort(350,377)}

    <!-- ink supply -> input pump -> heater -> printhead (2 inlets) -->
    <path class="map-pipe path-run" data-path="run purge" d="M200 165V235H251V262" marker-end="url(#map-arrow)"></path>
    <path class="map-pipe path-run" data-path="run purge" d="M277 289H450" marker-end="url(#map-arrow)"></path>
    <!-- return: tee -> recirc pump -> ink -->
    <path class="map-pipe path-return" data-path="run purge" d="M775 572H70V288H95" marker-end="url(#map-arrow)"></path>
    <path class="map-pipe path-return" data-path="run purge" d="M121 262V165" marker-end="url(#map-arrow)"></path>
    <path class="map-pipe path-run" data-path="run purge" d="M600 289H955V195H1085"></path>
    <path class="map-pipe path-run" data-path="run purge" d="M1055 195V205" marker-end="url(#map-arrow)"></path>
    <path class="map-pipe path-run" data-path="run purge" d="M1085 195V205" marker-end="url(#map-arrow)"></path>
    <!-- printhead return: 2 outlets converge -> thermistor -> tee -->
    <path class="map-pipe path-return" data-path="run purge" d="M1115 195V155"></path>
    <path class="map-pipe path-return" data-path="run purge" d="M1145 195V155"></path>
    <path class="map-pipe path-return" data-path="run purge" d="M1115 155H1215V572H1190" marker-end="url(#map-arrow)"></path>
    <path class="map-pipe path-return" data-path="run purge" d="M1005 572H845" marker-end="url(#map-arrow)"></path>
    <!-- tee top -> ball valve -> pressure control box (system pressurization) -->
    <path class="map-pipe path-run" data-path="run" d="M810 545V475"></path>
    <path class="map-pipe path-run" data-path="run" d="M785 455H740"></path>
    <!-- vacuum: OUT of pressure control box -> catch pot -> vacuum pump in APS box -->
    <path class="map-pipe path-vacuum" data-path="run" d="M647 405V377H500" marker-end="url(#map-arrow)"></path>
    <path class="map-pipe path-vacuum" data-path="run" d="M390 377H251V395" marker-end="url(#map-arrow)"></path>

    ${mapTank(105,80,'Ink supply','bulk + recirc')}
    ${mapComponent('node-recirc-pump',95,262,'pump','Recirc pump · R')}
    ${mapComponent('node-input-pump',225,262,'pump','Input pump · I')}
    ${mapComponent('node-drain-pump',95,392,'pump','Drain pump · D')}
    ${mapComponent('node-vacuum-pump',225,392,'pump','Vacuum pump')}
    ${mapBox(450,258,150,62,'Heater','+ thermocouple')}
    ${mapTank(390,345,'Catch pot','vac. overflow')}
    <g class="map-component" transform="translate(555 405)"><rect width="185" height="100" rx="9"></rect><text x="92" y="34">Pressure control box</text></g>
    ${mapFloat('node-weir-float',600,468,'WEIR')}
    ${mapFloat('node-weir-ovf-float',690,468,'WEIR OVF')}
    ${mapComponent('node-mv1',785,430,'valve','Ball valve')}
    ${mapTee(775,545)}
    ${mapBox(1005,542,185,60,'Thermistor','fluid temp')}
    ${mapPrinthead(1010,195)}

    <text class="map-note" x="60" y="196">recirc</text>
    <text class="map-note" x="206" y="196">supply</text>
    <text class="map-note" x="452" y="248">thermocouple</text>
    <text class="map-note" x="255" y="368">vacuum → vac pump</text>
    <text class="map-note" x="985" y="182">2 inlets</text>
    <text class="map-note" x="1150" y="150">2 outlets</text>
    <text class="map-note" x="1028" y="348">nozzles → ink out</text>
    <text class="map-note" x="300" y="592">outlet → recirc pump → ink</text>
    <text class="map-note" x="845" y="449">MV1 · opens in Run + Drain</text>
    <text class="map-note" x="845" y="465">(MV2 fires with it — no separate valve)</text>
  </svg></div>`;
}

function applyMapZoom() {
  const svg = document.querySelector('.plumbing-map');
  if (svg) svg.style.width = `${Math.round(mapZoom * 100)}%`;
  const label = document.getElementById('map-zoom-level');
  if (label) label.textContent = `${Math.round(mapZoom * 100)}%`;
}
function mapPort(x, y) {
  return `<circle cx="${x}" cy="${y}" r="4" fill="#3a4353" stroke="#64748b" stroke-width="1.5"></circle>`;
}
function mapFloat(id, x, y, label) {
  return `<g class="map-component float" id="${id}" transform="translate(${x} ${y})"><circle cx="0" cy="0" r="9"></circle><text class="map-subtext" x="0" y="25">${label}</text></g>`;
}

function mapTank(x, y, label, sublabel) {
  return `<g class="map-component tank" transform="translate(${x} ${y})"><path d="M0 10Q55-10 110 10V75Q55 95 0 75Z"></path><text x="55" y="40">${label}</text><text class="map-subtext" x="55" y="60">${sublabel}</text></g>`;
}
function mapComponent(id, x, y, type, label) {
  const symbol = type === 'pump' ? '<circle cx="26" cy="26" r="23"></circle><path d="M15 37L38 26L15 15Z"></path>' : '<path d="M2 6L50 46V6L2 46Z"></path>';
  return `<g class="map-component ${type}" id="${id}" transform="translate(${x} ${y})">${symbol}<text x="26" y="68">${label}</text><text class="map-state" x="26" y="84">—</text></g>`;
}
function mapBox(x, y, w, h, label, sublabel) {
  const sub = sublabel ? `<text class="map-subtext" x="${w / 2}" y="${h / 2 + 15}">${sublabel}</text>` : '';
  return `<g class="map-component box" transform="translate(${x} ${y})"><rect width="${w}" height="${h}" rx="9"></rect><text x="${w / 2}" y="${sublabel ? h / 2 - 2 : h / 2 + 4}">${label}</text>${sub}</g>`;
}
function mapTee(x, y) {
  return `<g class="map-component tee" transform="translate(${x} ${y})"><rect x="0" y="16" width="70" height="22" rx="6"></rect><rect x="24" y="0" width="22" height="54" rx="6"></rect><text x="35" y="74">Tee</text></g>`;
}
function mapPrinthead(x, y) {
  return `<g class="map-component printhead" transform="translate(${x} ${y})"><rect width="180" height="120" rx="12"></rect><text x="90" y="54">Xaar Aquinox</text><text class="map-subtext" x="90" y="76">2002 · recirculating</text><circle cx="45" cy="0" r="5"></circle><circle cx="75" cy="0" r="5"></circle><circle cx="105" cy="0" r="5"></circle><circle cx="135" cy="0" r="5"></circle><path class="ph-nozzles" d="M55 120v10M75 120v10M95 120v10M115 120v10M135 120v10"></path></g>`;
}

function bindEvents(panel) {
  panel.addEventListener('click', event => {
    const zoom = event.target.closest('[data-map-zoom]')?.dataset.mapZoom;
    if (zoom) {
      if (zoom === 'in') mapZoom = Math.min(2.5, Math.round((mapZoom + 0.2) * 10) / 10);
      else if (zoom === 'out') mapZoom = Math.max(0.8, Math.round((mapZoom - 0.2) * 10) / 10);
      else mapZoom = 1;
      applyMapZoom();
      return;
    }
    const preview = event.target.closest('[data-map-preview]')?.dataset.mapPreview;
    if (preview) {
      selectedPreview = preview;
      panel.querySelectorAll('[data-map-preview]').forEach(button => {
        button.className = `btn btn-sm ${button.dataset.mapPreview === preview ? 'btn-info' : 'btn-outline-secondary'}`;
      });
      updateSchematic(store.data);
    }
  });
  document.getElementById('debug-export')?.addEventListener('click', downloadDiagnosticBundle);
  document.getElementById('debug-filter')?.addEventListener('input', event => {
    telemetryFilter = event.target.value.trim().toLowerCase();
    renderTelemetry();
  });
  document.getElementById('debug-raw-send')?.addEventListener('click', sendRawCommand);
  document.getElementById('simulator-start')?.addEventListener('click', () => {
    const feedback = document.getElementById('simulator-feedback');
    try {
      const selected = document.getElementById('simulator-scenario')?.value || 'normal';
      const active = startFirmwareSimulator(selected);
      if (feedback) { feedback.textContent = `Running ${active}. Wait for the scenario evidence to accumulate, then export a diagnostic bundle.`; feedback.className = 'small mt-2 text-warning'; }
    } catch (error) {
      if (feedback) { feedback.textContent = error.message; feedback.className = 'small mt-2 text-danger'; }
    }
  });
  document.getElementById('simulator-stop')?.addEventListener('click', () => stopFirmwareSimulator());
}

async function sendRawCommand() {
  const input = document.getElementById('debug-raw-input');
  const feedback = document.getElementById('debug-raw-feedback');
  const raw = input?.value.trim();
  if (!raw) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || !Object.keys(parsed).length) throw new Error('Enter a non-empty JSON object.');
  } catch (error) {
    feedback.textContent = `Not sent: ${error.message}`; feedback.className = 'small mt-2 text-danger'; return;
  }
  const normalized = JSON.stringify(parsed);
  const ok = await confirm('Review raw controller command', `<p class="mb-2">Send this JSON once to the connected controller?</p><pre class="debug-command-review">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre><p class="text-danger mb-0">Raw commands bypass normal UI ranges and interlocks.</p>`, 'Send once', 'btn-danger');
  if (!ok) return;
  const written = await send(normalized);
  feedback.textContent = written ? 'Command written once; verify the resulting telemetry.' : 'Command was not sent. Check the controller connection.';
  feedback.className = `small mt-2 ${written ? 'text-success' : 'text-danger'}`;
  if (written) { store.log('command', `Debug raw command: ${normalized}`); input.value = ''; }
}

function updateLiveSummary(data) {
  setText('debug-connection', store.simulationActive ? 'SIMULATION' : store.connection);
  setText('debug-frame-age', lastDataAt ? `${Math.max(0, Math.floor((Date.now() - lastDataAt) / 1000))} s ago` : 'No frames');
  setText('debug-firmware', data.SoftwareRev || '—');
  setText('debug-poll', `${getPollIntervalMs()} ms`);
  const alarm = String(data.AlarmStatus ?? data.ErrorCode_STATE ?? 'Unknown');
  setText('debug-alarm', alarm);
  const rawButton = document.getElementById('debug-raw-send');
  if (rawButton) rawButton.disabled = store.connection !== 'CONNECTED' && !store.simulationActive;
  renderFindings();
}

function updateSimulatorUI() {
  const state = getFirmwareSimulatorState();
  const status = document.getElementById('simulator-status');
  const start = document.getElementById('simulator-start');
  const stop = document.getElementById('simulator-stop');
  const scenario = document.getElementById('simulator-scenario');
  if (status) {
    status.textContent = state.active ? `Running · ${state.scenario}` : 'Stopped';
    status.className = `badge ${state.active ? 'text-bg-warning' : 'text-bg-secondary'}`;
  }
  if (start) start.disabled = store.connection !== 'DISCONNECTED' || state.active;
  if (stop) stop.disabled = !state.active;
  if (scenario) scenario.disabled = state.active;
}

function updateSchematic(data) {
  const activeModes = selectedPreview === 'live' ? liveModes(data) : new Set([selectedPreview]);
  document.querySelectorAll('.map-pipe').forEach(path => {
    const modes = String(path.dataset.path || '').split(/\s+/);
    path.classList.toggle('active', modes.some(mode => activeModes.has(mode)));
  });
  for (const [id, key] of Object.entries(NODE_STATES)) {
    const node = document.getElementById(id);
    if (!node) continue;
    const value = data[key];
    const previewOn = selectedPreview !== 'live' && previewOutputs(selectedPreview).includes(key);
    const on = previewOn || Number(value) === 1;
    node.classList.toggle('on', on);
    node.classList.toggle('unknown', selectedPreview === 'live' && value === undefined);
    const state = node.querySelector('.map-state');
    if (state) state.textContent = selectedPreview !== 'live' ? (previewOn ? 'PREVIEW ON' : 'OFF') : value === undefined ? 'NO DATA' : on ? 'ON' : 'OFF';
  }
  const title = document.getElementById('map-context-title');
  const detail = document.getElementById('map-context-detail');
  if (title) title.textContent = selectedPreview === 'live' ? 'Live controller state' : `${capitalize(selectedPreview)} preview`;
  if (detail) detail.textContent = selectedPreview === 'live'
    ? 'Colored paths follow current mode and output readbacks.'
    : 'Preview only—no command is sent. This illustrates the intended electronic path, not verified hose routing.';
}

function liveModes(data) {
  const modes = new Set();
  for (const mode of ['run', 'purge', 'drain']) {
    if (Number(data[`${capitalize(mode)}_MODE`]) === 1) modes.add(mode);
  }
  return modes;
}

function previewOutputs(mode) {
  return {
    run: ['InputPump_STATE', 'RecirculationPump_STATE', 'VacuumPump_STATE', 'ManifoldValve1_STATE', 'ManifoldValve2_STATE'],
    purge: ['InputPump_STATE', 'RecirculationPump_STATE'],
    drain: ['DrainPump_STATE', 'ManifoldValve1_STATE', 'ManifoldValve2_STATE']
  }[mode] || [];
}

function renderTelemetry() {
  const body = document.getElementById('debug-telemetry-body');
  if (!body) return;
  const entries = Object.entries(store.data).sort(([a], [b]) => a.localeCompare(b)).filter(([key, value]) => !telemetryFilter || `${key} ${value}`.toLowerCase().includes(telemetryFilter));
  body.innerHTML = entries.length ? entries.slice(0, 300).map(([key, value]) => `<tr><td class="font-monospace">${escapeHtml(key)}</td><td>${escapeHtml(String(value))}</td><td class="text-muted">${escapeHtml(typeof value)}</td></tr>`).join('') : '<tr><td colspan="3" class="text-muted text-center py-4">No matching telemetry</td></tr>';
}

function renderFindings() {
  const target = document.getElementById('debug-findings');
  if (!target) return;
  const findings = getDiagnosticSnapshot().findings;
  target.innerHTML = findings.map(item => `<div class="debug-finding"><i class="bi ${item.startsWith('No rule') ? 'bi-check-circle text-success' : 'bi-info-circle text-info'}"></i><span>${escapeHtml(item)}</span></div>`).join('');
}

function renderEventHistory() {
  const target = document.getElementById('debug-event-list');
  if (!target) return;
  const events = getDiagnosticSnapshot().events.slice(-60).reverse();
  target.innerHTML = events.length ? events.map(event => `<div class="debug-event"><time>${escapeHtml(new Date(event.at).toLocaleTimeString())}</time><span class="debug-event-type">${escapeHtml(event.type || event.severity || 'event')}</span><code>${escapeHtml(event.command || event.message || event.state || '')}</code></div>`).join('') : '<div class="text-muted small p-3">No events captured in this session.</div>';
}

function setText(id, value) { const element = document.getElementById(id); if (element) element.textContent = value; }
function capitalize(value) { return String(value).charAt(0).toUpperCase() + String(value).slice(1); }
function escapeHtml(value) { const div = document.createElement('div'); div.textContent = value ?? ''; return div.innerHTML; }
