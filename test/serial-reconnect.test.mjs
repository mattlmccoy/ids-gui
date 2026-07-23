import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoReconnect, selectReconnectPort, nextReconnectDelayMs } from '../js/serial-reconnect.js';

test('shouldAutoReconnect only for unexpected drops while enabled', () => {
  assert.equal(shouldAutoReconnect('unexpected', true), true);
  assert.equal(shouldAutoReconnect('stream-ended', true), true);
  assert.equal(shouldAutoReconnect('manual', true), false);   // user chose to disconnect
  assert.equal(shouldAutoReconnect('unexpected', false), false); // feature off
});

test('selectReconnectPort prefers the Arduino vendor, falls back to first, else null', () => {
  const arduino = { getInfo: () => ({ usbVendorId: 0x2341 }) };
  const other = { getInfo: () => ({ usbVendorId: 0x1234 }) };
  assert.equal(selectReconnectPort([other, arduino], 0x2341), arduino);
  assert.equal(selectReconnectPort([other], 0x2341), other); // fall back to first granted port
  assert.equal(selectReconnectPort([], 0x2341), null);
  assert.equal(selectReconnectPort(null, 0x2341), null);
  const noInfo = {};
  assert.equal(selectReconnectPort([noInfo], 0x2341), noInfo); // missing getInfo → fall back to first granted port
});

test('nextReconnectDelayMs: immediate first attempt, then a steady bounded interval', () => {
  assert.equal(nextReconnectDelayMs(0), 0);           // first attempt right away
  assert.equal(nextReconnectDelayMs(1), 3000);
  assert.equal(nextReconnectDelayMs(5), 3000);        // stays bounded, no runaway growth
});
