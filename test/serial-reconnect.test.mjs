import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoReconnect, selectReconnectPort, nextReconnectDelayMs, isTelemetryStale, STALE_TELEMETRY_MS } from '../js/serial-reconnect.js';

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

test('isTelemetryStale detects a silent drop (device stopped sending without a USB disconnect)', () => {
  const now = 100_000;
  // Fresh frame — not stale.
  assert.equal(isTelemetryStale(now - 1000, now, STALE_TELEMETRY_MS), false);
  assert.equal(isTelemetryStale(now - (STALE_TELEMETRY_MS - 1), now, STALE_TELEMETRY_MS), false);
  // No frame for longer than the threshold — stale, trigger reconnect.
  assert.equal(isTelemetryStale(now - (STALE_TELEMETRY_MS + 1), now, STALE_TELEMETRY_MS), true);
  // Never received a frame (0 / null) — not stale yet; connect path handles first frame.
  assert.equal(isTelemetryStale(0, now, STALE_TELEMETRY_MS), false);
  assert.equal(isTelemetryStale(null, now, STALE_TELEMETRY_MS), false);
});
