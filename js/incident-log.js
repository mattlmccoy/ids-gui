/* Persistent browser/USB incident recorder for overnight shutdown diagnosis. */

import store from './state.js';

const LOG_KEY = 'ids.systemIncidentLog.v1';
const SESSION_KEY = 'ids.systemIncidentSession.v1';
const MAX_INCIDENTS = 500;
const HEARTBEAT_INTERVAL_MS = 15_000;
const UNCLEAN_SESSION_AGE_MS = 45_000;
const EXECUTION_GAP_MS = 120_000;

let initialized = false;
let heartbeatTimer = null;
let sessionId = '';
let lastTelemetryAt = null;

export function initIncidentLog({ mode = 'serial' } = {}) {
  if (initialized) return;
  initialized = true;

  const now = Date.now();
  const previous = readJson(SESSION_KEY, null);
  const interruption = classifyPriorSession(previous, now, UNCLEAN_SESSION_AGE_MS);
  if (interruption) {
    recordIncident('unclean-session-end', 'warning', 'Previous IDS session stopped without recording a normal page exit.', interruption);
  }

  sessionId = createId();
  writeSession({
    id: sessionId,
    active: true,
    cleanExit: false,
    mode,
    startedAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    connection: store.connection,
    visibility: pageVisibility(),
    lastTelemetryAt: null
  });
  recordIncident('app-start', 'info', 'IDS application started.', { mode, visibility: pageVisibility() });

  store.on('connection', connection => {
    recordIncident('connection-state', connection === 'ERROR' ? 'error' : 'info', `Connection state changed to ${connection}.`, {
      connection,
      visibility: pageVisibility()
    });
    updateHeartbeat();
  });
  store.on('data', () => { lastTelemetryAt = new Date().toISOString(); });

  heartbeatTimer = setInterval(updateHeartbeat, HEARTBEAT_INTERVAL_MS);

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      recordIncident('page-visibility', 'info', `IDS page became ${document.visibilityState}.`, {
        visibility: document.visibilityState,
        connection: store.connection
      });
      updateHeartbeat();
    });
    document.addEventListener('freeze', () => recordIncident('page-freeze', 'warning', 'Browser froze the IDS page.', {
      connection: store.connection,
      visibility: pageVisibility()
    }));
    document.addEventListener('resume', () => {
      recordIncident('page-resume', 'info', 'Browser resumed the IDS page.', {
        connection: store.connection,
        visibility: pageVisibility()
      });
      markSessionActive();
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pageshow', event => {
      if (!event.persisted) return;
      recordIncident('page-restored', 'info', 'IDS page was restored from browser cache.', { connection: store.connection });
      markSessionActive();
    });
    window.addEventListener('pagehide', event => markSessionExit('pagehide', { persisted: !!event.persisted }));
    window.addEventListener('beforeunload', () => markSessionExit('beforeunload'));
  }
}

export function recordIncident(type, severity, message, details = {}) {
  const entry = {
    id: createId(),
    at: new Date().toISOString(),
    sessionId: sessionId || null,
    type: String(type || 'incident'),
    severity: ['info', 'warning', 'error'].includes(severity) ? severity : 'info',
    message: String(message || ''),
    details: cleanDetails(details)
  };
  const entries = trimIncidents([...getIncidentLog(), entry], MAX_INCIDENTS);
  writeJson(LOG_KEY, entries);
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent('ids-incident-recorded', { detail: entry }));
  }
  return entry;
}

export function getIncidentLog() {
  const stored = readJson(LOG_KEY, []);
  return Array.isArray(stored) ? stored.filter(validEntry) : [];
}

export function clearIncidentLog() {
  writeJson(LOG_KEY, []);
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent('ids-incident-recorded', { detail: null }));
  }
}

export function downloadIncidentLog() {
  const incidents = getIncidentLog();
  const payload = {
    schema: 'ids-system-incidents-v1',
    exportedAt: new Date().toISOString(),
    build: typeof document !== 'undefined' ? document.querySelector('meta[name="ids-build-commit"]')?.content || 'local' : 'unknown',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    incidents,
    note: 'A power loss cannot execute JavaScript. unclean-session-end entries are inferred on the next launch from the last durable heartbeat.'
  };
  downloadJson(payload, `ids-system-incidents-${fileTimestamp()}.json`);
  return incidents.length;
}

