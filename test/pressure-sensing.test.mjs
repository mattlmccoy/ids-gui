import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDualPressure, normalizePressureSensingConfig } from '../js/pressure-sensing.js';

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
