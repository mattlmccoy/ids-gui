/* Rolling, secret-free diagnostic capture for support and commissioning. */

import store from './state.js';

const MAX_FRAMES = 300;
const MAX_EVENTS = 200;
const frames = [];
const events = [];
let initialized = false;

export function initDiagnostics() {
  if (initialized) return;
  initialized = true;
  store.on('data', data => push(frames, { at: new Date().toISOString(), values: { ...data } }, MAX_FRAMES));
  store.on('log', entry => push(events, { at: entry.timestamp?.toISOString?.() || new Date().toISOString(), type: 'log', severity: entry.severity, message: entry.message }, MAX_EVENTS));
  store.on('command-sent', command => push(events, { at: new Date().toISOString(), type: 'command', command }, MAX_EVENTS));
  store.on('connection', state => push(events, { at: new Date().toISOString(), type: 'connection', state }, MAX_EVENTS));
}

export function downloadDiagnosticBundle() {
  const payload = {
    schema: 'ids-diagnostic-v1',
    exportedAt: new Date().toISOString(),
    build: document.querySelector('meta[name="ids-build-commit"]')?.content || 'local',
    userAgent: navigator.userAgent,
    connection: store.connection,
    replayActive: store.replayActive,
    latestTelemetry: { ...store.data },
    findings: analyzeTelemetry(frames),
    events: [...events],
    telemetry: [...frames],
    note: 'Remote relay tokens, ntfy topics, and browser storage are intentionally excluded.'
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ids-diagnostic-${new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  store.log('info', `Diagnostic bundle exported (${frames.length} telemetry frames, ${events.length} events)`);
}

export function getDiagnosticSnapshot() {
  return {
    frames: frames.map(frame => ({ at: frame.at, values: { ...frame.values } })),
    events: events.map(event => ({ ...event })),
    findings: analyzeTelemetry(frames)
  };
}

export function analyzeTelemetry(samples) {
  const findings = [];
  if (!samples.length) return ['No telemetry captured in this browser session.'];
  const last = samples.at(-1).values;
  if (Number(last.Bypass_MODE) === 1) findings.push('Bypass is active and has no firmware timeout.');
  if (Number(last.Run_MODE) === 1 && Number(last.VacuumPump_STATE) !== 1) findings.push('Run is active but the vacuum pump readback is not ON.');
  if (Number(last.Drain_MODE) === 1 && !['DrainPump_STATE', 'ManifoldValve1_STATE', 'ManifoldValve2_STATE'].every(key => Number(last[key]) === 1)) {
    findings.push('Drain is active without all three expected R17 output readbacks.');
  }
  const vacuum = samples.map(sample => Number(sample.values.Vacuum_STATE)).filter(Number.isFinite);
  if (vacuum.length >= 10 && Math.max(...vacuum) === Math.min(...vacuum) && Number(last.Run_MODE) === 1) findings.push('Vacuum readback remained perfectly flat while Run was active.');
  return findings.length ? findings : ['No rule-based anomalies detected in the captured telemetry window.'];
}

function push(list, value, max) {
  list.push(value);
  if (list.length > max) list.splice(0, list.length - max);
}
