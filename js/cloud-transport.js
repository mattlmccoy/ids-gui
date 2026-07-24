/* CloudTransport — runs the app against the relay instead of Web Serial.
   Telemetry: poll GET /api/v1/status and feed the matching device's frame into
   store.setData. Commands: POST validated single-key payloads to /api/v1/commands. */

import store from './state.js';
import { validateCommandPayload } from './command-allowlist.js';

const NOMINAL_POLL_INTERVAL_MS = 1000;
let pollIntervalMs = NOMINAL_POLL_INTERVAL_MS;
let session = null;      // { workerUrl, deviceId, viewerToken, operatorToken }
let pollTimer = null;
let seq = 0;

export function buildCommandBody(deviceId, payload, idempotencyKey) {
  return {
    body: { deviceId, type: 'payload', payload, requestedBy: 'mirror', idempotencyKey },
    headers: { 'Idempotency-Key': idempotencyKey, 'Content-Type': 'application/json' },
  };
}

export function frameFromStatus(status, deviceId) {
  const dev = (status?.devices || []).find(d => d.device_id === deviceId);
  if (!dev) return null;
  return { connection: dev.connection || 'DISCONNECTED', telemetry: dev.telemetry || {} };
}

export function createCloudTransport(activeSession) {
  session = activeSession;
  return {
    id: 'cloud',
    isSupported: () => true,
    getPollIntervalMs: () => pollIntervalMs,
    getNominalPollIntervalMs: () => NOMINAL_POLL_INTERVAL_MS,
    setPollIntervalMs: ms => { pollIntervalMs = Math.min(5000, Math.max(500, Number(ms) || NOMINAL_POLL_INTERVAL_MS)); },
    async connect() {
      store.setConnection('CONNECTING');
      const ok = await pollOnce();
      store.setConnection(ok ? 'CONNECTED' : 'DISCONNECTED');
      if (!pollTimer) pollTimer = setInterval(pollOnce, pollIntervalMs);
    },
    async disconnect() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      store.setConnection('DISCONNECTED');
    },
    async send(jsonStr) {
      const trimmed = String(jsonStr).trim();
      if (trimmed.includes('"GET"')) { await pollOnce(); return true; } // read poll — no command queued
      const check = validateCommandPayload(trimmed);
      if (!check.ok) { store.log('error', `Remote command blocked locally: ${check.error}`); return false; }
      const { body, headers } = buildCommandBody(session.deviceId, trimmed, `mirror-${Date.now()}-${seq++}`);
      try {
        const res = await fetch(`${session.workerUrl}/api/v1/commands`, {
          method: 'POST',
          headers: { ...headers, Authorization: `Bearer ${session.operatorToken}` },
          body: JSON.stringify(body),
        });
        if (!res.ok) { store.log('error', `Relay rejected command (${res.status})`); return false; }
        store.emit('command-sent', trimmed);
        return true;
      } catch (err) { store.log('error', `Relay unreachable: ${err.message}`); return false; }
    },
  };
}

async function pollOnce() {
  if (!session) return false;
  try {
    const res = await fetch(`${session.workerUrl}/api/v1/status`, {
      headers: { Authorization: `Bearer ${session.viewerToken}` },
    });
    if (!res.ok) return false;
    const frame = frameFromStatus(await res.json(), session.deviceId);
    if (!frame) return false;
    store.setConnection(frame.connection === 'CONNECTED' ? 'CONNECTED' : 'DISCONNECTED');
    store.setData(frame.telemetry);
    return frame.connection === 'CONNECTED';
  } catch (_) { return false; }
}
