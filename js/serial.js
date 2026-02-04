/* ===== serial.js — Web Serial API layer ===== */

import store from './state.js';

const BAUD_RATE = 115200;
const ARDUINO_VENDOR_ID = 0x2341;
const BUFFER_MAX = 8192; // 8 KB overflow guard
const POLL_INTERVAL_MS = 1000;

let port = null;
let reader = null;
let writer = null;
let readLoopActive = false;
let pollTimer = null;

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
      }
    } catch (err) {
      if (readLoopActive) {
        console.error('[serial] Read error:', err);
        store.log('error', `Serial read error: ${err.message}`);
        store.setConnection('ERROR');
      }
    } finally {
      try { reader?.releaseLock(); } catch (_) { /* ignore */ }
      reader = null;
    }
    // If we get here and readLoop is still active, the stream ended unexpectedly
    if (readLoopActive) {
      store.log('warning', 'Serial stream ended — device may have disconnected');
      await disconnect();
      break;
    }
  }
}

/* ---------- Polling ---------- */

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    send('{"GET":"ALL"}');
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/* ---------- Public API ---------- */

export async function connect() {
  if (store.connection === 'CONNECTED' || store.connection === 'CONNECTING') return;

  store.setConnection('CONNECTING');
  store.log('info', 'Requesting serial port...');

  try {
    port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: ARDUINO_VENDOR_ID }]
    });

    await port.open({ baudRate: BAUD_RATE });
    writer = port.writable.getWriter();

    store.setConnection('CONNECTED');
    store.log('info', `Connected at ${BAUD_RATE} baud`);

    buffer = ''; // reset parser buffer on new connection
    readLoop().catch(err => console.error('[serial] readLoop exited:', err));
    startPolling();

    // Listen for disconnect
    port.addEventListener('disconnect', () => {
      store.log('warning', 'USB device disconnected');
      disconnect();
    });

  } catch (err) {
    console.error('[serial] Connect error:', err);
    store.log('error', `Connection failed: ${err.message}`);
    store.setConnection('DISCONNECTED');
    port = null;
  }
}

export async function disconnect() {
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

  if (store.connection !== 'DISCONNECTED') {
    store.setConnection('DISCONNECTED');
    store.log('info', 'Disconnected');
  }
}

/**
 * Send a JSON string to the firmware.
 * Appends newline terminator automatically.
 */
export async function send(jsonStr) {
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
    return false;
  }
}

/** Check if Web Serial API is available */
export function isSerialSupported() {
  return 'serial' in navigator;
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  readLoopActive = false;
  stopPolling();
  try { port?.close(); } catch (_) { /* ignore */ }
});
