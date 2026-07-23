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
