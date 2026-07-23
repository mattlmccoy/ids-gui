import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTelemetry } from '../js/diagnostics.js';

test('diagnostics identifies unsafe or contradictory readbacks', () => {
  const findings = analyzeTelemetry(Array.from({ length: 10 }, (_, index) => ({
    at: String(index), values: {
      Bypass_MODE: '1', Run_MODE: '1', VacuumPump_STATE: '0', Vacuum_STATE: '12',
      Drain_MODE: '1', DrainPump_STATE: '1', ManifoldValve1_STATE: '1', ManifoldValve2_STATE: '0'
    }
  })));
  assert.ok(findings.some(item => item.includes('Bypass')));
  assert.ok(findings.some(item => item.includes('vacuum pump')));
  assert.ok(findings.some(item => item.includes('Drain')));
  assert.ok(findings.some(item => item.includes('flat')));
});

test('diagnostics explains an empty capture', () => {
  assert.deepEqual(analyzeTelemetry([]), ['No telemetry captured in this browser session.']);
});
