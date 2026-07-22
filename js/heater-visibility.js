import store from './state.js';

export const HEATER_KEYS = {
  MainHeater: {
    tempKey: 'MainHeaterTemperature_STATE',
    ssrKey: 'MainHeaterSSR_STATE'
  },
  AuxHeater: {
    tempKey: 'AUXHeaterTemperature_STATE',
    ssrKey: 'AUXHeaterSSR_STATE'
  }
};

const SUPPRESSIBLE_HEATER_ERRORS = new Set([
  'HEATER_ERROR',
  'HEATER_TC_ERROR',
  'HTC_ERROR',
  'MAIN_HEATER_ERROR',
  'MAIN_HEATER_TC_ERROR',
  'AUX_HEATER_ERROR',
  'AUX_HEATER_TC_ERROR'
]);

export function getHeaterVisibility() {
  return store.getHeaterVisibility();
}

export function setHeaterVisibility(heaterName, visible) {
  store.setHeaterVisibility(heaterName, visible);
}

export function isHeaterVisible(heaterName) {
  return !!getHeaterVisibility()[heaterName];
}

export function heaterNameForDataKey(dataKey) {
  for (const [heaterName, cfg] of Object.entries(HEATER_KEYS)) {
    if (cfg.tempKey === dataKey || cfg.ssrKey === dataKey) return heaterName;
  }
  return null;
}

export function isDataKeyVisible(dataKey) {
  const heaterName = heaterNameForDataKey(dataKey);
  if (!heaterName) return true;
  return isHeaterVisible(heaterName);
}

export function shouldSuppressHeaterError(errorCode, rawAlarm = '') {
  const code = String(errorCode || '').toUpperCase();
  const raw = String(rawAlarm || '').toUpperCase();

  const looksHeaterRelated = SUPPRESSIBLE_HEATER_ERRORS.has(code)
    || code.includes('HEATER')
    || code.includes('HTC')
    || raw.includes('HEATER')
    || raw.includes('HTC');
  if (!looksHeaterRelated) return false;

  const vis = getHeaterVisibility();
  const mainHidden = vis.MainHeater === false;
  const auxHidden = vis.AuxHeater === false;
  if (!mainHidden && !auxHidden) return false;

  const targetsMain = code.includes('MAIN') || raw.includes('MAIN');
  const targetsAux = code.includes('AUX') || raw.includes('AUX');

  if (targetsMain) return mainHidden;
  if (targetsAux) return auxHidden;

  // For generic heater errors (no main/aux in code), infer likely source from live temps.
  const mainVal = parseFloat(store.data?.MainHeaterTemperature_STATE);
  const auxVal = parseFloat(store.data?.AUXHeaterTemperature_STATE);
  const mainBad = isHeaterTempClearlyFaulted(mainVal);
  const auxBad = isHeaterTempClearlyFaulted(auxVal);

  if (mainBad && !auxBad) return mainHidden;
  if (auxBad && !mainBad) return auxHidden;
  if (mainBad && auxBad) return mainHidden && auxHidden;

  // Ambiguous generic heater error: be conservative and suppress only if both are hidden.
  return mainHidden && auxHidden;
}

/** Give the operator the live evidence behind a generic heater/HTC alarm. */
export function describeHeaterFault(data = store.data) {
  const readings = [
    ['Main', data?.MainHeaterTemperature_STATE],
    ['Aux', data?.AUXHeaterTemperature_STATE]
  ];
  const formatted = readings.map(([label, raw]) => {
    const value = Number(raw);
    if (raw === undefined || raw === null || raw === '') return `${label}: no reading`;
    if (!Number.isFinite(value)) return `${label}: invalid (${String(raw)})`;
    const flag = isHeaterTempClearlyFaulted(value) ? ' — implausible' : '';
    return `${label}: ${value.toFixed(1)} °C${flag}`;
  });
  return `Live heater inputs: ${formatted.join('; ')}.`;
}

function isHeaterTempClearlyFaulted(temp) {
  if (!Number.isFinite(temp)) return false;
  // 999C-like values and obviously impossible ranges from broken sensors.
  return temp >= 250 || temp <= -40;
}
