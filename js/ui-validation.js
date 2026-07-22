/* ===== ui-validation.js — One-time guided commissioning workflow ===== */

import store from './state.js';
import { FLOATS, formatFloatState } from './float-state.js';
import { send } from './serial.js';
import {
  binaryMatches, hasActiveAlarm, modeCommand, numericMatches, safeShutdownCommands,
  selectedCircuitTests, setpointCommand, vacuumResponse
} from './commissioning-automation.js';

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
let automation = createAutomationState();

export function initValidationTab() {
  const panel = document.getElementById('panel-validation');
  if (!panel) return;
  panel.innerHTML = buildShell();
  bindEvents(panel);
  store.on('data', data => observeData(panel, data));
  store.on('connection', connection => {
    if (automation.status === 'running' && connection !== 'CONNECTED') stopAutomation('Controller disconnected');
    observeConnection(panel, connection);
  });
  store.on('command-sent', command => recordTimeline('command', 'outbound', command));
  store.on('error', payload => recordTimeline('alarm', 'AlarmStatus', payload?.raw));
  render(panel);
  renderTimer = setInterval(() => {
    if (state.status === 'running') analyzeAll();
    render(panel);
  }, 1000);
  window.addEventListener('beforeunload', () => {
    clearInterval(renderTimer);
    if (automation.status === 'running') stopAutomation('Page closed');
  }, { once: true });
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
    const commissioningAction = event.target.closest('[data-commissioning-action]')?.dataset.commissioningAction;
    if (commissioningAction === 'run') return startAutomation(panel);
    if (commissioningAction === 'stop') return stopAutomation('Stopped by operator').finally(() => render(panel));
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
    const option = event.target.dataset.commissioningOption;
    if (option) {
      if (event.target.type === 'checkbox') automation.config[option] = event.target.checked;
      else automation.config[option] = Number(event.target.value);
      render(panel);
      return;
    }
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
  if (automation.status === 'running' && hasActiveAlarm(data)) {
    stopAutomation(`Firmware alarm became active (${data.AlarmStatus ?? data.ErrorCode_STATE})`);
  }
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

function createAutomationState() {
  return {
    status: 'idle', abort: false, current: '', log: [],
    config: {
      flush: true, drain: true, bypass: true, vacuum: false,
      vacuumSetpoint: 28, flowSetpoint: 50, minimumVacuumChange: 1, dwellSeconds: 4,
      plumbingReady: false, estopReady: false, fluidReady: false, permission: false
    }
  };
}

function automationReady() {
  const c = automation.config;
  const alarmKnown = store.data.AlarmStatus !== undefined || store.data.ErrorCode_STATE !== undefined;
  const numbersValid = inRange(c.dwellSeconds, 2, 30) && (!c.vacuum
    || (inRange(c.vacuumSetpoint, 0, 100) && inRange(c.flowSetpoint, 0, 100) && inRange(c.minimumVacuumChange, 0, 500)));
  return store.connection === 'CONNECTED' && alarmKnown && !store.replayActive && !hasActiveAlarm(store.data) && numbersValid
    && c.plumbingReady && c.estopReady && c.fluidReady && c.permission
    && (selectedCircuitTests(c).length > 0 || c.vacuum);
}

async function startAutomation(panel) {
  if (automation.status === 'running' || !automationReady()) return;
  const selected = selectedCircuitTests(automation.config).map(test => test.label);
  if (automation.config.vacuum) selected.push('Run / vacuum response');
  if (!window.confirm(`This will command the controller and physically actuate: ${selected.join(', ')}. Stay at the machine with the emergency stop accessible. Continue?`)) return;
  automation.status = 'running'; automation.abort = false; automation.log = [];
  automationLog('info', 'Automation armed by local operator.'); render(panel);
  try {
    automation.current = 'Establishing safe baseline';
    await safeShutdown();
    await waitForReadback(data => binaryMatches(data, ['Run_MODE', 'Purge_MODE', 'Flush_MODE', 'Drain_MODE', 'Bypass_MODE'], false), 8000, 'all operating modes OFF');
    for (const test of selectedCircuitTests(automation.config)) await runCircuitTest(test, panel);
    if (automation.config.vacuum) await runVacuumTest(panel);
    automation.status = 'complete'; automation.current = '';
    automationLog('success', 'Electronic commissioning sequence passed. Complete the physical confirmations below.');
  } catch (error) {
    automation.status = automation.abort ? 'stopped' : 'failed';
    automationLog(automation.abort ? 'warning' : 'danger', error.message);
  } finally {
    await safeShutdown(); automation.current = ''; render(panel);
  }
}

async function runCircuitTest(test, panel) {
  assertAutomationSafe(); automation.current = `${test.label}: commanding ON`;
  automationLog('info', `${test.label}: ON command sent.`); render(panel);
  await sendRequired(modeCommand(test.mode, true));
  await waitForReadback(data => binaryMatches(data, [test.mode, ...test.outputs], true), 10000, `${test.mode} and ${test.outputs.join(', ')} ON`);
  automationLog('success', `${test.label}: ON readbacks confirmed.`);
  await interruptibleDelay(automation.config.dwellSeconds * 1000);
  automation.current = `${test.label}: commanding OFF`; render(panel);
  await sendRequired(modeCommand(test.mode, false));
  await waitForReadback(data => binaryMatches(data, [test.mode, ...test.outputs], false), 10000, `${test.mode} and ${test.outputs.join(', ')} OFF`);
  automationLog('success', `${test.label}: OFF readbacks confirmed.`);
}

async function runVacuumTest(panel) {
  assertAutomationSafe();
  const c = automation.config; const originalVacuum = store.data.Vacuum_SETPOINT; const originalFlow = store.data.Flow_SETPOINT;
  const baseline = Number(store.data.Vacuum_STATE);
  if (!Number.isFinite(baseline)) throw new Error('Vacuum response test cannot start: Vacuum_STATE is unavailable.');
  automation.current = 'Run / vacuum response'; render(panel);
  automationLog('info', `Applying raw setpoints: vacuum ${c.vacuumSetpoint}%, flow ${c.flowSetpoint}%.`);
  try {
    await sendRequired(setpointCommand('Vacuum_SETPOINT', c.vacuumSetpoint));
    await sendRequired(setpointCommand('Flow_SETPOINT', c.flowSetpoint));
    await waitForReadback(data => numericMatches(data.Vacuum_SETPOINT, c.vacuumSetpoint) && numericMatches(data.Flow_SETPOINT, c.flowSetpoint), 8000, 'vacuum and flow setpoint echoes');
    await sendRequired(modeCommand('Run_MODE', true));
    await waitForReadback(data => binaryMatches(data, ['Run_MODE', 'VacuumPump_STATE'], true), 10000, 'Run mode and vacuum pump ON');
    await interruptibleDelay(c.dwellSeconds * 1000);
    const result = vacuumResponse(baseline, store.data.Vacuum_STATE, c.minimumVacuumChange);
    if (!result.pass) throw new Error(`Vacuum response was ${formatNumber(result.delta)}; required at least ${c.minimumVacuumChange}.`);
    automationLog('success', `Vacuum changed by ${formatNumber(result.delta)} (minimum ${c.minimumVacuumChange}).`);
  } finally {
    await send(modeCommand('Run_MODE', false));
    if (Number.isFinite(Number(originalVacuum))) await send(setpointCommand('Vacuum_SETPOINT', originalVacuum));
    if (Number.isFinite(Number(originalFlow))) await send(setpointCommand('Flow_SETPOINT', originalFlow));
  }
}

async function waitForReadback(predicate, timeoutMs, description) {
  const started = Date.now(); let consecutive = 0;
  while (Date.now() - started < timeoutMs) {
    assertAutomationSafe(); consecutive = predicate(store.data) ? consecutive + 1 : 0;
    if (consecutive >= 2) return;
    await interruptibleDelay(250);
  }
  throw new Error(`Timed out waiting for ${description}. Last readback was saved in the session report.`);
}

function assertAutomationSafe() {
  if (automation.abort) throw new Error('Automation stopped; all operating modes were commanded OFF.');
  if (store.connection !== 'CONNECTED') throw new Error('Controller disconnected; shutdown commands may not have reached the hardware. Verify locally.');
  if (hasActiveAlarm(store.data)) throw new Error(`Firmware alarm became active (${store.data.AlarmStatus ?? store.data.ErrorCode_STATE}); sequence stopped.`);
}

async function sendRequired(command) {
  assertAutomationSafe();
  if (!await send(command)) throw new Error(`Could not send controller command ${command}.`);
}

async function stopAutomation(reason) {
  if (automation.status !== 'running') return;
  automation.abort = true; automationLog('warning', reason); await safeShutdown();
}

async function safeShutdown() {
  for (const command of safeShutdownCommands()) await send(command);
  automationLog('info', 'Safe baseline requested: all operating modes OFF.');
}

function interruptibleDelay(ms) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (automation.abort) { clearInterval(timer); reject(new Error('Automation stopped by operator.')); }
      else if (Date.now() - started >= ms) { clearInterval(timer); resolve(); }
    }, 100);
  });
}

