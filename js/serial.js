/* ===== serial.js — Web Serial API layer ===== */

import store from './state.js';
import { handleSimulatedCommand } from './firmware-simulator.js';
import { shouldAutoReconnect, selectReconnectPort, nextReconnectDelayMs, isTelemetryStale, STALE_TELEMETRY_MS } from './serial-reconnect.js';
import { recordIncident } from './incident-log.js';

const BAUD_RATE = 115200;
const ARDUINO_VENDOR_ID = 0x2341;
const BUFFER_MAX = 8192; // 8 KB overflow guard
const NOMINAL_POLL_INTERVAL_MS = 1000;
const POLL_INTERVAL_MIN_MS = 200;
const POLL_INTERVAL_MAX_MS = 5000;
const LINK_PROBE_TIMEOUT_MS = 3000;

let port = null;
let reader = null;
let writer = null;
let readLoopActive = false;
let pollTimer = null;
let pollIntervalMs = NOMINAL_POLL_INTERVAL_MS;
let autoReconnect = true;
let reconnectTimer = null;
let reconnectAttempts = 0;
let lastFrameAt = 0;
let staleWatchdogTimer = null;

/* ---------- Brace-counting JSON frame parser ---------- */

let buffer = '';

/**
 * Feed raw serial text into the frame parser.
 * Extracts complete JSON objects using brace counting,
 * handles partial frames, nested braces, and garbage data.
 * Returns an array of parsed JSON objects.
 */
function parseFrames(chunk) {
  buffer += chunk;

  // Overflow guard
  if (buffer.length > BUFFER_MAX) {
    console.warn('[serial] Buffer overflow, discarding', buffer.length, 'bytes');
    store.log('warning', `Serial buffer overflow (${buffer.length} bytes) — data discarded`);
    buffer = '';
    return [];
  }

  const results = [];
  let safety = 50; // prevent infinite loop on pathological input

  while (safety-- > 0) {
    // Find first opening brace
    const start = buffer.indexOf('{');
    if (start === -1) {
      buffer = ''; // no JSON anywhere, discard garbage
      break;
    }
    // Discard garbage before the brace
    if (start > 0) buffer = buffer.substring(start);

    // Count braces to find matching close
    let depth = 0;
    let end = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }

    if (end === -1) break; // incomplete frame, wait for more data

    const frame = buffer.substring(0, end + 1);
    buffer = buffer.substring(end + 1);

    try {
      const obj = JSON.parse(frame);
      results.push(obj);
    } catch (e) {
      console.warn('[serial] JSON parse error, discarding frame:', frame.substring(0, 80));
    }
  }

  return results;
}

/* ---------- Read Loop ---------- */

async function readLoop() {
  readLoopActive = true;
  const decoder = new TextDecoder();

  while (readLoopActive && port?.readable) {
    try {
      reader = port.readable.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        const frames = parseFrames(text);
        for (const obj of frames) {
          store.setData(obj);
        }
        if (frames.length) lastFrameAt = Date.now();
      }
    } catch (err) {
      if (readLoopActive) {
        console.error('[serial] Read error:', err);
        store.log('error', `Serial read error: ${err.message}`);
        recordIncident('serial-read-error', 'error', `Serial read failed: ${err.message}`, errorDetails(err));
        store.setConnection('ERROR');
      }
    } finally {
      try { reader?.releaseLock(); } catch (_) { /* ignore */ }
      reader = null;
    }
    // If we get here and readLoop is still active, the stream ended unexpectedly
    if (readLoopActive) {
      store.log('warning', 'Serial stream ended — device may have disconnected');
      recordIncident('serial-stream-ended', 'warning', 'Serial stream ended unexpectedly.', {
        visibility: pageVisibility(),
        port: portDescription(port)
      });
      await disconnect('unexpected');
      break;
    }
  }
}

/* ---------- Polling ---------- */

