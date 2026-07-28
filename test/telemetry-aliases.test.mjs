import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTelemetryAliases } from '../js/telemetry-aliases.js';

test('bare R17 Vacuum/Pressure are aliased to the _STATE keys the UI reads', () => {
  // FIRMWARE_SPEC_R17 §2.4: R17 emits bare `Vacuum` and `Pressure`; the GUI reads
  // `Vacuum_STATE` / `Pressure_STATE`, so the gauge never moved without this alias.
  const out = applyTelemetryAliases({ Vacuum: '-28.4', Pressure: '1.9' });
  assert.equal(out.Vacuum_STATE, '-28.4');
  assert.equal(out.Pressure_STATE, '1.9');
  assert.equal(out.Vacuum, '-28.4', 'raw key is preserved for the Debug telemetry table');
});

test('an explicit _STATE key always wins over the bare alias', () => {
  const out = applyTelemetryAliases({ Vacuum: '-1', Vacuum_STATE: '-42' });
  assert.equal(out.Vacuum_STATE, '-42');
});

test('frames without the bare keys are returned unchanged', () => {
  const frame = { Run_MODE: '1', FluidTemperature_STATE: '24.7' };
  assert.deepEqual(applyTelemetryAliases(frame), frame);
});

test('null/undefined bare values do not overwrite anything', () => {
  const out = applyTelemetryAliases({ Vacuum: null, Run_MODE: '1' });
  assert.equal(out.Vacuum_STATE, undefined);
  assert.equal(out.Run_MODE, '1');
});
