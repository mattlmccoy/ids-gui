/* ===== ui-validation.js — One-time guided commissioning workflow ===== */

import store from './state.js';
import { FLOATS, formatFloatState } from './float-state.js';

const STORAGE_KEY = 'ids-lab-certification-v2';
const OBSERVATION_SECONDS = 10;

const TESTS = [
  presence('identity-system', 'Connection', 'System identity', 'Connect the controller. SystemID is captured automatically.', 'SystemID'),
  presence('identity-firmware', 'Connection', 'Firmware revision', 'Firmware revision is captured automatically.', 'SoftwareRev'),
  { id: 'telemetry-stream', category: 'Connection', label: 'Stable telemetry', instruction: `Remain connected for ${OBSERVATION_SECONDS} seconds while the analyzer checks continuity.`, kind: 'telemetry', auto: true },
  ...FLOATS.map(item => binary(
    `float-${item.key}`, 'Floats', item.label,
    `Move the ${item.label} float fully DOWN and UP. The analyzer records both states; confirm the physical direction matches the displayed direction.`,
    item.key, true, item.key
  )),
  ...[
    ['Run_MODE', 'Run / Stop'], ['Purge_MODE', 'Purge'], ['Flush_MODE', 'Flush'],
    ['Drain_MODE', 'Drain'], ['Bypass_MODE', 'Bypass']
  ].map(([key, label]) => binary(`mode-${key}`, 'Modes', label,
    `Use the Operation tab to exercise ${label} ON and OFF. The analyzer verifies both controller readbacks; confirm the machine behaved correctly.`, key, true)),
  ...[
    ['InputPump_STATE', 'Input pump'], ['RecirculationPump_STATE', 'Recirculation pump'],
    ['DrainPump_STATE', 'Drain pump'], ['BulkSupplyPump_STATE', 'Bulk supply pump'],
    ['VacuumPump_STATE', 'Vacuum pump'], ['flushPump_STATE', 'Flush pump'],
    ['ManifoldValve1_STATE', 'Manifold valve 1'], ['ManifoldValve2_STATE', 'Manifold valve 2'],
    ['DrainValve_STATE', 'Drain valve'], ['BulkSupplyValve_STATE', 'Bulk supply valve'],
    ['BypassValve_STATE', 'Bypass valve'], ['flushValve_STATE', 'Flush valve']
  ].map(([key, label]) => binary(`actuator-${key}`, 'Actuators', label,
    `Exercise the related mode from Operation. The analyzer records OFF/ON readback; visually or audibly confirm ${label} physically actuates.`, key, true)),
  sensor('sensor-fluid-temp', 'Fluid temperature', 'FluidTemperature_STATE', -10, 100),
  sensor('sensor-main-temp', 'Main heater temperature', 'MainHeaterTemperature_STATE', -40, 250),
  sensor('sensor-aux-temp', 'Aux heater temperature', 'AUXHeaterTemperature_STATE', -40, 250),
  sensor('sensor-vacuum', 'Vacuum response', 'Vacuum_STATE', -500, 500),
  sensor('sensor-pressure', 'Pressure response', 'Pressure_STATE', -10, 200),
  manual('alert-weir', 'Alerts', 'Weir OVF notification', 'Hold Weir OVF active beyond the debounce, then clear it. Confirm activation and recovery arrive on ntfy/Slack.'),
  manual('alert-supply', 'Alerts', 'Supply OVF notification', 'Hold Supply OVF active beyond the debounce, then clear it. Confirm activation and recovery arrive on ntfy/Slack.'),
  { id: 'alert-alarm', category: 'Alerts', label: 'Firmware alarm lifecycle', instruction: 'Using only a safe approved method, trigger and clear one firmware alarm. The analyzer detects both states; confirm notifications contain the correct alarm.', kind: 'alarm', physical: true },
  { id: 'alert-disconnect', category: 'Alerts', label: 'Unexpected disconnect lifecycle', instruction: 'Perform this last: disconnect and reconnect USB. The analyzer records the lifecycle; confirm remote notifications arrive.', kind: 'disconnect', physical: true }
];

