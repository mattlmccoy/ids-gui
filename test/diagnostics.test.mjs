import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCycling, analyzeHydraulicResponse, analyzeTelemetry, analyzeVacuumDecay } from '../js/diagnostics.js';

test('diagnostics identifies unsafe or contradictory readbacks', () => {
  const findings = analyzeTelemetry(Array.from({ length: 10 }, (_, index) => ({
    at: String(index), values: {
      Run_MODE: '1', VacuumPump_STATE: '0', Vacuum_STATE: '12',
      Drain_MODE: '1', DrainPump_STATE: '1', ManifoldValve1_STATE: '1', ManifoldValve2_STATE: '0'
    }
  })));
  assert.ok(findings.some(item => item.includes('vacuum pump')));
  assert.ok(findings.some(item => item.includes('Drain')));
  assert.ok(findings.some(item => item.includes('flat')));
});

test('diagnostics explains an empty capture', () => {
  assert.deepEqual(analyzeTelemetry([]), ['No telemetry captured in this browser session.']);
});

test('diagnostics detects missing and slow hydraulic response', () => {
  const noResponse = timedFrames(10, index => ({ Run_MODE: '1', Vacuum_STATE: '0', Pressure_STATE: '0', VacuumPump_STATE: '1' }));
  assert.ok(analyzeHydraulicResponse(noResponse).some(item => item.includes('no hydraulic response')));
  const slow = timedFrames(17, index => ({ Run_MODE: '1', Vacuum_STATE: String(index * 0.2), Pressure_STATE: String(index * 0.04), VacuumPump_STATE: '1' }));
  assert.ok(analyzeHydraulicResponse(slow).some(item => item.includes('Slow hydraulic start')));
  assert.deepEqual(analyzeHydraulicResponse(timedFrames(10, () => ({ Run_MODE: '1', VacuumPump_STATE: '1' }))), []);
});

test('diagnostics detects vacuum decay and excessive cycling', () => {
  const decay = timedFrames(9, index => ({ VacuumPump_STATE: index < 2 ? '1' : '0', Vacuum_STATE: String(index < 2 ? 20 : 20 - (index - 1) * 2) }));
  assert.ok(analyzeVacuumDecay(decay).some(item => item.includes('Rapid vacuum decay')));
  const cycling = timedFrames(12, index => ({ VacuumPump_STATE: String(index % 2), InputPump_STATE: '1' }));
  assert.ok(analyzeCycling(cycling).some(item => item.includes('Excessive cycling')));
});

function timedFrames(count, values) {
  const start = Date.parse('2026-01-01T00:00:00Z');
  return Array.from({ length: count }, (_, index) => ({ at: new Date(start + index * 1000).toISOString(), values: values(index) }));
}
