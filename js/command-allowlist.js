/* Canonical allow-list of controller commands the GUI may send, plus a pure
   validator. Keep worker/src/command-allowlist.js identical (guarded by
   test/allowlist-parity.test.mjs). */

// Setpoint ranges — mirror of the SETPOINTS array in ui-operation.js.
const RANGES = {
  Vacuum_SETPOINT: [0, 100], Flow_SETPOINT: [0, 100], Temperature_SETPOINT: [0, 70],
  TemperatureMAX_SETPOINT: [20, 100], InputPumpSpeed_SETPOINT: [0, 100],
  FlushPumpSpeed_SETPOINT: [0, 100], DrainPumpSpeed_SETPOINT: [0, 100],
  ServiceRecirculationPumpSpeed_SETPOINT: [0, 100], HeaterTemperature_SETPOINT: [20, 100],
  PressureMAX_SETPOINT: [0, 100], BulkSupplyTimeout_SETPOINT: [0, 3600],
};
const BINARY = ['Run_MODE', 'Purge_MODE', 'Flush_MODE', 'Drain_MODE', 'WatchdogTrigger_MODE', 'WeirFloatInvert_SETUP'];

export const COMMAND_ALLOWLIST = (() => {
  const map = { GET: { kind: 'read', values: ['ALL'] } };
  for (const k of BINARY) map[k] = { kind: 'binary' };
  for (const [k, [min, max]] of Object.entries(RANGES)) map[k] = { kind: 'range', min, max };
  return map;
})();

export function validateCommandPayload(jsonStr) {
  let obj;
  try { obj = JSON.parse(jsonStr); } catch (_) { return { ok: false, error: 'not JSON' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'not an object' };
  const keys = Object.keys(obj);
  if (keys.length !== 1) return { ok: false, error: 'exactly one key required' };
  const key = keys[0];
  const value = String(obj[key]);
  const def = COMMAND_ALLOWLIST[key];
  if (!def) return { ok: false, error: `key not allowed: ${key}` };
  if (def.kind === 'read') return def.values.includes(value) ? { ok: true, key, value } : { ok: false, error: 'bad read value' };
  if (def.kind === 'binary') return (value === '0' || value === '1') ? { ok: true, key, value } : { ok: false, error: 'binary must be 0/1' };
  const n = Number(value);
  if (!Number.isFinite(n) || n < def.min || n > def.max) return { ok: false, error: `out of range ${def.min}-${def.max}` };
  return { ok: true, key, value: String(n) };
}