let state = loadState();
let renderTimer = null;

export function initValidationTab() {
  const panel = document.getElementById('panel-validation');
  if (!panel) return;
  panel.innerHTML = buildShell();
  bindEvents(panel);
  store.on('data', data => observeData(panel, data));
  store.on('connection', connection => observeConnection(panel, connection));
  store.on('command-sent', command => recordTimeline('command', 'outbound', command));
  store.on('error', payload => recordTimeline('alarm', 'AlarmStatus', payload?.raw));
  render(panel);
  renderTimer = setInterval(() => {
    if (state.status === 'running') analyzeAll();
    render(panel);
  }, 1000);
  window.addEventListener('beforeunload', () => clearInterval(renderTimer), { once: true });
}

function presence(id, category, label, instruction, key) {
  return { id, category, label, instruction, kind: 'presence', key, auto: true };
}
function binary(id, category, label, instruction, key, physical = false, floatKey = null) {
  return { id, category, label, instruction, kind: 'binary', key, physical, floatKey };
}
function sensor(id, label, key, min, max) {
  return { id, category: 'Sensors', label, instruction: `The analyzer collects at least 8 readings and checks that ${label.toLowerCase()} remains finite and within a broad ${min} to ${max} sanity range. Compare it with a trusted reference before confirming.`, kind: 'sensor', key, min, max, physical: true };
}
function manual(id, category, label, instruction) {
  return { id, category, label, instruction, kind: 'manual', physical: true };
}

function buildShell() {
  return `<div id="validation-root"></div>`;
}

function bindEvents(panel) {
  panel.addEventListener('click', event => {
    const action = event.target.closest('[data-validation-action]')?.dataset.validationAction;
    if (!action) return;
    if (action === 'start') return startSession(panel, false);
    if (action === 'service') return markServiced(panel);
    if (action === 'export') return downloadReport();
    if (action === 'operation') return showOperationTab();
    if (action === 'previous') state.currentIndex = Math.max(0, state.currentIndex - 1);
    if (action === 'next') state.currentIndex = Math.min(TESTS.length - 1, state.currentIndex + 1);
    if (action === 'pass' || action === 'fail' || action === 'na') setResult(TESTS[state.currentIndex], action, 'operator');
    if (action === 'finish') finishCertification();
    saveState();
    render(panel);
  });
  panel.addEventListener('change', event => {
    if (event.target.id === 'validation-tester') state.meta.tester = event.target.value.slice(0, 80);
    if (event.target.id === 'validation-location') state.meta.location = event.target.value.slice(0, 80);
    if (event.target.id === 'validation-note') {
      const test = TESTS[state.currentIndex];
      state.results[test.id] = { ...(state.results[test.id] || {}), note: event.target.value.slice(0, 500) };
    }
    saveState();
  });
}

function startSession(panel, serviced) {
  if (state.status === 'running' && !window.confirm('Restart the current certification and discard its progress?')) return;
  if (state.certificate && !serviced && !window.confirm('A completed certification exists. Start a new certification anyway?')) return;
  const previousMeta = state.meta || {};
  state = createState();
  state.status = 'running';
  state.meta = previousMeta;
  state.startedAt = new Date().toISOString();
  if (store.connection === 'CONNECTED') observeConnection(panel, 'CONNECTED');
  render(panel);
  saveState();
}

function markServiced(panel) {
  if (!window.confirm('Mark the machine as serviced or reassembled? This invalidates the prior certification and starts a fresh validation.')) return;
  const previousMeta = state.meta || {};
  state = createState();
  state.status = 'running';
  state.revalidationReason = 'Machine serviced or reassembled';
  state.meta = previousMeta;
  state.startedAt = new Date().toISOString();
  render(panel);
  saveState();
}

