/* ===== ui-validation.js — One-time guided commissioning workflow ===== */

import store from './state.js';
import { FLOATS, formatFloatState, getFloatDisplayState } from './float-state.js';
import { send } from './serial.js';
import {
  binaryMatches, hasActiveAlarm, modeCommand, numericMatches, safeShutdownCommands,
  CIRCUIT_TESTS, setpointCommand, vacuumResponse
} from './commissioning-automation.js';
import { sendRemoteTestAlert } from './notifications.js';
import { formatCountdown } from './mode-control.js';
import { shouldSuppressHeaterError } from './heater-visibility.js';

// A firmware alarm that is being suppressed (attributable to a heater channel the operator
// marked not-installed) must not block commissioning — mirror the Operation error-card logic.
function alarmIsBlocking(data = store.data) {
  if (!hasActiveAlarm(data)) return false;
  const raw = String(data?.AlarmStatus ?? data?.ErrorCode_STATE ?? '');
  return !shouldSuppressHeaterError('', raw);
}

const STORAGE_KEY = 'ids-lab-certification-v2';
const OBSERVATION_SECONDS = 10;

const TESTS = [
  presence('identity-system', 'Connection', 'System identity', 'Connect the controller. SystemID is captured automatically.', 'SystemID'),
  presence('identity-firmware', 'Connection', 'Firmware revision', 'Firmware revision is captured automatically.', 'SoftwareRev'),
  { id: 'telemetry-stream', category: 'Connection', label: 'Stable telemetry', instruction: `Remain connected for ${OBSERVATION_SECONDS} seconds while the analyzer checks continuity.`, kind: 'telemetry', auto: true },
  ...FLOATS.map(item => binary(
    `float-${item.key}`, 'Floats', item.label,
    `Floats trigger automatically during operation, and overflow floats should never trip in normal use — do not force them. Confirm the displayed ${item.label} state matches the physical switch, then mark this check (or Skip it).`,
    item.key, true, item.key
  )),
  ...[
    ['Run_MODE', 'Run / Stop'], ['Purge_MODE', 'Purge'], ['Flush_MODE', 'Flush'],
    ['Drain_MODE', 'Drain']
  ].map(([key, label]) => binary(`mode-${key}`, 'Modes', label,
    key === 'Purge_MODE'
      ? 'Use the Operation tab to exercise Purge ON and OFF. The analyzer verifies both controller readbacks; confirm the machine behaved correctly.'
      : `Use the guided automated ${label} test below. It captures live mode and component readbacks, then asks for one physical confirmation.`, key, true)),
  ...[
    ['InputPump_STATE', 'Input pump'], ['RecirculationPump_STATE', 'Recirculation pump'],
    ['DrainPump_STATE', 'Drain pump'], ['BulkSupplyPump_STATE', 'Bulk supply pump'],
    ['VacuumPump_STATE', 'Vacuum pump'], ['flushPump_STATE', 'Flush pump'],
    ['ManifoldValve1_STATE', 'Manifold valve 1'], ['ManifoldValve2_STATE', 'Manifold valve 2'],
    ['DrainValve_STATE', 'Drain valve'], ['BulkSupplyValve_STATE', 'Bulk supply valve'],
    ['flushValve_STATE', 'Flush valve']
  ].map(([key, label]) => binary(`actuator-${key}`, 'Actuators', label,
    `Exercise the related mode from Operation. The analyzer records OFF/ON readback; visually or audibly confirm ${label} physically actuates.`, key, true)),
  sensor('sensor-fluid-temp', 'Fluid temperature', 'FluidTemperature_STATE', -10, 100),
  sensor('sensor-main-temp', 'Main heater temperature', 'MainHeaterTemperature_STATE', -40, 250),
  sensor('sensor-aux-temp', 'Aux heater temperature', 'AUXHeaterTemperature_STATE', -40, 250),
  sensor('sensor-vacuum', 'Vacuum response', 'Vacuum_STATE', -500, 500),
  sensor('sensor-pressure', 'Pressure response', 'Pressure_STATE', -10, 200),
  delivery('alert-weir', 'Weir OVF notification', 'The guided test verifies the configured Weir overflow delivery route without changing the physical float.'),
  delivery('alert-supply', 'Supply OVF notification', 'The guided test verifies the configured Supply overflow delivery route without changing the physical float.'),
  delivery('alert-alarm', 'Firmware alarm notification', 'The guided test verifies firmware-alarm delivery without creating a real controller fault.'),
  delivery('alert-disconnect', 'Unexpected disconnect notification', 'The guided test verifies disconnect-alert delivery without unplugging USB.'),
  delivery('alert-stale', 'Stale telemetry notification', 'The guided test verifies stale-data delivery without interrupting controller telemetry.')
];