function startPolling() {
  stopPolling();
  lastFrameAt = Date.now(); // reset the stale clock so the watchdog doesn't fire before the first frame
  send('{"GET":"ALL"}'); // immediate first poll so telemetry populates without waiting a full interval
  pollTimer = setInterval(() => {
    send('{"GET":"ALL"}');
  }, pollIntervalMs);
  // Watchdog: a soft reset / power-cycle can leave the USB CDC port open but silent, so no
  // 'disconnect' event or read error ever fires. If telemetry goes quiet, force a reconnect.
  staleWatchdogTimer = setInterval(() => {
    if (store.connection === 'CONNECTED' && isTelemetryStale(lastFrameAt, Date.now(), STALE_TELEMETRY_MS)) {
      store.log('warning', 'No telemetry for 8 s — controller may have reset; reconnecting…');
      recordIncident('telemetry-stale', 'warning', 'No valid telemetry frame arrived for 8 seconds; reconnect requested.', {
        lastFrameAgeMs: Date.now() - lastFrameAt,
        visibility: pageVisibility(),
        port: portDescription(port)
      });
      disconnect('unexpected');
    }
  }, 2000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (staleWatchdogTimer) { clearInterval(staleWatchdogTimer); staleWatchdogTimer = null; }
}


/* ---------- Auto-reconnect ---------- */

function attachDisconnectListener() {
  // A reopened port object is reused across reconnects, so guard against stacking
  // duplicate handlers (each would fire its own disconnect on the next drop).
  if (!port || port.__idsDisconnectBound) return;
  port.__idsDisconnectBound = true;
  port.addEventListener('disconnect', () => {
    store.log('warning', 'USB device disconnected');
    recordIncident('usb-disconnected', 'error', 'The browser reported that the USB serial device was physically/logically disconnected.', {
      visibility: pageVisibility(),
      port: portDescription(port)
    });
    disconnect('unexpected');
  });
}

/** Write straight to the port, bypassing the CONNECTED gate in send(). */
async function writeRaw(jsonStr) {
  if (!writer) throw new Error('no writer');
  await writer.write(new TextEncoder().encode(jsonStr + '\n'));
}

/**
 * Prove the reopened link works in both directions before declaring CONNECTED.
 * After a power-cycle the browser can reopen a stale port handle that accepts open()
 * but never carries traffic — which previously surfaced as "connected but nothing works".
 */
function probeLink(timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(value);
    };
    const off = store.on('data', () => finish(true));
    const timer = setTimeout(() => finish(false), timeoutMs);
    writeRaw('{"GET":"ALL"}').catch(() => finish(false));
  });
}

function cancelReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempts = 0;
}

function beginAutoReconnect() {
  if (store.connection !== 'RECONNECTING') {
    store.setConnection('RECONNECTING');
    store.log('info', 'Controller lost — attempting to reconnect (telemetry only)…');
    recordIncident('reconnect-started', 'warning', 'Automatic serial reconnection started.', { visibility: pageVisibility() });
  }
  if (reconnectTimer) return; // an attempt is already scheduled
  scheduleReconnect(nextReconnectDelayMs(reconnectAttempts));
}

function scheduleReconnect(delay) {
  reconnectTimer = setTimeout(tryReconnect, delay);
}