function observeData(panel, data) {
  if (state.status !== 'running') return;
  const now = new Date().toISOString();
  state.telemetry.frames += 1;
  state.telemetry.firstAt ||= now;
  state.telemetry.lastAt = now;
  for (const test of TESTS) {
    if (!test.key || data[test.key] === undefined) continue;
    const value = data[test.key];
    const seen = state.observed[test.key] ||= [];
    const normalized = String(value);
    if (!seen.includes(normalized)) {
      seen.push(normalized);
      recordTimeline('state', test.key, value, now);
    }
    if (test.kind === 'sensor') {
      const samples = state.samples[test.key] ||= [];
      const numeric = Number(value);
      if (Number.isFinite(numeric)) samples.push({ at: now, value: numeric });
      if (samples.length > 30) samples.splice(0, samples.length - 30);
    }
  }
  const alarm = data.AlarmStatus ?? data.ErrorCode_STATE;
  if (alarm !== undefined) {
    const active = !String(alarm).endsWith('NO_ERROR');
    if (active) state.lifecycle.alarmActive = true;
    if (!active && state.lifecycle.alarmActive) state.lifecycle.alarmRecovered = true;
  }
  state.lastSnapshot = { ...state.lastSnapshot, ...pickSnapshot(data) };
  state.systemId = data.SystemID || state.systemId;
  state.softwareRev = data.SoftwareRev || state.softwareRev;
  analyzeAll();
  saveState();
  render(panel);
}

function observeConnection(panel, connection) {
  if (state.status !== 'running') return;
  const history = state.lifecycle.connections;
  if (history[history.length - 1] !== connection) {
    history.push(connection);
    recordTimeline('connection', 'controller', connection);
  }
  if (history.includes('CONNECTED') && history.includes('DISCONNECTED') && history[history.length - 1] === 'CONNECTED') {
    state.lifecycle.disconnectRecovered = true;
  }
  analyzeAll();
  saveState();
  render(panel);
}

function analyzeAll() {
  if (state.status !== 'running') return;
  for (const test of TESTS) {
    if (state.results[test.id]?.result && state.results[test.id].result !== 'pending') continue;
    const analysis = analyze(test);
    state.analysis[test.id] = analysis;
    if (analysis.status === 'pass' && test.auto) setResult(test, 'pass', 'automatic', analysis.message);
  }
  const current = TESTS[state.currentIndex];
  if (state.results[current?.id]?.result === 'pass' && state.results[current.id].source === 'automatic') {
    const next = TESTS.findIndex((test, index) => index > state.currentIndex && !(state.results[test.id]?.result));
    if (next >= 0) state.currentIndex = next;
  }
}

