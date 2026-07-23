/* ===== ui-debug.js — engineering diagnostics and conceptual plumbing map ===== */

import store from './state.js';
import { send, getPollIntervalMs } from './serial.js';
import { MODE_DEFINITIONS } from './mode-control.js';
import { downloadDiagnosticBundle, getDiagnosticSnapshot } from './diagnostics.js';
import { confirm } from './ui-dialogs.js';
import { syncExperienceControls } from './experience-mode.js';

const MODE_PREVIEWS = ['live', 'run', 'purge', 'flush', 'drain', 'bypass'];
const NODE_STATES = {
  'node-input-pump': 'InputPump_STATE', 'node-recirc-pump': 'RecirculationPump_STATE',
  'node-drain-pump': 'DrainPump_STATE', 'node-vacuum-pump': 'VacuumPump_STATE',
  'node-flush-pump': 'flushPump_STATE', 'node-flush-valve': 'flushValve_STATE',
  'node-mv1': 'ManifoldValve1_STATE', 'node-mv2': 'ManifoldValve2_STATE',
  'node-bypass-valve': 'BypassValve_STATE'
};

let selectedPreview = 'live';
let telemetryFilter = '';
let lastDataAt = 0;
let refreshTimer = null;

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
  store.on('connection', () => updateLiveSummary(store.data));
  store.on('log', renderEventHistory);
  store.on('command-sent', renderEventHistory);
  refreshTimer = setInterval(() => updateLiveSummary(store.data), 1000);
  window.addEventListener('beforeunload', () => clearInterval(refreshTimer), { once: true });
  updateLiveSummary(store.data);
  updateSchematic(store.data);
  renderTelemetry();
  renderEventHistory();
  syncExperienceControls();
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

    <div class="dash-card accent-cyan mb-3">
      <div class="card-header d-flex align-items-center justify-content-between gap-2 flex-wrap">
        <span><i class="bi bi-diagram-3 me-1"></i>Conceptual plumbing map <span class="badge text-bg-secondary ms-1">FIRST PASS</span></span>
        <div class="schematic-mode-picker" role="group" aria-label="Diagram mode preview">
          ${MODE_PREVIEWS.map(mode => `<button type="button" class="btn btn-sm ${mode === 'live' ? 'btn-info' : 'btn-outline-secondary'}" data-map-preview="${mode}">${capitalize(mode)}</button>`).join('')}
        </div>
      </div>
      <div class="card-body">
        <div class="map-context mb-2"><span id="map-context-title">Live controller state</span><span id="map-context-detail">Solid colored lines are electronically active. Dashed lines are conceptual connections that require physical tracing.</span></div>
        ${plumbingSvg()}
        <div class="schematic-legend mt-2">
          <span><i class="legend-line live"></i>Active / previewed flow</span>
          <span><i class="legend-line known"></i>Firmware-backed connection</span>
          <span><i class="legend-line unknown"></i>Physical route to verify</span>
          <span><i class="legend-node"></i>Component readback ON</span>
        </div>
        <details class="debug-disclosure mt-3">
          <summary>Assumptions and known R17 limitations</summary>
          <div class="pt-2 small text-muted">This is an electronic behavior map, not a certified P&ID. Exact reservoir ports, Xaar inlet/return direction, bypass destination, and waste routing must be traced on the machine. R17's Flush timer may clear immediately after normal controller uptime; the diagram shows intended flush outputs when previewed.</div>
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
  return `<div class="plumbing-map-wrap"><svg class="plumbing-map" viewBox="0 0 1100 590" role="img" aria-labelledby="plumbing-title plumbing-desc">
    <title id="plumbing-title">Conceptual IDS plumbing map</title><desc id="plumbing-desc">First-pass diagram of reservoirs, pumps, valves, a Xaar 2002 printhead, vacuum, flush, drain, and bypass paths.</desc>
    <defs><marker id="map-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z"></path></marker></defs>
    <g class="map-zone"><rect x="25" y="45" width="220" height="390" rx="18"></rect><text x="45" y="75">SUPPLY & SERVICE</text></g>
    <g class="map-zone"><rect x="280" y="45" width="545" height="390" rx="18"></rect><text x="300" y="75">PRINTHEAD RECIRCULATION LOOP</text></g>
    <g class="map-zone"><rect x="860" y="45" width="215" height="390" rx="18"></rect><text x="880" y="75">VACUUM & WASTE</text></g>

    <path class="map-pipe path-supply uncertain" data-path="run purge" d="M130 150V235H330" marker-end="url(#map-arrow)"></path>
    <path class="map-pipe path-run uncertain" data-path="run purge" d="M400 235H485V175H540" marker-end="url(#map-arrow)"></path>
    <path class="map-pipe path-return uncertain" data-path="run purge" d="M700 175H755V330H615" marker-end="url(#map-arrow)"></path>
    <path class="map-pipe path-return uncertain" data-path="run purge" d="M545 330H370V280" marker-end="url(#map-arrow)"></path>
    <path class="map-pipe path-flush uncertain" data-path="flush" d="M130 380H330V235" marker-end="url(#map-arrow)"></path>
    <path class="map-pipe path-drain uncertain" data-path="drain" d="M590 235V475H960" marker-end="url(#map-arrow)"></path>
    <path class="map-pipe path-bypass uncertain" data-path="bypass" d="M430 235V400H720V330" marker-end="url(#map-arrow)"></path>
    <path class="map-pipe path-vacuum uncertain" data-path="run" d="M790 280H955V150" marker-end="url(#map-arrow)"></path>

    ${mapTank(75,105,'Bulk / supply','TO VERIFY')}
    ${mapComponent('node-input-pump',255,205,'pump','Input pump')}
    ${mapTank(320,205,'Weir reservoir','FLOATS')}
    ${mapComponent('node-mv1',475,205,'valve','Manifold V1')}
    ${mapPrinthead(540,125)}
    ${mapComponent('node-mv2',710,205,'valve','Manifold V2')}
    ${mapComponent('node-recirc-pump',545,300,'pump','Recirc pump')}
    ${mapTank(75,335,'Flush supply','TO VERIFY')}
    ${mapComponent('node-flush-pump',255,350,'pump','Flush pump')}
    ${mapComponent('node-flush-valve',330,350,'valve','Flush valve')}
    ${mapComponent('node-bypass-valve',505,370,'valve','Bypass valve')}
    ${mapComponent('node-drain-pump',700,445,'pump','Drain pump')}
    ${mapTank(900,445,'Waste','TO VERIFY')}
    ${mapComponent('node-vacuum-pump',925,115,'pump','Vacuum pump')}
    <text class="map-note" x="850" y="292">vacuum connection to verify</text>
    <text class="map-note" x="430" y="425">bypass destination to verify</text>
  </svg></div>`;
}