async function tryReconnect() {
  reconnectTimer = null;
  if (!autoReconnect) { cancelReconnect(); return; }
  reconnectAttempts += 1;
  recordIncident('reconnect-attempt', 'info', `Serial reconnect attempt ${reconnectAttempts}.`, { visibility: pageVisibility() });
  try {
    const ports = await navigator.serial.getPorts();
    const target = selectReconnectPort(ports, ARDUINO_VENDOR_ID);
    recordIncident('reconnect-ports', 'info', `Reconnect can see ${ports.length} previously authorized serial port(s).`, {
      portCount: ports.length,
      selectedPort: portDescription(target)
    });
    if (target) {
      port = target;
      await port.open({ baudRate: BAUD_RATE });
      writer = port.writable.getWriter();
      buffer = '';
      attachDisconnectListener();
      readLoopActive = true;
      readLoop().catch(err => console.error('[serial] readLoop exited:', err));
      // Only claim CONNECTED once the controller actually answers; otherwise tear the
      // half-open port down and try again, instead of sitting in a dead "connected" state.
      const alive = await probeLink(LINK_PROBE_TIMEOUT_MS);
      if (!alive) throw new Error('port reopened but the controller did not respond');
      store.setConnection('CONNECTED');
      store.log('info', `Reconnected at ${BAUD_RATE} baud (attempt ${reconnectAttempts})`);
      recordIncident('reconnect-success', 'info', `Serial reconnection succeeded on attempt ${reconnectAttempts}.`, {
        port: portDescription(port),
        visibility: pageVisibility()
      });
      reconnectAttempts = 0;
      startPolling();
      return;
    }
  } catch (err) {
    recordIncident('reconnect-failed', 'warning', `Serial reconnect attempt ${reconnectAttempts} failed: ${err.message}`, {
      ...errorDetails(err),
      visibility: pageVisibility(),
      port: portDescription(port)
    });
    readLoopActive = false;
    try { reader?.cancel(); } catch (_) { /* ignore */ }
    reader = null;
    try { writer?.releaseLock(); } catch (_) { /* ignore */ }
    writer = null;
    try { await port?.close(); } catch (_) { /* ignore */ }
    port = null;
  }
  // After several failed attempts the re-enumerated device may not be re-offered by the
  // browser (a power-cycle can require re-granting the port). Nudge the user once.
  if (reconnectAttempts === 5) {
    store.log('warning', 'Auto-reconnect is still trying. If the controller was power-cycled, click Connect to re-grant the USB port.');
  }
  if (autoReconnect) scheduleReconnect(nextReconnectDelayMs(reconnectAttempts));
}

/* ---------- Public API ---------- */

export async function connect() {
  if (store.connection === 'CONNECTED' || store.connection === 'CONNECTING') return;

  autoReconnect = true;
  cancelReconnect();
  store.setConnection('CONNECTING');
  store.log('info', 'Requesting serial port...');
  recordIncident('serial-request', 'info', 'Operator requested a serial connection.', { visibility: pageVisibility() });

  try {
    port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: ARDUINO_VENDOR_ID }]
    });
    recordIncident('serial-port-selected', 'info', 'A serial device was selected.', { port: portDescription(port) });

    await port.open({ baudRate: BAUD_RATE });
    writer = port.writable.getWriter();

    store.setConnection('CONNECTED');
    store.log('info', `Connected at ${BAUD_RATE} baud`);
    recordIncident('serial-connected', 'info', `Serial port opened at ${BAUD_RATE} baud.`, { port: portDescription(port) });

    buffer = ''; // reset parser buffer on new connection
    readLoop().catch(err => console.error('[serial] readLoop exited:', err));
    startPolling();

    attachDisconnectListener();

  } catch (err) {
    console.error('[serial] Connect error:', err);
    store.log('error', `Connection failed: ${err.message}`);
    recordIncident('serial-connect-failed', 'error', `Serial connection failed: ${err.message}`, {
      ...errorDetails(err),
      port: portDescription(port),
      visibility: pageVisibility()
    });
    store.setConnection('DISCONNECTED');
    port = null;
  }
}

export async function disconnect(reason = 'manual') {
  recordIncident('serial-disconnect', reason === 'manual' ? 'info' : 'warning', `Serial disconnect cleanup started (${reason}).`, {
    reason,
    connection: store.connection,
    visibility: pageVisibility(),
    port: portDescription(port)
  });
  readLoopActive = false;
  stopPolling();

  try { writer?.releaseLock(); } catch (_) { /* ignore */ }
  writer = null;

  try { reader?.cancel(); } catch (_) { /* ignore */ }
  try { reader?.releaseLock(); } catch (_) { /* ignore */ }
  reader = null;

  try { await port?.close(); } catch (_) { /* ignore */ }
  port = null;

  buffer = '';

  if (reason === 'manual') {
    autoReconnect = false;
    cancelReconnect();
  }

  if (shouldAutoReconnect(reason, autoReconnect)) {
    store.emit('disconnect-reason', reason);
    beginAutoReconnect();
    return;
  }

  cancelReconnect();
  if (store.connection !== 'DISCONNECTED') {
    store.emit('disconnect-reason', reason);
    store.setConnection('DISCONNECTED');
    store.log('info', 'Disconnected');
  }
}