function analyze(test) {
  if (test.kind === 'presence') {
    const value = state.lastSnapshot[test.key];
    return value !== undefined && value !== ''
      ? { status: 'pass', message: `${test.key} captured: ${value}` }
      : { status: 'waiting', message: `Waiting for ${test.key}` };
  }
  if (test.kind === 'telemetry') {
    const elapsed = state.telemetry.firstAt ? (Date.now() - new Date(state.telemetry.firstAt).getTime()) / 1000 : 0;
    const pass = state.telemetry.frames >= 8 && elapsed >= OBSERVATION_SECONDS && store.connection === 'CONNECTED';
    return pass
      ? { status: 'pass', message: `${state.telemetry.frames} frames observed over ${Math.round(elapsed)} seconds` }
      : { status: 'waiting', message: `${state.telemetry.frames}/8 frames · ${Math.min(OBSERVATION_SECONDS, Math.round(elapsed))}/${OBSERVATION_SECONDS} seconds` };
  }
  if (test.kind === 'binary') {
    const seen = state.observed[test.key] || [];
    const complete = seen.includes('0') && seen.includes('1');
    return complete
      ? { status: test.physical ? 'confirm' : 'pass', message: 'Both OFF (0) and ON (1) readbacks observed. Confirm physical behavior.' }
      : { status: 'waiting', message: `Observed: ${seen.length ? seen.join(', ') : 'no values yet'} · need both 0 and 1` };
  }
  if (test.kind === 'sensor') {
    const samples = state.samples[test.key] || [];
    if (samples.length < 8) return { status: 'waiting', message: `${samples.length}/8 finite readings collected` };
    const values = samples.map(sample => sample.value);
    const min = Math.min(...values); const max = Math.max(...values); const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const plausible = min >= test.min && max <= test.max;
    return { status: plausible ? 'confirm' : 'fail', message: `Average ${fmt(avg)}, range ${fmt(min)}–${fmt(max)}${plausible ? '. Compare with a reference.' : '. Outside provisional sanity range.'}` };
  }
  if (test.kind === 'alarm') {
    return state.lifecycle.alarmActive && state.lifecycle.alarmRecovered
      ? { status: 'confirm', message: 'Active alarm and subsequent NO_ERROR recovery observed.' }
      : { status: 'waiting', message: `Alarm active: ${yesNo(state.lifecycle.alarmActive)} · recovery: ${yesNo(state.lifecycle.alarmRecovered)}` };
  }
  if (test.kind === 'disconnect') {
    return state.lifecycle.disconnectRecovered
      ? { status: 'confirm', message: 'Connected → disconnected → reconnected lifecycle observed.' }
      : { status: 'waiting', message: `Connection history: ${state.lifecycle.connections.join(' → ') || 'none'}` };
  }
  return { status: 'manual', message: 'Requires operator observation and confirmation.' };
}

function setResult(test, result, source, message = '') {
  state.results[test.id] = {
    ...(state.results[test.id] || {}), result, source, at: new Date().toISOString(),
    analysis: message || state.analysis[test.id]?.message || ''
  };
  if (result !== 'pending') {
    const next = TESTS.findIndex((item, index) => index > state.currentIndex && !state.results[item.id]?.result);
    if (next >= 0) state.currentIndex = next;
  }
}

function finishCertification() {
  const summary = summarize();
  if (summary.pending) return;
  state.status = 'complete';
  state.certificate = {
    completedAt: new Date().toISOString(), systemId: state.systemId || null,
    softwareRev: state.softwareRev || null, result: summary.fail ? 'failed' : 'passed', summary
  };
  saveState();
}

