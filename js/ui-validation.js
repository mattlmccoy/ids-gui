/* ===== ui-validation.js — Guided physical I/O acceptance testing ===== */

import store from './state.js';
import { FLOATS, formatFloatState } from './float-state.js';

const STORAGE_KEY = 'ids-lab-validation-v1';
const CHANGE_KEYS = new Set([
  'SystemID', 'SoftwareRev', 'AlarmStatus', 'ErrorCode_STATE',
  'Run_MODE', 'Purge_MODE', 'Flush_MODE', 'Drain_MODE', 'Bypass_MODE',
  'FluidTemperature_STATE', 'MainHeaterTemperature_STATE', 'AUXHeaterTemperature_STATE',
  'Vacuum_STATE', 'Pressure_STATE',
  ...FLOATS.map(item => item.key),
  'InputPump_STATE', 'RecirculationPump_STATE', 'DrainPump_STATE', 'BulkSupplyPump_STATE',
  'VacuumPump_STATE', 'flushPump_STATE', 'ManifoldValve1_STATE', 'ManifoldValve2_STATE',
  'DrainValve_STATE', 'BulkSupplyValve_STATE', 'BypassValve_STATE', 'flushValve_STATE'
]);

const TESTS = [
  test('identity-system', 'Connection', 'System identity', 'Connect the controller and confirm SystemID matches the physical machine.', ['SystemID']),
  test('identity-firmware', 'Connection', 'Firmware revision', 'Record the reported firmware revision.', ['SoftwareRev']),
  test('telemetry-stream', 'Connection', 'Stable telemetry', 'Observe fresh data for at least 30 seconds without a stale-data warning.', ['SystemID', 'Vacuum_STATE']),
  ...FLOATS.map(item => test(
    `float-${item.key}`, 'Floats', item.label,
    'Move the physical float through DOWN and UP. Confirm raw and displayed states change and the displayed direction is correct.',
    [item.key], item.key
  )),
  test('mode-run', 'Modes', 'Run / Stop', 'Use Operation controls to RUN and STOP. Confirm Run_MODE follows both commands.', ['Run_MODE']),
  test('mode-purge', 'Modes', 'Purge', 'With the system stopped, toggle Purge ON/OFF and confirm Purge_MODE.', ['Purge_MODE']),
  test('mode-flush', 'Modes', 'Flush', 'With the system stopped, toggle Flush ON/OFF and confirm Flush_MODE.', ['Flush_MODE']),
  test('mode-drain', 'Modes', 'Drain', 'With the system stopped, toggle Drain ON/OFF and confirm Drain_MODE.', ['Drain_MODE']),
  test('mode-bypass', 'Modes', 'Bypass', 'Toggle Bypass ON/OFF and confirm Bypass_MODE and the physical flow path.', ['Bypass_MODE', 'BypassValve_STATE']),
  ...[
    ['InputPump_STATE', 'Input pump'], ['RecirculationPump_STATE', 'Recirculation pump'],
    ['DrainPump_STATE', 'Drain pump'], ['BulkSupplyPump_STATE', 'Bulk supply pump'],
    ['VacuumPump_STATE', 'Vacuum pump'], ['flushPump_STATE', 'Flush pump']
  ].map(([key, label]) => test(`actuator-${key}`, 'Actuators', label, 'Exercise the related operating mode and confirm software readback plus physical actuation.', [key])),
  ...[
    ['ManifoldValve1_STATE', 'Manifold valve 1'], ['ManifoldValve2_STATE', 'Manifold valve 2'],
    ['DrainValve_STATE', 'Drain valve'], ['BulkSupplyValve_STATE', 'Bulk supply valve'],
    ['BypassValve_STATE', 'Bypass valve'], ['flushValve_STATE', 'Flush valve']
  ].map(([key, label]) => test(`actuator-${key}`, 'Actuators', label, 'Exercise the related mode and confirm software readback plus physical valve movement.', [key])),
  test('sensor-fluid-temp', 'Sensors', 'Fluid temperature', 'Compare the displayed value with a trusted reference or ambient expectation.', ['FluidTemperature_STATE']),
  test('sensor-main-temp', 'Sensors', 'Main heater temperature', 'Compare the displayed value with a trusted reference, or mark N/A if not installed.', ['MainHeaterTemperature_STATE']),
  test('sensor-aux-temp', 'Sensors', 'Aux heater temperature', 'Compare the displayed value with a trusted reference, or mark N/A if not installed.', ['AUXHeaterTemperature_STATE']),
  test('sensor-vacuum', 'Sensors', 'Vacuum', 'Apply a known operating condition and confirm sign, units, and plausible response.', ['Vacuum_STATE']),
  test('sensor-pressure', 'Sensors', 'Pressure', 'Apply a known operating condition and confirm units and plausible response.', ['Pressure_STATE']),
  test('alert-weir', 'Alerts', 'Weir OVF notification', 'Activate Weir OVF longer than the debounce. Confirm ntfy alert and recovery.', ['WeirOverflowFloat_STATE']),
  test('alert-supply', 'Alerts', 'Supply OVF notification', 'Activate Supply OVF longer than the debounce. Confirm ntfy alert and recovery.', ['SupplyOverflowFloat_STATE']),
  test('alert-alarm', 'Alerts', 'Firmware alarm notification', 'Trigger only a safe, approved test alarm. Confirm alarm detail and recovery notification.', ['AlarmStatus', 'ErrorCode_STATE']),
  test('alert-disconnect', 'Alerts', 'Unexpected disconnect', 'After other tests, disconnect USB unexpectedly and confirm disconnect/reconnect notifications.', [])
];

