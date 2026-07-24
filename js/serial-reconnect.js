/* Pure decision helpers for Web Serial auto-reconnect. No DOM / navigator access. */

export const RECONNECT_INTERVAL_MS = 3000;

/** Auto-reconnect only for unexpected drops, and only while the feature is enabled. */
export function shouldAutoReconnect(reason, enabled) {
  return enabled === true && reason !== 'manual';
}

/** Pick the port to reopen: prefer the Arduino vendor, else the first granted port, else null. */
export function selectReconnectPort(ports, vendorId) {
  if (!Array.isArray(ports) || ports.length === 0) return null;
  const match = ports.find(p => {
    try { return (p?.getInfo?.() || {}).usbVendorId === vendorId; } catch { return false; }
  });
  return match || ports[0] || null;
}

/** First attempt fires immediately; subsequent attempts use a steady, bounded interval. */
export function nextReconnectDelayMs(attempt) {
  return attempt <= 0 ? 0 : RECONNECT_INTERVAL_MS;
}

/** No telemetry for this long while CONNECTED = treat the link as dropped and reconnect. */
export const STALE_TELEMETRY_MS = 8000;

/**
 * True when the controller has gone silent — no frame for longer than staleMs — which
 * happens on a soft reset / power-cycle where the USB CDC port stays enumerated but stops
 * responding, so no 'disconnect' event or read error ever fires. `lastFrameAt` of 0/null
 * means no frame has arrived yet (the connect path handles the first frame), so not stale.
 */
export function isTelemetryStale(lastFrameAt, now, staleMs = STALE_TELEMETRY_MS) {
  if (!lastFrameAt) return false;
  return now - lastFrameAt > staleMs;
}