function render(panel) {
  const root = panel.querySelector('#validation-root');
  if (!root) return;
  if (state.status !== 'running') {
    root.innerHTML = renderLanding();
    return;
  }
  analyzeAll();
  const current = TESTS[state.currentIndex] || TESTS[0];
  const analysis = state.analysis[current.id] || analyze(current);
  const result = state.results[current.id];
  const summary = summarize();
  const progress = Math.round(((TESTS.length - summary.pending) / TESTS.length) * 100);
  root.innerHTML = `
    <div class="alert alert-warning"><strong><i class="bi bi-exclamation-triangle-fill me-1"></i>Commissioning mode:</strong>
      the analyzer observes controller telemetry but never proves physical safety. It does not automatically actuate pumps or valves. Follow lab SOP, keep clear of moving/fluid components, and confirm physical behavior yourself.</div>
    <div class="row g-3">
      <div class="col-xl-8">
        <div class="dash-card accent-blue">
          <div class="card-header d-flex justify-content-between align-items-center"><span>Current test ${state.currentIndex + 1} of ${TESTS.length}</span><span class="badge ${analysisBadge(analysis.status)}">${analysisLabel(analysis.status)}</span></div>
          <div class="card-body p-4">
            <div class="small text-primary text-uppercase fw-semibold">${escapeHtml(current.category)}</div>
            <h2 class="h4 mt-1">${escapeHtml(current.label)}</h2>
            <p>${escapeHtml(current.instruction)}</p>
            ${current.physical ? '<div class="alert alert-danger py-2 small"><strong>Physical confirmation required.</strong> A readback change alone does not prove the component moved or the plumbing response is correct.</div>' : ''}
            <div class="border rounded p-3 mb-3"><div class="small text-muted">Automatic analysis</div><div class="fw-semibold">${escapeHtml(analysis.message)}</div>${liveReadback(current)}</div>
            <label class="form-label small" for="validation-note">Observation / issue</label>
            <textarea id="validation-note" class="form-control mb-3" rows="2">${escapeHtml(result?.note || '')}</textarea>
            <div class="d-flex flex-wrap gap-2">
              <button class="btn btn-outline-secondary" data-validation-action="previous" ${state.currentIndex === 0 ? 'disabled' : ''}>Previous</button>
              <button class="btn btn-outline-primary" data-validation-action="operation">Open Operation</button>
              <span class="flex-grow-1"></span>
              <button class="btn btn-outline-secondary" data-validation-action="na">N/A</button>
              <button class="btn btn-danger" data-validation-action="fail">Fail</button>
              <button class="btn btn-success" data-validation-action="pass">Confirm Pass</button>
              <button class="btn btn-primary" data-validation-action="next">Next</button>
            </div>
          </div>
        </div>
      </div>
      <div class="col-xl-4">
        <div class="dash-card mb-3"><div class="card-header">Certification progress</div><div class="card-body">
          <div class="progress mb-2" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:${progress}%">${progress}%</div></div>
          <div class="d-flex gap-2 small"><span class="text-success">${summary.pass} pass</span><span class="text-danger">${summary.fail} fail</span><span class="text-muted">${summary.pending} pending</span></div>
          <div class="mt-3">${renderQueue()}</div>
        </div></div>
        <div class="dash-card"><div class="card-header">Session</div><div class="card-body">
          <label class="form-label small">Tester</label><input class="form-control form-control-sm mb-2" id="validation-tester" value="${escapeHtmlAttr(state.meta.tester || '')}">
          <label class="form-label small">Machine / location</label><input class="form-control form-control-sm mb-3" id="validation-location" value="${escapeHtmlAttr(state.meta.location || '')}">
          <div class="d-flex gap-2"><button class="btn btn-sm btn-outline-primary" data-validation-action="export">Export</button>${summary.pending ? '' : '<button class="btn btn-sm btn-success" data-validation-action="finish">Finish certification</button>'}</div>
        </div></div>
      </div>
    </div>`;
}

function renderLanding() {
  const cert = state.certificate;
  const certified = cert?.result === 'passed';
  return `<div class="row justify-content-center"><div class="col-xl-8">
    <div class="dash-card ${certified ? 'accent-green' : 'accent-orange'} mt-3">
      <div class="card-body p-4 text-center">
        <i class="bi ${certified ? 'bi-patch-check-fill text-success' : 'bi-tools text-warning'}" style="font-size:3rem"></i>
        <h1 class="h3 mt-2">${certified ? 'Machine certification complete' : cert?.result === 'failed' ? 'Certification completed with failures' : 'Machine not yet certified'}</h1>
        <p class="text-muted">${cert ? `${escapeHtml(cert.systemId || 'IDS')} · firmware ${escapeHtml(cert.softwareRev || '—')} · ${new Date(cert.completedAt).toLocaleString()}` : 'Run this workflow once during commissioning, and again after the machine is serviced, disassembled, rewired, or reassembled.'}</p>
        ${cert ? `<div class="d-flex justify-content-center gap-3 mb-3"><span class="text-success">${cert.summary.pass} passed</span><span class="text-danger">${cert.summary.fail} failed</span><span>${cert.summary.na} N/A</span></div>` : ''}
        <div class="d-flex justify-content-center gap-2 flex-wrap">
          <button class="btn btn-primary" data-validation-action="start">${cert ? 'Run certification again' : 'Start guided certification'}</button>
          <button class="btn btn-outline-warning" data-validation-action="service">Machine serviced / reassembled</button>
          ${cert ? '<button class="btn btn-outline-secondary" data-validation-action="export">Export certificate</button>' : ''}
        </div>
      </div>
    </div></div></div>`;
}

