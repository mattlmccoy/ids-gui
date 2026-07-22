/* Pure planning and evaluation helpers for the gated commissioning runner. */

export const MODE_KEYS = ['Run_MODE', 'Purge_MODE', 'Flush_MODE', 'Drain_MODE', 'Bypass_MODE'];

export const CIRCUIT_TESTS = {
  flush: {
    label: 'Flush circuit', mode: 'Flush_MODE',
    outputs: ['flushPump_STATE', 'flushValve_STATE']
  },
  drain: {
    label: 'Drain circuit', mode: 'Drain_MODE',
    outputs: ['DrainPump_STATE', 'DrainValve_STATE']
  },
  bypass: {
    label: 'Bypass valve', mode: 'Bypass_MODE',
    outputs: ['BypassValve_STATE']
  }
};

export function modeCommand(key, enabled) {
  if (!MODE_KEYS.includes(key)) throw new Error(`Unsupported commissioning mode: ${key}`);
  return JSON.stringify({ [key]: enabled ? '1' : '0' });
}

export function setpointCommand(key, value) {
  if (!['Vacuum_SETPOINT', 'Flow_SETPOINT'].includes(key)) throw new Error(`Unsupported commissioning setpoint: ${key}`);
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) throw new Error(`${key} must be between 0 and 100`);
  return JSON.stringify({ [key]: String(numeric) });
}

export function safeShutdownCommands() {
  return MODE_KEYS.map(key => modeCommand(key, false));
}

export function hasActiveAlarm(data = {}) {
  const raw = String(data.AlarmStatus ?? data.ErrorCode_STATE ?? '').trim();
  if (!raw) return false;
  return !(raw === 'NO_ERROR' || raw.endsWith('-NO_ERROR'));
}

export function binaryMatches(data, keys, expected) {
  const wanted = String(expected ? 1 : 0);
  return keys.every(key => data[key] !== undefined && String(data[key]) === wanted);
}

export function numericMatches(actual, expected, tolerance = 0.01) {
  const a = Number(actual); const b = Number(expected);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

export function vacuumResponse(baseline, current, minimumChange) {
  const start = Number(baseline); const now = Number(current); const minimum = Number(minimumChange);
  if (![start, now, minimum].every(Number.isFinite) || minimum < 0) return { pass: false, delta: null };
  const delta = Math.abs(now - start);
  return { pass: delta >= minimum, delta };
}
