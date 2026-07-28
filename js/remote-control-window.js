/* Pure decision helper for the local remote-control window. No DOM / store access. */

/**
 * Resolve whether remote control may execute right now.
 *
 * Control is active only while the operator's window is open AND the controller is
 * connected. A disconnect merely PAUSES control — the window is preserved so an
 * auto-reconnect (e.g. after a controller power-cycle) resumes it automatically for the
 * remaining time. Only genuine expiry clears the window.
 */
export function resolveRemoteControlWindow(enabledUntil, now, connection) {
  const until = Number(enabledUntil) || 0;
  if (until <= now) return { active: false, enabledUntil: 0 };
  return { active: connection === 'CONNECTED', enabledUntil: until };
}