let state = loadState();
let lastObserved = {};

export function initValidationTab() {
  const panel = document.getElementById('panel-validation');
  if (!panel) return;
  panel.innerHTML = buildHTML();
  bindEvents(panel);
  render(panel);
  store.on('data', data => onData(panel, data));
  store.on('connection', () => renderHeader(panel));
  store.on('command-sent', command => recordTimeline('command', 'outbound', command));
  store.on('error', payload => recordTimeline('alarm', 'AlarmStatus', payload?.raw));
}

function test(id, category, label, instruction, keys, floatKey = null) {
  return { id, category, label, instruction, keys, floatKey };
}

function buildHTML() {
  const categories = [...new Set(TESTS.map(item => item.category))];
  return `
    <div class="alert alert-info d-flex gap-2 align-items-start">
      <i class="bi bi-shield-check fs-5"></i>
      <div><strong>Guided acceptance test.</strong> This page records observations but never actuates hardware.
      Use the Operation tab for commands, follow lab safety procedures, and mark a result only after checking the physical machine.</div>
    </div>
    <div class="dash-card mb-3">
      <div class="card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
        <span><i class="bi bi-clipboard-data me-1"></i>Validation session</span>
        <span class="badge text-bg-secondary" id="validation-connection">Disconnected</span>
      </div>
      <div class="card-body">
        <div class="row g-2">
          <div class="col-md-3"><label class="form-label small">Tester</label><input id="validation-tester" class="form-control form-control-sm" maxlength="80"></div>
          <div class="col-md-3"><label class="form-label small">Machine / location</label><input id="validation-location" class="form-control form-control-sm" maxlength="80"></div>
          <div class="col-md-6"><label class="form-label small">Session notes</label><input id="validation-session-notes" class="form-control form-control-sm" maxlength="300"></div>
        </div>
        <div class="d-flex flex-wrap align-items-center gap-2 mt-3">
          <button class="btn btn-sm btn-outline-secondary" id="validation-new"><i class="bi bi-file-earmark-plus me-1"></i>New session</button>
          <button class="btn btn-sm btn-outline-primary" id="validation-export-json"><i class="bi bi-download me-1"></i>Export JSON</button>
          <button class="btn btn-sm btn-outline-primary" id="validation-export-md"><i class="bi bi-file-text me-1"></i>Export report</button>
          <span class="small text-muted" id="validation-session-time"></span>
        </div>
      </div>
    </div>
    <div class="row g-2 mb-3" id="validation-summary"></div>
    <div class="accordion" id="validation-accordion">
      ${categories.map((category, index) => `
        <div class="accordion-item">
          <h2 class="accordion-header">
            <button class="accordion-button${index ? ' collapsed' : ''}" type="button" data-bs-toggle="collapse" data-bs-target="#validation-${slug(category)}">
              ${escapeHtml(category)} <span class="badge text-bg-secondary ms-2" id="validation-count-${slug(category)}"></span>
            </button>
          </h2>
          <div id="validation-${slug(category)}" class="accordion-collapse collapse${index ? '' : ' show'}" data-bs-parent="#validation-accordion">
            <div class="accordion-body p-0"><div class="table-responsive"><table class="table table-sm align-middle mb-0">
              <thead><tr><th style="min-width:150px">Check</th><th style="min-width:260px">Procedure</th><th style="min-width:180px">Live readback</th><th style="min-width:210px">Result</th></tr></thead>
              <tbody>${TESTS.filter(item => item.category === category).map(renderRow).join('')}</tbody>
            </table></div></div>
          </div>
        </div>`).join('')}
    </div>`;
}