const AUTOMATED_TESTS = {
  'mode-Run_MODE': {
    key: 'vacuum', label: 'Run / vacuum response', chartType: 'vacuum',
    evidenceKeys: ['Run_MODE', 'VacuumPump_STATE', 'Vacuum_STATE'],
    linkedIds: ['mode-Run_MODE', 'actuator-VacuumPump_STATE', 'sensor-vacuum']
  },
  'mode-Flush_MODE': {
    key: 'flush', label: 'Flush circuit', chartType: 'binary',
    evidenceKeys: ['Flush_MODE', 'flushPump_STATE', 'flushValve_STATE'],
    linkedIds: ['mode-Flush_MODE', 'actuator-flushPump_STATE', 'actuator-flushValve_STATE']
  },
  'mode-Drain_MODE': {
    key: 'drain', label: 'Drain circuit', chartType: 'binary',
    evidenceKeys: ['Drain_MODE', 'DrainPump_STATE', 'ManifoldValve1_STATE', 'ManifoldValve2_STATE'],
    linkedIds: ['mode-Drain_MODE', 'actuator-DrainPump_STATE', 'actuator-ManifoldValve1_STATE', 'actuator-ManifoldValve2_STATE']
  }
};
const ALERT_TEST_KEYS = {
  'alert-weir': 'weirOverflow', 'alert-supply': 'supplyOverflow',
  'alert-alarm': 'firmwareAlarm', 'alert-disconnect': 'controllerConnection',
  'alert-stale': 'staleData'
};
const AUTOMATION_PHASES = ['baseline', 'activate', 'observe', 'deactivate', 'analyze'];
const EVIDENCE_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ec4899'];
const FLOAT_KEYS = new Set(FLOATS.map(item => item.key));

let state = loadState();
let renderTimer = null;
let automation = createAutomationState();
let evidenceChart = null;
let evidenceChartTestId = null;
let lastRenderSig = null;
const liveSeries = new Map();

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
    tick(panel);
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
function delivery(id, label, instruction) {
  return { id, category: 'Alerts', label, instruction, kind: 'delivery', physical: false };
}

function buildShell() {
  return `<div id="validation-root"></div>`;
}

