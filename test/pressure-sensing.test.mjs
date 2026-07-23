import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDualPressure,
  normalizePressureSensingConfig,
  isDualPressureEnabled,
  filterActivePressureTraces,
  DUAL_PRESSURE_DERIVED_KEYS
} from '../js/pressure-sensing.js';

test('dual pressure calculation applies zero and meniscus offsets', () => {
  const result = calculateDualPressure(
    { InletPressure_STATE: '2.0', ReturnPressure_STATE: '1.0' },
    { enabled: true, inletOffsetPsi: 0.1, returnOffsetPsi: -0.1, meniscusOffsetPsi: -1.2 }
  );
  assert.equal(result.available, true);
  assert.ok(Math.abs(result.differentialPsi - 1.2) < 1e-9);
  assert.ok(Math.abs(result.estimatedMeniscusPsi - 0.3) < 1e-9);
});

test('dual pressure remains unavailable without configuration and both fields', () => {
  assert.equal(calculateDualPressure({}, { enabled: false }).available, false);
  assert.equal(calculateDualPressure({ InletPressure_STATE: 1 }, { enabled: true }).available, false);
  assert.deepEqual(normalizePressureSensingConfig({ enabled: true, inletOffsetPsi: 99 }), {
    enabled: true, inletOffsetPsi: 20, returnOffsetPsi: 0, meniscusOffsetPsi: 0
  });
});

test('isDualPressureEnabled reflects the normalized enabled flag', () => {
  assert.equal(isDualPressureEnabled({ enabled: true }), true);
  assert.equal(isDualPressureEnabled({ enabled: false }), false);
  assert.equal(isDualPressureEnabled({}), false);
  assert.equal(isDualPressureEnabled({ enabled: 'yes' }), false);
});

test('DUAL_PRESSURE_DERIVED_KEYS lists exactly the four derived series keys', () => {
  assert.deepEqual([...DUAL_PRESSURE_DERIVED_KEYS].sort(), [
    'DifferentialPressureDerived',
    'InletPressureAdjusted',
    'MeniscusPressureEstimated',
    'ReturnPressureAdjusted'
  ]);
});

test('filterActivePressureTraces drops the four derived traces only when disabled', () => {
  const traces = [
    { key: 'Vacuum_STATE' },
    { key: 'Vacuum_SETPOINT' },
    { key: 'Pressure_STATE' },
    { key: 'InletPressureAdjusted' },
    { key: 'ReturnPressureAdjusted' },
    { key: 'DifferentialPressureDerived' },
    { key: 'MeniscusPressureEstimated' }
  ];

  const disabled = filterActivePressureTraces(traces, { enabled: false });
  assert.deepEqual(disabled.map(t => t.key), ['Vacuum_STATE', 'Vacuum_SETPOINT', 'Pressure_STATE']);

  const enabled = filterActivePressureTraces(traces, { enabled: true });
  assert.deepEqual(enabled.map(t => t.key), traces.map(t => t.key));
  // returns a new array, does not mutate the input catalog
  assert.notEqual(enabled, traces);
  assert.equal(traces.length, 7);
});
