import store from './state.js';

const STORAGE_KEY = 'ids-heater-channels-v1';
let hydrated = false;

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
  hydrateHeaterVisibility();
  return store.getHeaterVisibility();
}

export function setHeaterVisibility(heaterName, visible) {
  hydrateHeaterVisibility();
  store.setHeaterVisibility(heaterName, visible);
  persistHeaterVisibility();
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

  // Generic heater/HTC error (firmware reports no channel). At least one channel is marked
  // not-installed here (both-installed already returned false above). Show the alarm only when
  // an INSTALLED (enabled) channel is actually reading a fault; otherwise it is attributable to
  // the uninstalled channel(s) and is suppressed. This keeps real faults on a live heater
  // visible while silencing the expected fault from a channel the operator disabled.
  const mainVal = parseFloat(store.data?.MainHeaterTemperature_STATE);
  const auxVal = parseFloat(store.data?.AUXHeaterTemperature_STATE);
  const mainInstalledFaulted = !mainHidden && isHeaterTempClearlyFaulted(mainVal);
  const auxInstalledFaulted = !auxHidden && isHeaterTempClearlyFaulted(auxVal);
  if (mainInstalledFaulted || auxInstalledFaulted) return false;
  return true;
}

/** Relay the EFFECTIVE alarm to downstream consumers (e.g. the remote viewer, which has no local
    heater-installed config): when a heater alarm is being suppressed, clear its error while keeping
    any op-status prefix, so the phone shows the same "no active alarm" the main GUI shows. Real,
    non-suppressed alarms pass through unchanged. */
export function relayAlarmStatus(rawAlarm) {
  const raw = String(rawAlarm ?? '');
  if (!raw || raw.endsWith('NO_ERROR')) return raw;
  if (!shouldSuppressHeaterError('', raw)) return raw;
  const dash = raw.indexOf('-');
  return dash > 0 ? `${raw.slice(0, dash)}-NO_ERROR` : 'NO_ERROR';
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

function hydrateHeaterVisibility() {
  if (hydrated) return;
  hydrated = true;
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || 'null');
    for (const heaterName of Object.keys(HEATER_KEYS)) {
      if (typeof saved?.[heaterName] === 'boolean') {
        store.setHeaterVisibility(heaterName, saved[heaterName]);
      }
    }
  } catch (error) {
    console.warn('[heater-profile] Could not load saved heater channels:', error);
  }
}

function persistHeaterVisibility() {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(store.getHeaterVisibility()));
  } catch (error) {
    console.warn('[heater-profile] Could not save heater channels:', error);
  }
}
