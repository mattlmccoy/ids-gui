import test from 'node:test';
import assert from 'node:assert/strict';
import { getFloatDisplayState, setWeirOverflowInverted, setFloatMirrorPassthrough } from '../js/float-state.js';

test('Weir OVF inverts by default (down = OFF, up = ON) and other floats pass through', () => {
  setFloatMirrorPassthrough(false);
  setWeirOverflowInverted(true);
  assert.equal(getFloatDisplayState('WeirOverflowFloat_STATE', 1), 0);
  assert.equal(getFloatDisplayState('WeirOverflowFloat_STATE', 0), 1);
  assert.equal(getFloatDisplayState('WeirFloat_STATE', 1), 1);
});

test('mirror passthrough renders floats exactly as received (no double inversion)', () => {
  setWeirOverflowInverted(true);
  setFloatMirrorPassthrough(true);
  // The host already applied its display convention before relaying, so the mirror must
  // NOT invert again — a relayed value passes straight through.
  assert.equal(getFloatDisplayState('WeirOverflowFloat_STATE', 1), 1);
  assert.equal(getFloatDisplayState('WeirOverflowFloat_STATE', 0), 0);
  assert.equal(getFloatDisplayState('WeirFloat_STATE', 1), 1);
  setFloatMirrorPassthrough(false); // reset shared module state for other tests
});
