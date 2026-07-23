/* Optional dual-pressure sensing for printhead inlet/return instrumentation. */

import store from './state.js';

const STORAGE_KEY = 'ids-dual-pressure-v1';
const DEFAULTS = Object.freeze({ enabled: false, inletOffsetPsi: 0, returnOffsetPsi: 0, meniscusOffsetPsi: 0 });

export function getPressureSensingConfig() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || 'null');
    return normalizePressureSensingConfig(saved);
  } catch {
    return { ...DEFAULTS };
  }
}

export function setPressureSensingConfig(config) {
  const normalized = normalizePressureSensingConfig(config);
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch { /* non-persistent browser */ }
  store.emit('pressure-sensing-config', normalized);
  return normalized;
}

export function normalizePressureSensingConfig(config = {}) {
  return {
    enabled: config?.enabled === true,
    inletOffsetPsi: bounded(config?.inletOffsetPsi, -20, 20),
    returnOffsetPsi: bounded(config?.returnOffsetPsi, -20, 20),
    meniscusOffsetPsi: bounded(config?.meniscusOffsetPsi, -20, 20)
  };
}

export function calculateDualPressure(data = {}, config = getPressureSensingConfig()) {
  const normalized = normalizePressureSensingConfig(config);
  if (!normalized.enabled) return { available: false, reason: 'Dual pressure sensing is not enabled.' };
  const inletRawPsi = Number(data.InletPressure_STATE);
  const returnRawPsi = Number(data.ReturnPressure_STATE);
  if (!Number.isFinite(inletRawPsi) || !Number.isFinite(returnRawPsi)) {
    return { available: false, reason: 'Waiting for InletPressure_STATE and ReturnPressure_STATE telemetry.' };
  }
  const inletPsi = inletRawPsi + normalized.inletOffsetPsi;
  const returnPsi = returnRawPsi + normalized.returnOffsetPsi;
  return {
    available: true,
    inletRawPsi,
    returnRawPsi,
    inletPsi,
    returnPsi,
    differentialPsi: inletPsi - returnPsi,
    estimatedMeniscusPsi: (inletPsi + returnPsi) / 2 + normalized.meniscusOffsetPsi,
    method: 'Average of corrected inlet and return pressures plus configured hydrostatic/nozzle offset.'
  };
}

function bounded(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : 0;
}