function mapTank(x, y, label, sublabel) {
  return `<g class="map-component tank" transform="translate(${x} ${y})"><path d="M0 10Q55-10 110 10V75Q55 95 0 75Z"></path><text x="55" y="38">${label}</text><text class="map-subtext" x="55" y="58">${sublabel}</text></g>`;
}
function mapComponent(id, x, y, type, label) {
  const symbol = type === 'pump' ? '<circle cx="26" cy="26" r="23"></circle><path d="M15 37L38 26L15 15Z"></path>' : '<path d="M2 6L50 46V6L2 46Z"></path>';
  return `<g class="map-component ${type}" id="${id}" transform="translate(${x} ${y})">${symbol}<text x="26" y="68">${label}</text><text class="map-state" x="26" y="84">—</text></g>`;
}
function mapPrinthead(x, y) {
  return `<g class="map-component printhead" transform="translate(${x} ${y})"><rect width="160" height="100" rx="12"></rect><text x="80" y="42">XAAR 2002</text><text x="80" y="64">PRINTHEAD</text><circle cx="8" cy="50" r="5"></circle><circle cx="152" cy="50" r="5"></circle></g>`;
}

function bindEvents(panel) {
  panel.addEventListener('click', event => {
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
  setText('debug-connection', store.connection);
  setText('debug-frame-age', lastDataAt ? `${Math.max(0, Math.floor((Date.now() - lastDataAt) / 1000))} s ago` : 'No frames');
  setText('debug-firmware', data.SoftwareRev || '—');
  setText('debug-poll', `${getPollIntervalMs()} ms`);
  const alarm = String(data.AlarmStatus ?? data.ErrorCode_STATE ?? 'Unknown');
  setText('debug-alarm', alarm);
  const rawButton = document.getElementById('debug-raw-send');
  if (rawButton) rawButton.disabled = store.connection !== 'CONNECTED';
  renderFindings();
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
  for (const mode of ['run', 'purge', 'flush', 'drain', 'bypass']) {
    if (Number(data[`${capitalize(mode)}_MODE`]) === 1) modes.add(mode);
  }
  return modes;
}

function previewOutputs(mode) {
  return {
    run: ['InputPump_STATE', 'RecirculationPump_STATE', 'VacuumPump_STATE', 'ManifoldValve1_STATE', 'ManifoldValve2_STATE'],
    purge: ['InputPump_STATE', 'RecirculationPump_STATE'],
    flush: ['flushPump_STATE', 'flushValve_STATE'],
    drain: ['DrainPump_STATE', 'ManifoldValve1_STATE', 'ManifoldValve2_STATE'],
    bypass: ['BypassValve_STATE']
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