/**
 * Send a JSON string to the firmware.
 * Appends newline terminator automatically.
 */
export async function send(jsonStr) {
  if (store.simulationActive) return handleSimulatedCommand(jsonStr);
  if (!writer || store.connection !== 'CONNECTED') {
    console.warn('[serial] Cannot send — not connected');
    return false;
  }
  try {
    const encoder = new TextEncoder();
    await writer.write(encoder.encode(jsonStr + '\n'));
    store.emit('command-sent', jsonStr);
    return true;
  } catch (err) {
    console.error('[serial] Send error:', err);
    store.log('error', `Send error: ${err.message}`);
    recordIncident('serial-write-error', 'error', `Serial write failed: ${err.message}`, errorDetails(err));
    return false;
  }
}

/** Check if Web Serial API is available */
export function isSerialSupported() {
  return 'serial' in navigator;
}

export function getPollIntervalMs() {
  return pollIntervalMs;
}

export function getNominalPollIntervalMs() {
  return NOMINAL_POLL_INTERVAL_MS;
}

export function setPollIntervalMs(ms) {
  const parsed = parseInt(ms, 10);
  if (!Number.isFinite(parsed)) return pollIntervalMs;
  const next = Math.max(POLL_INTERVAL_MIN_MS, Math.min(POLL_INTERVAL_MAX_MS, parsed));
  if (next === pollIntervalMs) return pollIntervalMs;
  pollIntervalMs = next;
  if (store.connection === 'CONNECTED') startPolling();
  store.log('info', `Data polling interval set to ${pollIntervalMs} ms`);
  return pollIntervalMs;
}

// Cleanup on page unload
// Reconnect immediately when a previously-granted device re-appears on the USB bus.
if (typeof navigator !== 'undefined' && navigator.serial?.addEventListener) {
  navigator.serial.addEventListener('connect', event => {
    recordIncident('usb-connected', 'info', 'The browser reported that a serial USB device appeared.', {
      port: portDescription(event.target),
      connection: store.connection,
      visibility: pageVisibility()
    });
    if (store.connection === 'RECONNECTING' && autoReconnect) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      tryReconnect();
    }
  });
}

function portDescription(target) {
  if (!target) return 'none';
  try {
    const info = target.getInfo?.() || {};
    const vid = Number.isFinite(info.usbVendorId) ? `0x${info.usbVendorId.toString(16).padStart(4, '0')}` : 'unknown';
    const pid = Number.isFinite(info.usbProductId) ? `0x${info.usbProductId.toString(16).padStart(4, '0')}` : 'unknown';
    return `VID ${vid}, PID ${pid}, attached ${typeof target.connected === 'boolean' ? target.connected : 'unknown'}`;
  } catch (_) { return 'unavailable'; }
}

function errorDetails(error) {
  return { errorName: error?.name || 'Error', errorMessage: error?.message || String(error || 'unknown') };
}

function pageVisibility() { return typeof document !== 'undefined' ? document.visibilityState : 'unknown'; }

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    autoReconnect = false;
    cancelReconnect();
    readLoopActive = false;
    stopPolling();
    try { port?.close(); } catch (_) { /* ignore */ }
  });
}

/* Transport interface implementation for the Web Serial path (see js/transport.js). */
export const SerialTransport = {
  id: 'serial',
  connect, disconnect, send,
  isSupported: isSerialSupported,
  getPollIntervalMs, getNominalPollIntervalMs, setPollIntervalMs,
};