export function classifyPriorSession(marker, now = Date.now(), staleMs = UNCLEAN_SESSION_AGE_MS) {
  if (!marker || marker.active !== true || marker.cleanExit === true) return null;
  const heartbeatMs = Date.parse(marker.heartbeatAt || marker.startedAt || '');
  if (!Number.isFinite(heartbeatMs) || now - heartbeatMs < staleMs) return null;
  return {
    previousSessionId: marker.id || null,
    previousStartedAt: marker.startedAt || null,
    lastHeartbeatAt: marker.heartbeatAt || null,
    lastTelemetryAt: marker.lastTelemetryAt || null,
    lastConnection: marker.connection || 'unknown',
    lastVisibility: marker.visibility || 'unknown',
    detectedAfterMs: Math.max(0, now - heartbeatMs)
  };
}

export function trimIncidents(entries, max = MAX_INCIDENTS) {
  if (!Array.isArray(entries)) return [];
  return entries.filter(validEntry).slice(-Math.max(1, max));
}

function markSessionExit(trigger, extra = {}) {
  if (!sessionId) return;
  recordIncident('page-exit', 'info', `IDS page exit observed (${trigger}).`, {
    trigger,
    connection: store.connection,
    visibility: pageVisibility(),
    lastTelemetryAt,
    ...extra
  });
  const current = readJson(SESSION_KEY, {});
  if (current.id !== sessionId) return;
  writeSession({ ...current, active: false, cleanExit: true, exitTrigger: trigger, exitedAt: new Date().toISOString(), lastTelemetryAt });
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function markSessionActive() {
  const current = readJson(SESSION_KEY, {});
  if (current.id !== sessionId) return;
  writeSession({ ...current, active: true, cleanExit: false, exitedAt: null, exitTrigger: null });
  if (!heartbeatTimer) heartbeatTimer = setInterval(updateHeartbeat, HEARTBEAT_INTERVAL_MS);
  updateHeartbeat();
}

function updateHeartbeat() {
  const current = readJson(SESSION_KEY, {});
  if (!sessionId || current.id !== sessionId) return;
  const now = Date.now();
  const previousHeartbeatMs = Date.parse(current.heartbeatAt || '');
  if (current.active === true && Number.isFinite(previousHeartbeatMs) && now - previousHeartbeatMs >= EXECUTION_GAP_MS) {
    recordIncident('execution-gap', 'warning', 'IDS browser execution paused for at least two minutes.', {
      previousHeartbeatAt: current.heartbeatAt,
      resumedAt: new Date(now).toISOString(),
      gapMs: now - previousHeartbeatMs,
      previousConnection: current.connection || 'unknown',
      previousVisibility: current.visibility || 'unknown',
      lastTelemetryAt: current.lastTelemetryAt || null
    });
  }
  writeSession({
    ...current,
    active: true,
    cleanExit: false,
    heartbeatAt: new Date(now).toISOString(),
    connection: store.connection,
    visibility: pageVisibility(),
    lastTelemetryAt
  });
}

function writeSession(value) { writeJson(SESSION_KEY, value); }
function pageVisibility() { return typeof document !== 'undefined' ? document.visibilityState : 'unknown'; }
function createId() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function validEntry(entry) { return !!entry && typeof entry === 'object' && typeof entry.at === 'string' && typeof entry.type === 'string'; }

function cleanDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const result = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || typeof value === 'function') continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
    else if (Array.isArray(value)) result[key] = value.slice(0, 20).map(item => String(item));
    else result[key] = String(value);
  }
  return result;
}

function readJson(key, fallback) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) { return fallback; }
}

function writeJson(key, value) {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch (_) { /* storage unavailable/full */ }
}

function downloadJson(payload, filename) {
  if (typeof document === 'undefined') return;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function fileTimestamp() { return new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z'); }
