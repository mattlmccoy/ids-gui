import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRemoteControlWindow } from '../js/remote-control-window.js';

const NOW = 1_000_000;

test('remote control is active only while connected and inside the window', () => {
  const r = resolveRemoteControlWindow(NOW + 60_000, NOW, 'CONNECTED');
  assert.equal(r.active, true);
  assert.equal(r.enabledUntil, NOW + 60_000);
});

test('a dropped link pauses control but PRESERVES the window across a reconnect', () => {
  // The regression: a power-cycle zeroed enabledUntil, so after auto-reconnect the laptop
  // silently could not send until the operator re-enabled remote control.
  const dropped = resolveRemoteControlWindow(NOW + 60_000, NOW, 'RECONNECTING');
  assert.equal(dropped.active, false, 'paused while the controller is away');
  assert.equal(dropped.enabledUntil, NOW + 60_000, 'window is retained, not burned');

  const back = resolveRemoteControlWindow(dropped.enabledUntil, NOW + 5_000, 'CONNECTED');
  assert.equal(back.active, true, 'resumes automatically once reconnected');
});

test('an expired window is cleared even while connected', () => {
  const r = resolveRemoteControlWindow(NOW - 1, NOW, 'CONNECTED');
  assert.equal(r.active, false);
  assert.equal(r.enabledUntil, 0);
});

test('never enabled stays off', () => {
  const r = resolveRemoteControlWindow(0, NOW, 'CONNECTED');
  assert.equal(r.active, false);
  assert.equal(r.enabledUntil, 0);
});