function renderRow(item) {
  return `<tr data-validation-row="${item.id}">
    <td><strong>${escapeHtml(item.label)}</strong><div class="small text-muted validation-result-time"></div></td>
    <td class="small">${escapeHtml(item.instruction)}<textarea class="form-control form-control-sm mt-2 validation-note" rows="1" placeholder="Observation / issue"></textarea></td>
    <td class="font-monospace small validation-live">Waiting for telemetry…</td>
    <td><div class="btn-group btn-group-sm" role="group" aria-label="Validation result">
      <button class="btn btn-outline-success validation-result" data-result="pass">Pass</button>
      <button class="btn btn-outline-danger validation-result" data-result="fail">Fail</button>
      <button class="btn btn-outline-secondary validation-result" data-result="na">N/A</button>
      <button class="btn btn-outline-secondary validation-result" data-result="pending" title="Reset"><i class="bi bi-arrow-counterclockwise"></i></button>
    </div></td>
  </tr>`;
}

function bindEvents(panel) {
  for (const id of ['tester', 'location', 'session-notes']) {
    panel.querySelector(`#validation-${id}`)?.addEventListener('input', event => {
      state.meta[id === 'session-notes' ? 'notes' : id] = event.target.value;
      saveState();
    });
  }
  panel.addEventListener('click', event => {
    const button = event.target.closest('.validation-result');
    if (!button) return;
    const row = button.closest('[data-validation-row]');
    const id = row?.dataset.validationRow;
    if (!id) return;
    state.results[id] = { ...(state.results[id] || {}), result: button.dataset.result, at: new Date().toISOString() };
    saveState();
    render(panel);
  });
  panel.addEventListener('change', event => {
    if (!event.target.classList.contains('validation-note')) return;
    const id = event.target.closest('[data-validation-row]')?.dataset.validationRow;
    if (!id) return;
    state.results[id] = { ...(state.results[id] || { result: 'pending' }), note: event.target.value };
    saveState();
  });
  panel.querySelector('#validation-new')?.addEventListener('click', () => {
    if (!window.confirm('Start a new validation session? Export the current report first if it must be retained.')) return;
    state = createState();
    lastObserved = {};
    saveState();
    render(panel);
  });
  panel.querySelector('#validation-export-json')?.addEventListener('click', () => download('json'));
  panel.querySelector('#validation-export-md')?.addEventListener('click', () => download('md'));
}

function onData(panel, data) {
  const now = new Date().toISOString();
  for (const key of CHANGE_KEYS) {
    if (data[key] === undefined || Object.is(lastObserved[key], data[key])) continue;
    lastObserved[key] = data[key];
    recordTimeline('state', key, data[key], now);
  }
  state.lastSnapshot = Object.fromEntries([...CHANGE_KEYS].filter(key => data[key] !== undefined).map(key => [key, data[key]]));
  saveState();
  renderLive(panel, data);
  renderHeader(panel);
}

function render(panel) {
  panel.querySelector('#validation-tester').value = state.meta.tester || '';
  panel.querySelector('#validation-location').value = state.meta.location || '';
  panel.querySelector('#validation-session-notes').value = state.meta.notes || '';
  for (const item of TESTS) {
    const row = panel.querySelector(`[data-validation-row="${item.id}"]`);
    if (!row) continue;
    const result = state.results[item.id] || { result: 'pending', note: '' };
    row.querySelector('.validation-note').value = result.note || '';
    row.querySelector('.validation-result-time').textContent = result.at ? new Date(result.at).toLocaleString() : '';
    row.querySelectorAll('.validation-result').forEach(button => {
      const active = button.dataset.result === result.result;
      button.classList.toggle('active', active);
    });
  }
  renderLive(panel, store.data);
  renderHeader(panel);
  renderSummary(panel);
}

function renderLive(panel, data) {
  for (const item of TESTS) {
    const cell = panel.querySelector(`[data-validation-row="${item.id}"] .validation-live`);
    if (!cell) continue;
    if (!item.keys.length) { cell.textContent = 'Manual observation'; continue; }
    const lines = item.keys.map(key => {
      const raw = data?.[key];
      if (raw === undefined) return `${key}: —`;
      const display = item.floatKey === key ? ` → ${formatFloatState(key, raw)}` : '';
      return `${key}: ${String(raw)}${display}`;
    });
    cell.textContent = lines.join('\n');
    cell.style.whiteSpace = 'pre-wrap';
  }
}

