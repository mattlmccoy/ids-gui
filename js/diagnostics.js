/* Rolling, secret-free diagnostic capture for support and commissioning. */

import store from './state.js';
import { calculateDualPressure, getPressureSensingConfig } from './pressure-sensing.js';
import { getPumpRuntimeSnapshot } from './component-runtime.js';

const MAX_FRAMES = 300;
const MAX_EVENTS = 200;
const frames = [];
const events = [];
let initialized = false;

export const DIAGNOSTIC_THRESHOLDS = Object.freeze({
  responseWindowSeconds: 8,
  minimumVacuumResponse: 0.75,
  minimumPressureResponse: 0.25,
  slowStartWindowSeconds: 15,
  slowStartVacuumResponse: 5,
  vacuumDecayWindowSeconds: 5,
  vacuumDecayRatePerSecond: 1,
  excessiveTransitionsPerMinute: 8
});

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
    schema: 'ids-diagnostic-v2',
    exportedAt: new Date().toISOString(),
    build: document.querySelector('meta[name="ids-build-commit"]')?.content || 'local',
    userAgent: navigator.userAgent,
    connection: store.connection,
    replayActive: store.replayActive,
    simulation: { active: store.simulationActive, scenario: store.simulationScenario },
    latestTelemetry: { ...store.data },
    dualPressure: calculateDualPressure(store.data),
    pressureSensingConfig: getPressureSensingConfig(),
    observedPumpRuntime: getPumpRuntimeSnapshot(),
    diagnosticThresholds: DIAGNOSTIC_THRESHOLDS,
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
  if (Number(last.Run_MODE) === 1 && Number(last.VacuumPump_STATE) !== 1) findings.push('Run is active but the vacuum pump readback is not ON.');
  if (Number(last.Drain_MODE) === 1 && !['DrainPump_STATE', 'ManifoldValve1_STATE', 'ManifoldValve2_STATE'].every(key => Number(last[key]) === 1)) {
    findings.push('Drain is active without all three expected R17 output readbacks.');
  }
  const vacuum = samples.map(sample => Number(sample.values.Vacuum_STATE)).filter(Number.isFinite);
  if (vacuum.length >= 10 && Math.max(...vacuum) === Math.min(...vacuum) && Number(last.Run_MODE) === 1) findings.push('Vacuum readback remained perfectly flat while Run was active.');
  findings.push(...analyzeHydraulicResponse(samples));
  findings.push(...analyzeVacuumDecay(samples));
  findings.push(...analyzeCycling(samples));
  return findings.length ? findings : ['No rule-based anomalies detected in the captured telemetry window.'];
}

export function analyzeHydraulicResponse(samples) {
  if (samples.length < 2 || Number(samples.at(-1).values.Run_MODE) !== 1) return [];
  let startIndex = samples.length - 1;
  while (startIndex > 0 && Number(samples[startIndex - 1].values.Run_MODE) === 1) startIndex -= 1;
  const segment = samples.slice(startIndex);
  const elapsed = elapsedSeconds(segment);
  if (elapsed < DIAGNOSTIC_THRESHOLDS.responseWindowSeconds) return [];
  const vacuumValues = numericValues(segment, 'Vacuum_STATE');
  const pressureValues = numericValues(segment, 'Pressure_STATE');
  if (vacuumValues.length < 2 && pressureValues.length < 2) return [];
  const vacuumSpan = numericSpan(vacuumValues);
  const pressureSpan = numericSpan(pressureValues);
  if (vacuumSpan < DIAGNOSTIC_THRESHOLDS.minimumVacuumResponse && pressureSpan < DIAGNOSTIC_THRESHOLDS.minimumPressureResponse) {
    return [`Commanded but no hydraulic response: Run has been active for ${elapsed.toFixed(0)} s, while vacuum changed ${vacuumSpan.toFixed(2)} cmH₂O and pressure changed ${pressureSpan.toFixed(2)} psi.`];
  }
  if (vacuumValues.length >= 2 && elapsed >= DIAGNOSTIC_THRESHOLDS.slowStartWindowSeconds && vacuumSpan < DIAGNOSTIC_THRESHOLDS.slowStartVacuumResponse) {
    return [`Slow hydraulic start: after ${elapsed.toFixed(0)} s of Run, vacuum response is only ${vacuumSpan.toFixed(2)} cmH₂O (advisory threshold ${DIAGNOSTIC_THRESHOLDS.slowStartVacuumResponse}).`];
  }
  return [];
}

export function analyzeVacuumDecay(samples) {
  let offIndex = -1;
  for (let index = 1; index < samples.length; index += 1) {
    if (Number(samples[index - 1].values.VacuumPump_STATE) === 1 && Number(samples[index].values.VacuumPump_STATE) === 0) offIndex = index;
  }
  if (offIndex < 1) return [];
  const segment = samples.slice(offIndex - 1);
  const elapsed = elapsedSeconds(segment);
  if (elapsed < DIAGNOSTIC_THRESHOLDS.vacuumDecayWindowSeconds) return [];
  const start = Math.abs(Number(segment[0].values.Vacuum_STATE));
  const end = Math.abs(Number(segment.at(-1).values.Vacuum_STATE));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= end) return [];
  const rate = (start - end) / elapsed;
  return rate > DIAGNOSTIC_THRESHOLDS.vacuumDecayRatePerSecond
    ? [`Rapid vacuum decay: magnitude fell ${Math.abs(start - end).toFixed(2)} cmH₂O in ${elapsed.toFixed(1)} s (${rate.toFixed(2)} cmH₂O/s). Check leaks, seals, and valve closure.`]
    : [];
}

export function analyzeCycling(samples) {
  if (samples.length < 2) return [];
  const latestAt = sampleTime(samples.at(-1), samples.length - 1);
  const recent = samples.filter((sample, index) => latestAt - sampleTime(sample, index) <= 60_000);
  const keys = ['VacuumPump_STATE', 'InputPump_STATE', 'RecirculationPump_STATE', 'BulkSupplyPump_STATE'];
  const findings = [];
  for (const key of keys) {
    let transitions = 0;
    for (let index = 1; index < recent.length; index += 1) {
      const before = recent[index - 1].values[key];
      const after = recent[index].values[key];
      if (before !== undefined && after !== undefined && Number(before) !== Number(after)) transitions += 1;
    }
    if (transitions > DIAGNOSTIC_THRESHOLDS.excessiveTransitionsPerMinute) {
      findings.push(`Excessive cycling: ${key.replace('_STATE', '')} changed state ${transitions} times in the last minute.`);
    }
  }
  return findings;
}

function numericValues(samples, key) {
  return samples.map(sample => Number(sample.values[key])).filter(Number.isFinite);
}

function numericSpan(values) {
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
}

function elapsedSeconds(samples) {
  if (samples.length < 2) return 0;
  return Math.max(0, (sampleTime(samples.at(-1), samples.length - 1) - sampleTime(samples[0], 0)) / 1000);
}

function sampleTime(sample, fallbackIndex) {
  const parsed = Date.parse(sample?.at);
  return Number.isFinite(parsed) ? parsed : fallbackIndex * 1000;
}

function push(list, value, max) {
  list.push(value);
  if (list.length > max) list.splice(0, list.length - max);
}
