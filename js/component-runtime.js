/* Persistent, browser-observed pump usage. Never infers runtime through a telemetry gap. */

import store from './state.js';

const STORAGE_KEY = 'ids-component-runtime-v1';
const SCHEMA = 'ids-component-runtime-v1';
const DEFAULT_MAX_GAP_MS = 5_000;

export const PUMP_RUNTIME_COMPONENTS = Object.freeze([
  { key: 'InputPump_STATE', label: 'Input pump' },
  { key: 'RecirculationPump_STATE', label: 'Recirculation pump' },
  { key: 'DrainPump_STATE', label: 'Drain pump' },
  { key: 'BulkSupplyPump_STATE', label: 'Bulk supply pump' },
  { key: 'VacuumPump_STATE', label: 'Vacuum pump' },
  { key: 'flushPump_STATE', label: 'Flush pump' }
]);

export class ComponentRuntimeTracker {
  constructor({ storage = null, now = () => Date.now(), maxGapMs = DEFAULT_MAX_GAP_MS } = {}) {
    this.storage = storage;
    this.now = now;
    this.maxGapMs = maxGapMs;
    this.records = this.load();
    this.previous = new Map();
  }

  observe(frame) {
    const systemId = normalizeSystemId(frame?.SystemID);
    if (!systemId) return null;
    const at = this.now();
    const system = this.getSystem(systemId);
    let changed = false;

    for (const component of PUMP_RUNTIME_COMPONENTS) {
      const current = binaryState(frame[component.key]);
      if (current === null) continue;
      const previousKey = `${systemId}:${component.key}`;
      const prior = this.previous.get(previousKey);
      const record = system.components[component.key] ||= emptyRecord();

      if (prior) {
        const elapsed = at - prior.at;
        if (prior.value === 1 && elapsed > 0 && elapsed <= this.maxGapMs) {
          record.runtimeMs += elapsed;
          record.lastOperatedAt = new Date(at).toISOString();
          changed = true;
        }
        if (prior.value === 0 && current === 1) {
          record.starts += 1;
          record.lastOperatedAt = new Date(at).toISOString();
          changed = true;
        }
      } else if (current === 1) {
        record.lastOperatedAt = new Date(at).toISOString();
        changed = true;
      }

      record.lastState = current;
      record.lastObservedAt = new Date(at).toISOString();
      this.previous.set(previousKey, { at, value: current });
    }

    if (changed) {
      system.updatedAt = new Date(at).toISOString();
      this.save();
    }
    return this.snapshot(systemId);
  }

  pause() {
    this.previous.clear();
  }

  snapshot(systemId) {
    const normalized = normalizeSystemId(systemId);
    const system = normalized ? this.records.systems[normalized] : null;
    return {
      schema: SCHEMA,
      systemId: normalized || null,
      updatedAt: system?.updatedAt || null,
      components: PUMP_RUNTIME_COMPONENTS.map(component => ({
        ...component,
        ...(system?.components?.[component.key] || emptyRecord())
      }))
    };
  }

  getSystem(systemId) {
    return this.records.systems[systemId] ||= { updatedAt: null, components: {} };
  }

  load() {
    try {
      const parsed = JSON.parse(this.storage?.getItem(STORAGE_KEY) || 'null');
      if (parsed?.schema === SCHEMA && parsed.systems && typeof parsed.systems === 'object') return parsed;
    } catch (_) { /* start with an empty, valid record */ }
    return { schema: SCHEMA, systems: {} };
  }

  save() {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.records)); } catch (_) { /* usage tracking must never stop the UI */ }
  }
}

let activeTracker = null;

export function initComponentRuntimeTracking() {
  if (activeTracker) return activeTracker;
  activeTracker = new ComponentRuntimeTracker({ storage: globalThis.localStorage });
  store.on('data', data => {
    if (store.connection !== 'CONNECTED' || store.replayActive || store.simulationActive) return;
    const snapshot = activeTracker.observe(data);
    if (snapshot) store.emit('pump-runtime', snapshot);
  });
  store.on('connection', state => {
    if (state !== 'CONNECTED') activeTracker.pause();
  });
  store.on('simulation', () => activeTracker.pause());
  store.on('replay', () => activeTracker.pause());
  return activeTracker;
}

export function getPumpRuntimeSnapshot(systemId = store.data.SystemID) {
  return activeTracker?.snapshot(systemId) || {
    schema: SCHEMA,
    systemId: normalizeSystemId(systemId),
    updatedAt: null,
    components: PUMP_RUNTIME_COMPONENTS.map(component => ({ ...component, ...emptyRecord() }))
  };
}

export function formatObservedRuntime(runtimeMs) {
  const totalMinutes = Math.max(0, Math.floor(Number(runtimeMs || 0) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours} h ${minutes} min` : `${minutes} min`;
}

function emptyRecord() {
  return { runtimeMs: 0, starts: 0, lastOperatedAt: null, lastObservedAt: null, lastState: null };
}

function binaryState(value) {
  const numeric = Number(value);
  return numeric === 0 || numeric === 1 ? numeric : null;
}

function normalizeSystemId(value) {
  const normalized = String(value ?? '').trim();
  return normalized && normalized.length <= 100 ? normalized : null;
}