function renderHeader(panel) {
  const badge = panel.querySelector('#validation-connection');
  const connected = store.connection === 'CONNECTED';
  badge.textContent = connected ? 'Controller connected' : 'Controller disconnected';
  badge.className = `badge ${connected ? 'text-bg-success' : 'text-bg-secondary'}`;
  panel.querySelector('#validation-session-time').textContent = `Started ${new Date(state.startedAt).toLocaleString()} · ${state.timeline.length} changes recorded`;
}

function renderSummary(panel) {
  const counts = { pass: 0, fail: 0, na: 0, pending: 0 };
  for (const item of TESTS) counts[state.results[item.id]?.result || 'pending']++;
  panel.querySelector('#validation-summary').innerHTML = [
    ['success', counts.pass, 'Passed'], ['danger', counts.fail, 'Failed'],
    ['secondary', counts.pending, 'Pending'], ['secondary', counts.na, 'N/A']
  ].map(([color, value, label]) => `<div class="col-6 col-md-3"><div class="dash-card p-3"><div class="fs-4 text-${color}">${value}</div><div class="small text-muted">${label}</div></div></div>`).join('');
  for (const category of new Set(TESTS.map(item => item.category))) {
    const group = TESTS.filter(item => item.category === category);
    const complete = group.filter(item => (state.results[item.id]?.result || 'pending') !== 'pending').length;
    const badge = panel.querySelector(`#validation-count-${slug(category)}`);
    if (badge) badge.textContent = `${complete}/${group.length}`;
  }
}

function recordTimeline(kind, key, value, at = new Date().toISOString()) {
  state.timeline.push({ at, kind, key, value: value === undefined ? null : value });
  if (state.timeline.length > 1000) state.timeline.splice(0, state.timeline.length - 1000);
  saveState();
}

function download(format) {
  const payload = buildReport();
  const base = `ids-validation-${safeFile(payload.systemId || state.meta.location || 'session')}-${new Date().toISOString().slice(0, 10)}`;
  const content = format === 'json' ? JSON.stringify(payload, null, 2) : buildMarkdown(payload);
  const blob = new Blob([content], { type: format === 'json' ? 'application/json' : 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${base}.${format === 'json' ? 'json' : 'md'}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildReport() {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    startedAt: state.startedAt,
    systemId: store.data.SystemID || state.lastSnapshot.SystemID || null,
    softwareRev: store.data.SoftwareRev || state.lastSnapshot.SoftwareRev || null,
    tester: state.meta.tester || null,
    location: state.meta.location || null,
    notes: state.meta.notes || null,
    summary: TESTS.reduce((acc, item) => { const key = state.results[item.id]?.result || 'pending'; acc[key]++; return acc; }, { pass: 0, fail: 0, na: 0, pending: 0 }),
    checks: TESTS.map(item => ({ ...item, ...(state.results[item.id] || { result: 'pending', note: '' }) })),
    lastSnapshot: state.lastSnapshot,
    timeline: state.timeline
  };
}

function buildMarkdown(report) {
  const lines = [
    '# IDS Lab Validation Report', '',
    `- System: ${report.systemId || '—'}`,
    `- Firmware: ${report.softwareRev || '—'}`,
    `- Tester: ${report.tester || '—'}`,
    `- Location: ${report.location || '—'}`,
    `- Started: ${report.startedAt}`,
    `- Exported: ${report.exportedAt}`,
    `- Results: ${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.pending} pending, ${report.summary.na} N/A`,
    '', `Notes: ${report.notes || '—'}`, ''
  ];
  for (const category of new Set(report.checks.map(item => item.category))) {
    lines.push(`## ${category}`, '', '| Result | Check | Observation |', '|---|---|---|');
    for (const item of report.checks.filter(check => check.category === category)) {
      lines.push(`| ${String(item.result || 'pending').toUpperCase()} | ${md(item.label)} | ${md(item.note || '')} |`);
    }
    lines.push('');
  }
  lines.push('## Last telemetry snapshot', '', '```json', JSON.stringify(report.lastSnapshot, null, 2), '```', '');
  return lines.join('\n');
}

function createState() {
  return { startedAt: new Date().toISOString(), meta: { tester: '', location: '', notes: '' }, results: {}, lastSnapshot: {}, timeline: [] };
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (parsed?.startedAt && parsed.results && Array.isArray(parsed.timeline)) return parsed;
  } catch (_) { /* start a clean session */ }
  return createState();
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* report remains available in memory */ }
}

function slug(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
function safeFile(value) { return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'session'; }
function md(value) { return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}
