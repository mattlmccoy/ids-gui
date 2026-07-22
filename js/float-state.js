/* ===== float-state.js — Shared float metadata and display logic ===== */

import store from './state.js';

const WEIR_OVF_INVERT_KEY = 'ids-invert-weir-overflow';
let weirOverflowInverted = readWeirOverflowPreference();

export const FLOATS = [
  { key: 'SupplyFloat_STATE',         label: 'Supply',    color: '#4c8dff' },
  { key: 'WeirFloat_STATE',           label: 'Weir',      color: '#34d399' },
  { key: 'WasteFloat_STATE',          label: 'Waste',     color: '#f87171' },
  { key: 'SupplyOverflowFloat_STATE', label: 'Supply OVF', color: '#fb923c' },
  { key: 'WeirOverflowFloat_STATE',   label: 'Weir OVF',  color: '#a78bfa' },
  { key: 'FlushFloat_STATE',          label: 'Flush',     color: '#22d3ee' },
  { key: 'ServiceFloat_STATE',        label: 'Service',   color: '#fbbf24' },
];

export function normalizeBinaryState(raw) {
  if (raw === true || raw === 1 || raw === '1') return 1;
  if (raw === false || raw === 0 || raw === '0') return 0;
  return null;
}

export function isWeirOverflowInverted() {
  return weirOverflowInverted;
}

function readWeirOverflowPreference() {
  try {
    const stored = localStorage.getItem(WEIR_OVF_INVERT_KEY);
    // The requested physical convention (down = OFF, up = ON) is the default.
    return stored === null ? true : stored === 'true';
  } catch (_) {
    return true;
  }
}

export function setWeirOverflowInverted(enabled) {
  const value = !!enabled;
  weirOverflowInverted = value;
  try { localStorage.setItem(WEIR_OVF_INVERT_KEY, String(value)); } catch (_) { /* ignore */ }
  store.emit('float-config', { invertWeirOverflow: value });
  store.log('info', `Weir OVF display inversion ${value ? 'enabled' : 'disabled'}`);
  return value;
}

/** Return the UI state without changing the raw firmware value. */
export function getFloatDisplayState(key, raw) {
  const state = normalizeBinaryState(raw);
  if (state === null) return null;
  if (key === 'WeirOverflowFloat_STATE' && isWeirOverflowInverted()) return state ? 0 : 1;
  return state;
}

export function formatFloatState(key, raw) {
  const state = getFloatDisplayState(key, raw);
  if (state === null) return '--';
  return state ? 'ON / UP' : 'OFF / DOWN';
}