function bindEvents(panel) {
  panel.addEventListener('click', event => {
    const commissioningAction = event.target.closest('[data-commissioning-action]')?.dataset.commissioningAction;
    if (commissioningAction === 'run') return startAutomation(panel, TESTS[state.currentIndex]);
    if (commissioningAction === 'stop') return stopAutomation('Stopped by operator').finally(() => render(panel));
    if (commissioningAction === 'confirm') return confirmAutomationResult(panel);
    if (commissioningAction === 'test-alert') return testCurrentAlert(panel, event.target.closest('[data-commissioning-action]'));
    const action = event.target.closest('[data-validation-action]')?.dataset.validationAction;
    if (!action) return;
    if (action === 'start') return startSession(panel, false);
    if (action === 'restart') return restartSession(panel);
    if (action === 'service') return markServiced(panel);
    if (action === 'export') return downloadReport();
    if (action === 'operation') return showOperationTab();
    if (action === 'previous') navigateTo(Math.max(0, state.currentIndex - 1));
    if (action === 'next') navigateTo(Math.min(TESTS.length - 1, state.currentIndex + 1));
    if (action === 'pass' || action === 'fail' || action === 'na') setResult(TESTS[state.currentIndex], action, 'operator');
    if (action === 'skip') setResult(TESTS[state.currentIndex], 'na', 'operator', 'Skipped by operator');
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
  panel.addEventListener('input', event => {
    const option = event.target.dataset.commissioningOption;
    if (option && event.target.type !== 'checkbox') automation.config[option] = Number(event.target.value);
    if (event.target.id === 'validation-tester') state.meta.tester = event.target.value.slice(0, 80);
    if (event.target.id === 'validation-location') state.meta.location = event.target.value.slice(0, 80);
    if (event.target.id === 'validation-note') {
      const test = TESTS[state.currentIndex];
      state.results[test.id] = { ...(state.results[test.id] || {}), note: event.target.value.slice(0, 500) };
    }
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
  automation = createAutomationState();
  liveSeries.clear();
  if (store.connection === 'CONNECTED') observeConnection(panel, 'CONNECTED');
  render(panel);
  saveState();
}

// Always-available escape hatch: fully reset commissioning to the landing page, even if
// automation is running or stuck (every other control is disabled while automationLocked).
function restartSession(panel) {
  if (!window.confirm('Restart commissioning from the beginning? This stops any running automation and discards the current session.')) return;
  automation.abort = true;              // signal any in-flight automation loop to bail out
  safeShutdown().catch(() => {});        // best-effort: command all modes OFF, never blocks the reset
  automation = createAutomationState();  // release the UI lock immediately, even if automation was stuck
  const previousMeta = state.meta || {};
  state = createState();                 // return to the landing page (status 'idle')
  state.meta = previousMeta;             // keep tester / machine-location entries
  liveSeries.clear();
  saveState();                           // overwrite any stuck persisted 'running' state
  render(panel);
}

function markServiced(panel) {
  if (!window.confirm('Mark the machine as serviced or reassembled? This invalidates the prior certification and starts a fresh validation.')) return;
  const previousMeta = state.meta || {};
  state = createState();
  state.status = 'running';
  state.revalidationReason = 'Machine serviced or reassembled';
  state.meta = previousMeta;
  state.startedAt = new Date().toISOString();
  automation = createAutomationState();
  liveSeries.clear();
  render(panel);
  saveState();
}

function observeData(panel, data) {
  if (automation.status === 'running' && alarmIsBlocking(data)) {
    stopAutomation(`Firmware alarm became active (${data.AlarmStatus ?? data.ErrorCode_STATE})`);
  }
  if (state.status !== 'running') return;
  const now = new Date().toISOString();
  captureLiveData(data, now);
  if (automation.status === 'running') {
    automation.samples.push({ at: now, values: { ...data } });
    if (automation.samples.length > 180) automation.samples.shift();
  }
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
  tick(panel);
}

// Periodic refresh: only rebuild the whole panel when its structure changes; otherwise patch the
// handful of live-updating regions in place. Full innerHTML rebuilds every second caused the
// commissioning page (and its evidence chart) to visibly glitch.
function tick(panel) {
  const root = panel.querySelector('#validation-root');
  if (!root) return;
  const sig = computeRenderSignature();
  if (sig !== lastRenderSig) { render(panel); return; }
  if (state.status === 'running') patchLiveRegions();
}

function computeRenderSignature() {
  if (state.status !== 'running') return `status:${state.status}:${state.certificate ? 'cert' : 'none'}:${state.revalidationReason || ''}`;
  const current = TESTS[state.currentIndex] || TESTS[0];
  const c = automation.config || {};
  return JSON.stringify({
    idx: state.currentIndex,
    testId: current.id,
    aStatus: state.analysis[current.id]?.status || '',
    autoStatus: automation.status,
    autoTestId: automation.testId,
    autoPhase: automation.phase,
    hasCountdown: !!(automation.status === 'running' && automation.deadlineAt),
    conn: store.connection,
    alarmBlock: alarmIsBlocking(store.data),
    pending: summarize().pending,
    results: TESTS.map(t => state.results[t.id]?.result || '').join(','),
    gate: [c.plumbingReady, c.fluidReady, c.estopReady, c.permission, c.dwellSeconds, c.vacuumSetpoint, c.flowSetpoint, c.minimumVacuumChange].join(','),
    delivery: Object.keys(state.deliveryTests || {}).map(k => `${k}:${state.deliveryTests[k]?.status}`).join(','),
    resultMsg: automation.resultMessage || ''
  });
}

// In-place update of only the values that change tick-to-tick (analysis text, live readbacks,
// countdown, evidence chart). Everything else is covered by the render signature above.
function patchLiveRegions() {
  const current = TESTS[state.currentIndex] || TESTS[0];
  const analysis = state.analysis[current.id] || analyze(current);
  const msg = document.getElementById('cx-analysis-msg');
  if (msg && msg.textContent !== analysis.message) msg.textContent = analysis.message;
  const readback = document.getElementById('cx-live-readback');
  if (readback) readback.innerHTML = liveReadback(current);
  const countdown = document.getElementById('cx-countdown');
  if (countdown && automation.status === 'running' && automation.deadlineAt) {
    countdown.textContent = `${automation.countdownLabel} ${formatCountdown(automation.deadlineAt - Date.now())}`;
  }
  drawEvidenceChart(current);
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
  if (AUTOMATED_TESTS[test.id] && automation.testId === test.id) {
    if (automation.status === 'running') return { status: 'waiting', message: automation.current || 'Automated test is running.' };
    if (automation.status === 'complete') return { status: 'confirm', message: `${automation.resultMessage} Confirm the physical behavior below.` };
    if (automation.status === 'failed' || automation.status === 'stopped') return { status: 'fail', message: automation.resultMessage || 'Automated test did not complete.' };
  }
  const delivery = state.deliveryTests?.[test.id];
  if (delivery?.status === 'running') return { status: 'waiting', message: delivery.message };
  if (delivery?.status === 'fail') return { status: 'fail', message: `Delivery test failed: ${delivery.message}` };
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
    if (test.floatKey || FLOAT_KEYS.has(test.key)) {
      // Floats actuate during operation and overflow floats should never be forced, so we do not
      // require both OFF and ON readbacks. Confirm the current displayed state once telemetry is seen.
      return seen.length
        ? { status: 'confirm', message: `Float readback present (${formatFloatState(test.key, store.data?.[test.key])}). Confirm it matches the physical switch, or Skip.` }
        : { status: 'waiting', message: 'Waiting for a float readback from the controller.' };
    }
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
    status: 'idle', abort: false, current: '', phase: 'idle', testId: null,
    log: [], samples: [], resultMessage: '', deadlineAt: 0, countdownLabel: '',
    config: {
      vacuumSetpoint: 28, flowSetpoint: 50, minimumVacuumChange: 1, dwellSeconds: 4,
      plumbingReady: false, estopReady: false, fluidReady: false, permission: false
    }
  };
}

function automationReady(test) {
  const definition = AUTOMATED_TESTS[test?.id];
  if (!definition) return false;
  const c = automation.config;
  const alarmKnown = store.data.AlarmStatus !== undefined || store.data.ErrorCode_STATE !== undefined;
  const numbersValid = inRange(c.dwellSeconds, 2, 30) && (definition.key !== 'vacuum'
    || (inRange(c.vacuumSetpoint, 0, 100) && inRange(c.flowSetpoint, 0, 100) && inRange(c.minimumVacuumChange, 0, 500)));
  return store.connection === 'CONNECTED' && alarmKnown && !store.replayActive && !alarmIsBlocking(store.data) && numbersValid
    && c.plumbingReady && c.estopReady && c.fluidReady && c.permission;
}

async function startAutomation(panel, test) {
  const definition = AUTOMATED_TESTS[test?.id];
  if (!definition || automation.status === 'running' || !automationReady(test)) return;
  if (!window.confirm(`This test will physically actuate ${definition.label}. Stay at the machine with the emergency stop accessible. Continue?`)) return;
  automation.status = 'running'; automation.abort = false; automation.log = []; automation.samples = [];
  automation.testId = test.id; automation.resultMessage = ''; automation.phase = 'baseline';
  automationLog('info', `${definition.label} armed by local operator.`); render(panel);
  try {
    setAutomationPhase('baseline', 'Commanding every operating mode OFF', panel);
    await safeShutdown();
    await waitForReadback(data => binaryMatches(data, ['Run_MODE', 'Purge_MODE', 'Flush_MODE', 'Drain_MODE'], false), 8000, 'all operating modes OFF');
    if (definition.key === 'vacuum') await runVacuumTest(panel);
    else await runCircuitTest(CIRCUIT_TESTS[definition.key], panel);
    setAutomationPhase('analyze', 'Analyzing captured telemetry', panel);
    automation.status = 'complete'; automation.current = '';
    automation.resultMessage = `${definition.label} electronic checks passed.`;
    automationLog('success', `${automation.resultMessage} Confirm the observed physical behavior to complete linked checks.`);
  } catch (error) {
    automation.status = automation.abort ? 'stopped' : 'failed';
    automation.resultMessage = error.message;
    automationLog(automation.abort ? 'warning' : 'danger', error.message);
  } finally {
    await safeShutdown(); automation.current = ''; render(panel);
  }
}

async function runCircuitTest(test, panel) {
  assertAutomationSafe(); setAutomationPhase('activate', `${test.label}: commanding ON`, panel);
  automationLog('info', `${test.label}: ON command sent.`);
  await sendRequired(modeCommand(test.mode, true));
  setAutomationPhase('observe', `Waiting for ${test.outputs.join(' + ')}`, panel);
  if (test.mode === 'Flush_MODE') await waitForFlushCircuit(test);
  else await waitForReadback(data => binaryMatches(data, [test.mode, ...test.outputs], true), 10000, `${test.mode} and ${test.outputs.join(', ')} ON`);
  automationLog('success', `${test.label}: ON readbacks confirmed.`);
  await interruptibleDelay(automation.config.dwellSeconds * 1000, 'Dwell');
  setAutomationPhase('deactivate', `${test.label}: commanding OFF`, panel);
  await sendRequired(modeCommand(test.mode, false));
  await waitForReadback(data => binaryMatches(data, [test.mode, ...test.outputs], false), 10000, `${test.mode} and ${test.outputs.join(', ')} OFF`);
  automationLog('success', `${test.label}: OFF readbacks confirmed.`);
}

async function runVacuumTest(panel) {
  assertAutomationSafe();
  const c = automation.config; const originalVacuum = store.data.Vacuum_SETPOINT; const originalFlow = store.data.Flow_SETPOINT;
  const baseline = Number(store.data.Vacuum_STATE);
  if (!Number.isFinite(baseline)) throw new Error('Vacuum response test cannot start: Vacuum_STATE is unavailable.');
  setAutomationPhase('activate', 'Applying Run setpoints', panel);
  automationLog('info', `Applying raw setpoints: vacuum ${c.vacuumSetpoint}%, recirculation drive ${c.flowSetpoint}%.`);
  try {
    await sendRequired(setpointCommand('Vacuum_SETPOINT', c.vacuumSetpoint));
    await sendRequired(setpointCommand('Flow_SETPOINT', c.flowSetpoint));
    await waitForReadback(data => numericMatches(data.Vacuum_SETPOINT, c.vacuumSetpoint) && numericMatches(data.Flow_SETPOINT, c.flowSetpoint), 8000, 'vacuum and recirculation-drive setpoint echoes');
    await sendRequired(modeCommand('Run_MODE', true));
    setAutomationPhase('observe', 'Measuring vacuum response', panel);
    await waitForReadback(data => binaryMatches(data, ['Run_MODE', 'VacuumPump_STATE'], true), 10000, 'Run mode and vacuum pump ON');
    await interruptibleDelay(c.dwellSeconds * 1000, 'Vacuum response');
    const result = vacuumResponse(baseline, store.data.Vacuum_STATE, c.minimumVacuumChange);
    if (!result.pass) throw new Error(`Vacuum response was ${formatNumber(result.delta)}; required at least ${c.minimumVacuumChange}.`);
    automationLog('success', `Vacuum changed by ${formatNumber(result.delta)} (minimum ${c.minimumVacuumChange}).`);
  } finally {
    setAutomationPhase('deactivate', 'Stopping Run and restoring setpoints', panel);
    await send(modeCommand('Run_MODE', false));
    if (Number.isFinite(Number(originalVacuum))) await send(setpointCommand('Vacuum_SETPOINT', originalVacuum));
    if (Number.isFinite(Number(originalFlow))) await send(setpointCommand('Flow_SETPOINT', originalFlow));
  }
}

async function waitForReadback(predicate, timeoutMs, description) {
  const started = Date.now(); let consecutive = 0;
  automation.deadlineAt = started + timeoutMs; automation.countdownLabel = 'Readback';
  while (Date.now() - started < timeoutMs) {
    assertAutomationSafe(); consecutive = predicate(store.data) ? consecutive + 1 : 0;
    if (consecutive >= 2) { automation.deadlineAt = 0; return; }
    await interruptibleDelay(250);
  }
  automation.deadlineAt = 0;
  throw new Error(`Timed out waiting for ${description}. Last readback was saved in the session report.`);
}

async function waitForFlushCircuit(test) {
  const started = Date.now(); const initialSamples = automation.samples.length; let consecutive = 0;
  automation.deadlineAt = started + 10000; automation.countdownLabel = 'Flush acknowledgement';
  while (Date.now() - started < 10000) {
    assertAutomationSafe();
    consecutive = binaryMatches(store.data, [test.mode, ...test.outputs], true) ? consecutive + 1 : 0;
    if (consecutive >= 2) { automation.deadlineAt = 0; return; }
    const freshFrames = automation.samples.length - initialSamples;
    if (freshFrames >= 3 && Number(store.data.Flush_MODE) === 0) {
      automation.deadlineAt = 0;
      throw new Error('R17 Flush cleared before its outputs could be confirmed. This matches the known firmware timer-reset defect; the web UI did not retry or force hardware. Patch and rebuild the controller firmware before certifying Flush.');
    }
    await interruptibleDelay(250);
  }
  automation.deadlineAt = 0;
  throw new Error('Timed out waiting for the Flush mode, pump, and valve readbacks. The known R17 timer-reset defect may be present.');
}

function assertAutomationSafe() {
  if (automation.abort) throw new Error('Automation stopped; all operating modes were commanded OFF.');
  if (store.connection !== 'CONNECTED') throw new Error('Controller disconnected; shutdown commands may not have reached the hardware. Verify locally.');
  if (alarmIsBlocking(store.data)) throw new Error(`Firmware alarm became active (${store.data.AlarmStatus ?? store.data.ErrorCode_STATE}); sequence stopped.`);
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

function interruptibleDelay(ms, countdownLabel = '') {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const managesCountdown = Boolean(countdownLabel);
    if (managesCountdown) {
      automation.deadlineAt = started + ms;
      automation.countdownLabel = countdownLabel;
    }
    const timer = setInterval(() => {
      if (automation.abort) { clearInterval(timer); if (managesCountdown) automation.deadlineAt = 0; reject(new Error('Automation stopped by operator.')); }
      else if (Date.now() - started >= ms) { clearInterval(timer); if (managesCountdown) automation.deadlineAt = 0; resolve(); }
    }, 100);
  });
}

function automationLog(level, message) {
  automation.log.push({ at: new Date().toISOString(), level, message });
  if (automation.log.length > 30) automation.log.shift();
  recordTimeline('commissioning', level, message);
}

function setAutomationPhase(phase, current, panel) {
  automation.phase = phase; automation.current = current; automation.countdownLabel = phase === 'observe' ? 'Observe' : current; render(panel);
}

function confirmAutomationResult(panel) {
  const definition = AUTOMATED_TESTS[automation.testId];
  if (!definition || automation.status !== 'complete') return;
  const message = `${automation.resultMessage} Physical operation confirmed by the operator.`;
  for (const id of definition.linkedIds) {
    if (!TESTS.some(test => test.id === id)) continue;
    state.results[id] = { ...(state.results[id] || {}), result: 'pass', source: 'automated + operator', at: new Date().toISOString(), analysis: message };
  }
  automationLog('success', `Completed ${definition.linkedIds.length} linked checks.`);
  const next = TESTS.findIndex((test, index) => index > state.currentIndex && !state.results[test.id]?.result);
  if (next >= 0) navigateTo(next); else automation.status = 'idle';
  saveState(); render(panel);
}

async function testCurrentAlert(panel, button) {
  const test = TESTS[state.currentIndex]; const notificationKey = ALERT_TEST_KEYS[test?.id];
  if (!notificationKey || state.deliveryTests[test.id]?.status === 'running') return;
  state.deliveryTests[test.id] = { status: 'running', message: 'Sending through the configured relay…' };
  if (button) button.disabled = true;
  render(panel);
  try {
    const result = await sendRemoteTestAlert(null, notificationKey);
    const ntfy = result.deliveries?.ntfy || 'unknown'; const slack = result.deliveries?.slack || 'unknown';
    const delivered = ['sent', 'sent-direct'].includes(ntfy) && slack !== 'failed';
    const message = `ntfy: ${ntfy} · Slack: ${slack}`;
    state.deliveryTests[test.id] = { status: delivered ? 'pass' : 'fail', message, at: new Date().toISOString() };
    if (delivered) setResult(test, 'pass', 'automatic delivery test', message);
  } catch (error) {
    state.deliveryTests[test.id] = { status: 'fail', message: error.message, at: new Date().toISOString() };
  }
  saveState(); render(panel);
}

function renderIntegratedAutomation(test) {
  const definition = AUTOMATED_TESTS[test.id];
  if (!definition) return ALERT_TEST_KEYS[test.id] ? renderAlertTest(test) : ['binary', 'sensor'].includes(test.kind) ? renderEvidencePanel(test) : '';
  const c = automation.config; const running = automation.status === 'running';
  const isThisTest = automation.testId === test.id;
  const connected = store.connection === 'CONNECTED';
  const alarmKnown = store.data.AlarmStatus !== undefined || store.data.ErrorCode_STATE !== undefined;
  const alarmClear = alarmKnown && !alarmIsBlocking(store.data);
  const shownStatus = isThisTest ? automation.status : 'idle';
  return `<section class="commission-runner ${shownStatus}" aria-label="Integrated automated test">
    <div class="d-flex justify-content-between align-items-center mb-3"><div><div class="small text-uppercase text-muted">Guided automation</div><div class="h5 mb-0">${escapeHtml(definition.label)}</div></div><div class="d-flex align-items-center gap-2">${running && automation.deadlineAt ? `<span class="mini-countdown" id="cx-countdown"><i class="bi bi-clock"></i>${escapeHtml(automation.countdownLabel)} ${formatCountdown(automation.deadlineAt - Date.now())}</span>` : ''}<span class="commission-status ${shownStatus}"><i class="bi ${shownStatus === 'complete' ? 'bi-check-circle-fill' : shownStatus === 'failed' ? 'bi-x-circle-fill' : shownStatus === 'running' ? 'bi-activity' : 'bi-cpu'}"></i>${escapeHtml(shownStatus)}</span></div></div>
    ${renderPhaseRail(isThisTest ? automation.phase : 'idle')}
    <div class="row g-3 mt-1"><div class="col-lg-7">${renderEvidencePanel(test, definition)}</div>
      <div class="col-lg-5"><div class="commission-gate"><div class="fw-semibold mb-2">Operator safety gate</div>
        ${automationCheck('plumbingReady', 'Plumbing secured and drains safely routed.', c.plumbingReady, running)}${automationCheck('fluidReady', 'Correct fluid available; pumps will not run dry.', c.fluidReady, running)}${automationCheck('estopReady', 'I am at the machine with E-stop accessible.', c.estopReady, running)}${automationCheck('permission', 'I authorize this hardware test now.', c.permission, running)}
        <div class="row g-2 mt-1"><div class="col-5"><label class="form-label small">Dwell (s)</label><input type="number" min="2" max="30" class="form-control form-control-sm" data-commissioning-option="dwellSeconds" value="${c.dwellSeconds}" ${running ? 'disabled' : ''}></div>${definition.key === 'vacuum' ? `<div class="col-7"><label class="form-label small">Min vacuum change</label><input type="number" min="0" max="500" step="0.1" class="form-control form-control-sm" data-commissioning-option="minimumVacuumChange" value="${c.minimumVacuumChange}" ${running ? 'disabled' : ''}></div><div class="col-6"><label class="form-label small">Vacuum (%)</label><input type="number" min="0" max="100" class="form-control form-control-sm" data-commissioning-option="vacuumSetpoint" value="${c.vacuumSetpoint}" ${running ? 'disabled' : ''}></div><div class="col-6"><label class="form-label small">Recirc drive (%)</label><input type="number" min="0" max="100" class="form-control form-control-sm" data-commissioning-option="flowSetpoint" value="${c.flowSetpoint}" ${running ? 'disabled' : ''}></div>` : ''}</div>
        <div class="commission-interlocks mt-2"><span class="${connected ? 'ok' : 'bad'}">${connected ? 'Connected' : 'Disconnected'}</span><span class="${alarmClear ? 'ok' : 'bad'}">${!alarmKnown ? 'Awaiting alarm status' : alarmClear ? 'Alarm clear' : 'Alarm active'}</span></div>
        <div class="d-grid gap-2 mt-3">${isThisTest && shownStatus === 'complete' ? '<button class="btn btn-success commission-confirm" data-commissioning-action="confirm"><i class="bi bi-check2-circle me-1"></i>Confirm physical behavior & complete linked checks</button>' : `<button class="btn btn-warning" data-commissioning-action="run" ${automationReady(test) && !running ? '' : 'disabled'}><i class="bi bi-play-fill me-1"></i>Run this guided test</button>`}<button class="btn btn-outline-danger" data-commissioning-action="stop" ${running ? '' : 'disabled'}>Stop & command all OFF</button></div>
      </div></div></div>
    ${isThisTest && automation.resultMessage ? `<div class="commission-result ${shownStatus}"><i class="bi ${shownStatus === 'complete' ? 'bi-check-circle-fill' : 'bi-exclamation-triangle-fill'}"></i><span>${escapeHtml(automation.resultMessage)}</span></div>` : ''}
  </section>`;
}

function automationCheck(key, label, checked, disabled) {
  return `<div class="form-check mb-2"><input class="form-check-input" type="checkbox" data-commissioning-option="${key}" id="commission-${key}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><label class="form-check-label small" for="commission-${key}">${escapeHtml(label)}</label></div>`;
}

function renderPhaseRail(active) {
  const activeIndex = AUTOMATION_PHASES.indexOf(active);
  return `<div class="commission-phase-rail">${AUTOMATION_PHASES.map((phase, index) => {
    const stateClass = index < activeIndex ? 'done' : phase === active ? 'active' : '';
    return `<div class="commission-phase ${stateClass}"><span>${index < activeIndex ? '<i class="bi bi-check-lg"></i>' : index + 1}</span><small>${phase}</small></div>`;
  }).join('')}</div>`;
}

function renderAlertTest(test) {
  const delivery = state.deliveryTests[test.id]; const status = delivery?.status || 'idle';
  return `<section class="commission-alert-test ${status}"><div class="commission-alert-icon"><i class="bi bi-broadcast-pin"></i></div><div class="flex-grow-1"><div class="fw-semibold">Verify the real notification route</div><div class="small text-muted">Sends a labeled test through the same Cloudflare Worker, ntfy, and Slack path without changing live incident state.</div>${delivery ? `<div class="small mt-2 ${status === 'pass' ? 'text-success' : status === 'fail' ? 'text-danger' : 'text-primary'}">${escapeHtml(delivery.message)}</div>` : ''}</div><button class="btn btn-outline-primary" data-commissioning-action="test-alert" ${status === 'running' ? 'disabled' : ''}>${status === 'running' ? '<span class="spinner-border spinner-border-sm me-1"></span>Sending' : '<i class="bi bi-send me-1"></i>Test delivery'}</button></section>`;
}

function renderEvidencePanel(test, definition = null) {
  if (!definition && !test.key) return '';
  const keys = definition?.evidenceKeys || [test.key];
  return `<div class="commission-evidence"><div class="d-flex justify-content-between align-items-center mb-2"><div class="fw-semibold"><i class="bi bi-graph-up me-1"></i>Live evidence</div><span class="live-pill"><span></span>LIVE</span></div><div class="commission-readbacks">${keys.map((key, index) => `<span style="--series-color:${EVIDENCE_COLORS[index % EVIDENCE_COLORS.length]}"><i></i>${escapeHtml(humanizeEvidenceKey(key))}: <strong>${escapeHtml(evidenceValue(key))}</strong></span>`).join('')}</div><div class="commission-chart-wrap"><canvas id="commission-evidence-chart" aria-label="Live commissioning evidence chart"></canvas></div></div>`;
}

function navigateTo(index) {
  state.currentIndex = index;
  if (automation.status !== 'running' && automation.testId !== TESTS[index]?.id) {
    automation.status = 'idle'; automation.testId = null; automation.phase = 'idle'; automation.resultMessage = ''; automation.samples = [];
  }
}

function captureLiveData(data, at) {
  const keys = new Set(TESTS.map(test => test.key).filter(Boolean));
  for (const definition of Object.values(AUTOMATED_TESTS)) definition.evidenceKeys.forEach(key => keys.add(key));
  for (const key of keys) {
    const value = Number(FLOAT_KEYS.has(key) ? getFloatDisplayState(key, data[key]) : data[key]);
    if (!Number.isFinite(value)) continue;
    const series = liveSeries.get(key) || []; series.push({ at, value });
    if (series.length > 120) series.shift(); liveSeries.set(key, series);
  }
}

function drawEvidenceChart(test) {
  const canvas = document.getElementById('commission-evidence-chart');
  if (!canvas || !window.Chart) {
    if (evidenceChart) { evidenceChart.destroy(); evidenceChart = null; evidenceChartTestId = null; }
    return;
  }
  const definition = AUTOMATED_TESTS[test.id];
  const captured = definition && automation.testId === test.id && automation.samples.length;
  let labels = []; let datasets = []; let laneChart = false;
  if (captured) {
    const samples = automation.samples; const start = new Date(samples[0].at).getTime();
    labels = samples.map(sample => `${((new Date(sample.at).getTime() - start) / 1000).toFixed(1)}s`);
    if (definition.chartType === 'vacuum') {
      datasets = [{ label: 'Vacuum', data: samples.map(sample => numericOrNull(sample.values.Vacuum_STATE)), borderColor: EVIDENCE_COLORS[0], backgroundColor: 'rgba(59,130,246,.15)', fill: true, tension: 0.25, pointRadius: 0 }];
    } else {
      laneChart = true;
      datasets = definition.evidenceKeys.map((key, index) => ({ label: humanizeEvidenceKey(key), data: samples.map(sample => {
        const value = Number(sample.values[key]); return Number.isFinite(value) ? value + index * 1.5 : null;
      }), borderColor: EVIDENCE_COLORS[index], stepped: true, pointRadius: 0, borderWidth: 2.5 }));
    }
  } else {
    const samples = liveSeries.get(test.key) || []; const start = samples.length ? new Date(samples[0].at).getTime() : Date.now();
    labels = samples.map(sample => `${((new Date(sample.at).getTime() - start) / 1000).toFixed(0)}s`);
    datasets = [{ label: humanizeEvidenceKey(test.key), data: samples.map(sample => sample.value), borderColor: EVIDENCE_COLORS[0], backgroundColor: 'rgba(59,130,246,.12)', fill: test.kind === 'sensor', stepped: test.kind === 'binary', tension: test.kind === 'sensor' ? 0.25 : 0, pointRadius: 0 }];
  }
  if (evidenceChart && evidenceChart.canvas === canvas && evidenceChartTestId === test.id) {
    evidenceChart.data.labels = labels;
    evidenceChart.data.datasets = datasets;
    evidenceChart.update('none');
    return;
  }
  if (evidenceChart) { evidenceChart.destroy(); evidenceChart = null; }
  evidenceChartTestId = test.id;
  evidenceChart = new Chart(canvas, { type: 'line', data: { labels, datasets }, options: { responsive: true, maintainAspectRatio: false, animation: { duration: 350 }, interaction: { intersect: false, mode: 'index' }, plugins: { legend: { labels: { color: '#aeb6ca', usePointStyle: true, boxWidth: 8 } } }, scales: { x: { grid: { color: 'rgba(148,163,184,.08)' }, ticks: { color: '#7f899f', maxTicksLimit: 7 } }, y: { min: laneChart ? -0.25 : undefined, max: laneChart ? definition.evidenceKeys.length * 1.5 : undefined, grid: { color: 'rgba(148,163,184,.1)' }, ticks: { color: '#7f899f', display: !laneChart } } } } });
}

function humanizeEvidenceKey(key) { return String(key || '').replace(/_(STATE|MODE|SETPOINT)$/i, '').replaceAll('_', ' '); }
function numericOrNull(value) { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : null; }
function evidenceValue(key) {
  const value = store.data[key];
  if (value === undefined) return '—';
  return FLOAT_KEYS.has(key) ? `${formatFloatState(key, value)} (${getFloatDisplayState(key, value)})` : value;
}

function formatNumber(value) { return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : 'unavailable'; }
function inRange(value, min, max) { const numeric = Number(value); return Number.isFinite(numeric) && numeric >= min && numeric <= max; }

function render(panel) {
  const root = panel.querySelector('#validation-root');
  if (!root) return;
  const focused = root.contains(document.activeElement) && document.activeElement.id
    ? { id: document.activeElement.id, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }
    : null;
  if (state.status !== 'running') {
    root.innerHTML = renderLanding();
    lastRenderSig = computeRenderSignature();
    return;
  }
  analyzeAll();
  const current = TESTS[state.currentIndex] || TESTS[0];
  const analysis = state.analysis[current.id] || analyze(current);
  const result = state.results[current.id];
  const summary = summarize();
  const progress = Math.round(((TESTS.length - summary.pending) / TESTS.length) * 100);
  const automationLocked = automation.status === 'running';
  const guidedAutomation = !!AUTOMATED_TESTS[current.id];
  root.innerHTML = `
    <div class="alert alert-warning d-flex justify-content-between align-items-start gap-3">
      <div><strong><i class="bi bi-exclamation-triangle-fill me-1"></i>Commissioning mode:</strong>
      the guided workflow introduces automation only at the relevant test. Hardware actuation remains gated by the local operator, and controller readback never proves physical safety.</div>
      <button class="btn btn-sm btn-outline-danger flex-shrink-0" data-validation-action="restart"><i class="bi bi-arrow-counterclockwise me-1"></i>Start over</button>
    </div>
    <div class="row g-3">
      <div class="col-xl-8">
        <div class="dash-card accent-blue commission-test-card">
          <div class="card-header d-flex justify-content-between align-items-center"><span>Current test ${state.currentIndex + 1} of ${TESTS.length}</span><span class="badge ${analysisBadge(analysis.status)}" id="cx-analysis-badge">${analysisLabel(analysis.status)}</span></div>
          <div class="card-body p-4">
            <div class="small text-primary text-uppercase fw-semibold">${escapeHtml(current.category)}</div>
            <h2 class="h4 mt-1">${escapeHtml(current.label)}</h2>
            <p>${escapeHtml(current.instruction)}</p>
            ${current.physical ? '<div class="alert alert-danger py-2 small"><strong>Physical confirmation required.</strong> A readback change alone does not prove the component moved or the plumbing response is correct.</div>' : ''}
            <div class="border rounded p-3 mb-3"><div class="small text-muted">Automatic analysis</div><div class="fw-semibold" id="cx-analysis-msg">${escapeHtml(analysis.message)}</div><div id="cx-live-readback">${liveReadback(current)}</div></div>
            ${renderIntegratedAutomation(current)}
            <label class="form-label small" for="validation-note">Observation / issue</label>
            <textarea id="validation-note" class="form-control mb-3" rows="2">${escapeHtml(result?.note || '')}</textarea>
            <div class="d-flex flex-wrap gap-2">
              <button class="btn btn-outline-secondary" data-validation-action="previous" ${state.currentIndex === 0 || automationLocked ? 'disabled' : ''}>Previous</button>
              <button class="btn btn-outline-primary" data-validation-action="operation" ${automationLocked ? 'disabled' : ''}>Open Operation</button>
              <button class="btn btn-outline-warning" data-validation-action="skip" ${automationLocked ? 'disabled' : ''} title="Skip this test and move on (recorded as not applicable)"><i class="bi bi-skip-forward me-1"></i>Skip test</button>
              <span class="flex-grow-1"></span>
              <button class="btn btn-outline-secondary" data-validation-action="na" ${automationLocked ? 'disabled' : ''}>N/A</button>
              <button class="btn btn-danger" data-validation-action="fail" ${automationLocked ? 'disabled' : ''}>Fail</button>
              <button class="btn btn-success" data-validation-action="pass" ${automationLocked || guidedAutomation ? 'disabled' : ''}>${guidedAutomation ? 'Use guided test above' : 'Confirm Pass'}</button>
              <button class="btn btn-primary" data-validation-action="next" ${automationLocked ? 'disabled' : ''}>Next</button>
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
  if (focused) {
    const replacement = document.getElementById(focused.id);
    if (replacement && !replacement.disabled) {
      replacement.focus({ preventScroll: true });
      if (typeof replacement.setSelectionRange === 'function' && focused.start !== null) replacement.setSelectionRange(focused.start, focused.end);
    }
  }
  requestAnimationFrame(() => drawEvidenceChart(current));
  lastRenderSig = computeRenderSignature();
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
    const complete = done === group.length;
    return `<div class="commission-queue-row ${active ? 'active' : ''} ${complete ? 'complete' : ''} ${failed ? 'failed' : ''}"><span class="commission-queue-icon"><i class="bi ${failed ? 'bi-x-lg' : complete ? 'bi-check-lg' : active ? 'bi-play-fill' : 'bi-circle'}"></i></span><span class="flex-grow-1">${escapeHtml(category)}</span><span class="badge ${failed ? 'text-bg-danger' : complete ? 'text-bg-success' : 'text-bg-secondary'}">${done}/${group.length}</span></div>`;
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
  const payload = { schemaVersion: 3, exportedAt: new Date().toISOString(), ...state, tests: TESTS, summary: summarize() };
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
    meta: { tester: '', location: '' }, results: {}, analysis: {}, observed: {}, samples: {}, deliveryTests: {},
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
function analysisLabel(status) { return status === 'pass' ? 'AUTO PASS' : status === 'confirm' ? 'READY TO CONFIRM' : status === 'fail' ? 'FAILED' : status === 'manual' ? 'MANUAL' : 'COLLECTING'; }
function yesNo(value) { return value ? 'yes' : 'no'; }
function fmt(value) { return Number(value).toFixed(2); }
function safeFile(value) { return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'machine'; }
function escapeHtml(value) { const div = document.createElement('div'); div.textContent = String(value ?? ''); return div.innerHTML; }
function escapeHtmlAttr(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