function renderQueue() {
  return [...new Set(TESTS.map(test => test.category))].map(category => {
    const group = TESTS.filter(test => test.category === category);
    const done = group.filter(test => state.results[test.id]?.result).length;
    const failed = group.some(test => state.results[test.id]?.result === 'fail');
    const active = group.includes(TESTS[state.currentIndex]);
    return `<div class="d-flex justify-content-between border-bottom py-2 ${active ? 'fw-semibold text-primary' : ''}"><span>${escapeHtml(category)}</span><span class="badge ${failed ? 'text-bg-danger' : done === group.length ? 'text-bg-success' : 'text-bg-secondary'}">${done}/${group.length}</span></div>`;
  }).join('');
}

function liveReadback(test) {
  if (!test.key) return '';
  const raw = state.lastSnapshot[test.key];
  const display = test.floatKey && raw !== undefined ? ` · ${formatFloatState(test.floatKey, raw)}` : '';
  return `<div class="small font-monospace mt-2">${escapeHtml(test.key)}: ${escapeHtml(raw ?? '—')}${escapeHtml(display)}</div>`;
}

function summarize() {
  const out = { pass: 0, fail: 0, na: 0, pending: 0 };
  for (const test of TESTS) out[state.results[test.id]?.result || 'pending']++;
  return out;
}

function showOperationTab() {
  try { bootstrap.Tab.getOrCreateInstance(document.getElementById('tab-operation')).show(); } catch (_) { /* stay in validation */ }
}

function downloadReport() {
  const payload = { schemaVersion: 2, exportedAt: new Date().toISOString(), ...state, tests: TESTS, summary: summarize() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = `ids-certification-${safeFile(state.systemId || 'machine')}-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url);
}

function recordTimeline(kind, key, value, at = new Date().toISOString()) {
  if (state.status !== 'running') return;
  state.timeline.push({ at, kind, key, value: value ?? null });
  if (state.timeline.length > 1500) state.timeline.splice(0, state.timeline.length - 1500);
}

function pickSnapshot(data) {
  const keys = new Set(TESTS.map(test => test.key).filter(Boolean));
  keys.add('SystemID'); keys.add('SoftwareRev'); keys.add('AlarmStatus'); keys.add('ErrorCode_STATE');
  return Object.fromEntries([...keys].filter(key => data[key] !== undefined).map(key => [key, data[key]]));
}

function createState() {
  return {
    status: 'idle', startedAt: null, currentIndex: 0, systemId: null, softwareRev: null,
    meta: { tester: '', location: '' }, results: {}, analysis: {}, observed: {}, samples: {},
    telemetry: { frames: 0, firstAt: null, lastAt: null },
    lifecycle: { alarmActive: false, alarmRecovered: false, disconnectRecovered: false, connections: [] },
    lastSnapshot: {}, timeline: [], certificate: null, revalidationReason: null
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (parsed?.status && parsed?.lifecycle && parsed?.telemetry) return { ...createState(), ...parsed };
  } catch (_) { /* clean state */ }
  return createState();
}
function saveState() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* in-memory fallback */ } }

function analysisBadge(status) { return status === 'pass' ? 'text-bg-success' : status === 'confirm' ? 'text-bg-warning' : status === 'fail' ? 'text-bg-danger' : 'text-bg-secondary'; }
function analysisLabel(status) { return status === 'pass' ? 'AUTO PASS' : status === 'confirm' ? 'READY TO CONFIRM' : status === 'fail' ? 'OUT OF RANGE' : status === 'manual' ? 'MANUAL' : 'COLLECTING'; }
function yesNo(value) { return value ? 'yes' : 'no'; }
function fmt(value) { return Number(value).toFixed(2); }
function safeFile(value) { return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'machine'; }
function escapeHtml(value) { const div = document.createElement('div'); div.textContent = String(value ?? ''); return div.innerHTML; }
function escapeHtmlAttr(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
