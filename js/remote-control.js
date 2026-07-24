/* ===== remote-control.js — Guarded cloud command consumer ===== */

import store from './state.js';
import { send } from './serial.js';
import { getRemoteAlertConfig } from './notifications.js';
import { validateCommandPayload } from './command-allowlist.js';

const ENABLE_WINDOW_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;
const COMMAND_MAP = {
  run: { key: 'Run_MODE', value: 1, payload: () => '{"Run_MODE":"1"}' },
  stop: { key: 'Run_MODE', value: 0, payload: () => '{"Run_MODE":"0"}' },
  set_vacuum: { key: 'Vacuum_SETPOINT', min: 0, max: 100, payload: value => `{"Vacuum_SETPOINT":"${value}"}` },
  set_flow: { key: 'Flow_SETPOINT', min: 0, max: 100, payload: value => `{"Flow_SETPOINT":"${value}"}` },
  set_temperature: { key: 'Temperature_SETPOINT', min: 0, max: 70, payload: value => `{"Temperature_SETPOINT":"${value}"}` }
};

let enabledUntil = 0;
let polling = false;
let pollTimer = null;

export function initRemoteControl() {
  if (pollTimer) return;
  pollTimer = setInterval(pollCommands, POLL_INTERVAL_MS);
  store.on('connection', state => {
    if (state !== 'CONNECTED') disableRemoteControl('Controller disconnected');
  });
  window.addEventListener('beforeunload', () => clearInterval(pollTimer), { once: true });
  emitState();
}

export function enableRemoteControl() {
  const config = getRemoteAlertConfig();
  if (store.connection !== 'CONNECTED') throw new Error('Connect the IDS controller first');
  if (!config.enabled || !config.workerUrl || !config.deviceToken || !config.deviceId) {
    throw new Error('Save and enable Remote Alerts first');
  }
  enabledUntil = Date.now() + ENABLE_WINDOW_MS;
  store.log('warning', 'Remote control enabled locally for 30 minutes');
  emitState();
  void pollCommands();
  return getRemoteControlState();
}

export function disableRemoteControl(reason = 'Disabled locally') {
  if (!enabledUntil) return getRemoteControlState();
  enabledUntil = 0;
  store.log('info', `Remote control disabled: ${reason}`);
  emitState();
  return getRemoteControlState();
}

export function getRemoteControlState() {
  const active = enabledUntil > Date.now() && store.connection === 'CONNECTED';
  if (!active && enabledUntil) enabledUntil = 0;
  return { active, enabledUntil: active ? enabledUntil : 0 };
}

async function pollCommands() {
  const latch = getRemoteControlState();
  if (!latch.active || polling) return;
  const config = getRemoteAlertConfig();
  if (!config.enabled) return;
  polling = true;
  try {
    const response = await deviceApi(config, `/api/v1/commands?deviceId=${encodeURIComponent(config.deviceId)}`, { method: 'GET' });
    for (const command of response.commands || []) await processCommand(config, command);
  } catch (error) {
    store.log('error', `Remote command poll failed: ${error.message}`);
  } finally {
    polling = false;
    emitState();
  }
}

async function processCommand(config, command) {
  if (!getRemoteControlState().active) return;

  let payload = null;
  let key = null;
  let value = null;
  if (command.command_type === 'payload') {
    const check = validateCommandPayload(command.command_payload || '');
    if (!check.ok) return rejectWithoutClaim(config, command.id, `Payload rejected: ${check.error}`);
    payload = command.command_payload;
    key = check.key; value = check.value;
  } else {
    const definition = COMMAND_MAP[command.command_type];
    if (!definition) return rejectWithoutClaim(config, command.id, 'Command type is not allowed by this desktop');
    value = definition.min === undefined ? definition.value : Number(command.command_value);
    if (definition.min !== undefined && (!Number.isFinite(value) || value < definition.min || value > definition.max)) {
      return rejectWithoutClaim(config, command.id, 'Command value is outside the desktop safety range');
    }
    payload = definition.payload(value); key = definition.key;
  }

  try {
    await deviceApi(config, `/api/v1/commands/${encodeURIComponent(command.id)}/claim`, { method: 'POST', body: '{}' });
  } catch (error) {
    if (!String(error.message).includes('409')) store.log('warning', `Could not claim remote command: ${error.message}`);
    return;
  }
  if (!getRemoteControlState().active || store.connection !== 'CONNECTED') {
    return acknowledge(config, command.id, 'rejected', 'Local remote-control window closed before execution');
  }
  const written = await send(payload);
  if (!written) return acknowledge(config, command.id, 'rejected', 'Serial write failed');
  // Reads (GET) have no single readback key to confirm.
  if (key === 'GET') return acknowledge(config, command.id, 'executed', 'Read command sent');
  const confirmed = await waitForReadback(key, value, 4000);
  const message = confirmed
    ? `${key} readback confirmed at ${value}`
    : `${key} command written, but readback was not confirmed within 4 seconds`;
  store.log(confirmed ? 'command' : 'warning', `Remote: ${message}`);
  await acknowledge(config, command.id, 'executed', message);
}

async function rejectWithoutClaim(config, id, message) {
  try {
    await deviceApi(config, `/api/v1/commands/${encodeURIComponent(id)}/claim`, { method: 'POST', body: '{}' });
    await acknowledge(config, id, 'rejected', message);
  } catch (_) { /* another consumer or expiry won the claim */ }
}

async function acknowledge(config, id, status, message) {
  return deviceApi(config, `/api/v1/commands/${encodeURIComponent(id)}/ack`, {
    method: 'POST', body: JSON.stringify({ status, message })
  });
}

function waitForReadback(key, expected, timeoutMs) {
  if (matches(store.data[key], expected)) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const off = store.on('data', data => {
      if (!matches(data[key], expected) || settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(true);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      resolve(false);
    }, timeoutMs);
  });
}

function matches(actual, expected) {
  const a = Number(actual);
  const b = Number(expected);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.001;
}

async function deviceApi(config, path, options) {
  const response = await fetch(`${config.workerUrl}${path}`, {
    ...options,
    headers: { 'Authorization': `Bearer ${config.deviceToken}`, 'Content-Type': 'application/json' }
  });
  let result = {};
  try { result = await response.json(); } catch (_) { /* use status */ }
  if (!response.ok) throw new Error(`${result.error || 'Worker error'} (${response.status})`);
  return result;
}

function emitState() {
  store.emit('remote-control', getRemoteControlState());
}