function automationLog(level, message) {
  automation.log.push({ at: new Date().toISOString(), level, message });
  if (automation.log.length > 30) automation.log.shift();
  recordTimeline('commissioning', level, message);
}

function renderAutomation() {
  const c = automation.config; const running = automation.status === 'running';
  const connected = store.connection === 'CONNECTED';
  const alarmKnown = store.data.AlarmStatus !== undefined || store.data.ErrorCode_STATE !== undefined;
  const alarmClear = alarmKnown && !hasActiveAlarm(store.data);
  const statusClass = automation.status === 'complete' ? 'text-bg-success' : automation.status === 'failed' ? 'text-bg-danger' : running ? 'text-bg-primary' : automation.status === 'stopped' ? 'text-bg-warning' : 'text-bg-secondary';
  return `<div class="dash-card accent-orange mb-3">
    <div class="card-header d-flex justify-content-between align-items-center"><span><i class="bi bi-cpu me-1"></i>Automated electronic checks</span><span class="badge ${statusClass}">${escapeHtml(automation.status.toUpperCase())}</span></div>
    <div class="card-body">
      <p class="small text-muted">The runner sends one command at a time, requires two matching live readbacks, stops on any firmware alarm or disconnect, and commands every mode OFF at the beginning and end. It does not certify hoses, flow direction, leaks, or actual mechanical movement.</p>
      <div class="row g-3"><div class="col-lg-5"><div class="fw-semibold mb-2">Select checks</div>
        ${automationCheck('flush', 'Flush pump + valve', c.flush, running)}${automationCheck('drain', 'Drain pump + valve', c.drain, running)}${automationCheck('bypass', 'Bypass valve', c.bypass, running)}${automationCheck('vacuum', 'Run + vacuum response (optional)', c.vacuum, running)}
        <div class="row g-2 mt-1"><div class="col-4"><label class="form-label small">Dwell (s)</label><input type="number" min="2" max="30" step="1" class="form-control form-control-sm" data-commissioning-option="dwellSeconds" value="${c.dwellSeconds}" ${running ? 'disabled' : ''}></div>
        ${c.vacuum ? `<div class="col-4"><label class="form-label small">Vacuum (%)</label><input type="number" min="0" max="100" class="form-control form-control-sm" data-commissioning-option="vacuumSetpoint" value="${c.vacuumSetpoint}" ${running ? 'disabled' : ''}></div><div class="col-4"><label class="form-label small">Flow (%)</label><input type="number" min="0" max="100" class="form-control form-control-sm" data-commissioning-option="flowSetpoint" value="${c.flowSetpoint}" ${running ? 'disabled' : ''}></div><div class="col-6"><label class="form-label small">Min vacuum change</label><input type="number" min="0" max="500" step="0.1" class="form-control form-control-sm" data-commissioning-option="minimumVacuumChange" value="${c.minimumVacuumChange}" ${running ? 'disabled' : ''}></div>` : ''}</div>
      </div><div class="col-lg-7"><div class="fw-semibold mb-2">Local operator safety gate</div>
        ${automationCheck('plumbingReady', 'Plumbing is complete; hoses are secured and drains are safely routed.', c.plumbingReady, running)}${automationCheck('fluidReady', 'Correct fluid is available; selected pumps will not run dry.', c.fluidReady, running)}${automationCheck('estopReady', 'I am at the machine with the emergency stop accessible.', c.estopReady, running)}${automationCheck('permission', 'I authorize this browser to actuate the selected hardware now.', c.permission, running)}
        <div class="small mt-2"><span class="${connected ? 'text-success' : 'text-danger'}">${connected ? '● Controller connected' : '● Controller disconnected'}</span> · <span class="${alarmClear ? 'text-success' : 'text-danger'}">${!alarmKnown ? 'waiting for alarm-status telemetry' : alarmClear ? 'alarm clear' : 'active firmware alarm'}</span></div>
        <div class="d-flex gap-2 mt-3"><button class="btn btn-warning" data-commissioning-action="run" ${automationReady() && !running ? '' : 'disabled'}><i class="bi bi-play-fill me-1"></i>Run selected checks</button><button class="btn btn-danger" data-commissioning-action="stop" ${running ? '' : 'disabled'}><i class="bi bi-stop-fill me-1"></i>Stop and command all OFF</button></div>
      </div></div>
      ${automation.current ? `<div class="alert alert-primary py-2 mt-3 mb-2"><span class="spinner-border spinner-border-sm me-2"></span>${escapeHtml(automation.current)}</div>` : ''}
      ${automation.log.length ? `<div class="commissioning-log mt-3">${automation.log.slice(-8).reverse().map(item => `<div class="small border-top py-1 text-${item.level}"><span class="text-muted me-2">${new Date(item.at).toLocaleTimeString()}</span>${escapeHtml(item.message)}</div>`).join('')}</div>` : ''}
    </div></div>`;
}

function automationCheck(key, label, checked, disabled) {
  return `<div class="form-check mb-2"><input class="form-check-input" type="checkbox" data-commissioning-option="${key}" id="commission-${key}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><label class="form-check-label small" for="commission-${key}">${escapeHtml(label)}</label></div>`;
}

function formatNumber(value) { return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : 'unavailable'; }
function inRange(value, min, max) { const numeric = Number(value); return Number.isFinite(numeric) && numeric >= min && numeric <= max; }

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
      automated tests can actuate selected pumps and valves only after the local operator clears every safety gate. Controller readback never proves physical safety: follow lab SOP, keep the emergency stop accessible, and personally confirm fluid routing and component movement.</div>
    ${renderAutomation()}
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
