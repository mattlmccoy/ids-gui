/* ===== notifications.js — Local + remote alert state machine ===== */

import store from './state.js';
import { getFloatDisplayState } from './float-state.js';
import { decodeAlarmStatus, isActiveError } from './errors.js';
import { shouldSuppressHeaterError } from './heater-visibility.js';

const LOCAL_ENABLED_KEY = 'ids-weir-ovf-notifications';
const REMOTE_CONFIG_KEY = 'ids-remote-alert-config-v1';
const DEFAULT_CONFIG = {
  enabled: false,
  workerUrl: 'https://ids-alert-relay.mattlmccoy.workers.dev',
  deviceToken: '',
  ntfyTopic: '',
  deviceId: '',
  debounceSeconds: 3,
  staleAfterSeconds: 15
};
const TELEMETRY_KEYS = [
  'SystemID', 'SoftwareRev', 'AlarmStatus', 'ErrorCode_STATE',
  'Run_MODE', 'Purge_MODE', 'Flush_MODE', 'Drain_MODE', 'Bypass_MODE',
  'Vacuum_STATE', 'Pressure_STATE', 'FluidTemperature_STATE',
  'MainHeaterTemperature_STATE', 'AUXHeaterTemperature_STATE',
  'SupplyFloat_STATE', 'WeirFloat_STATE', 'WasteFloat_STATE',
  'SupplyOverflowFloat_STATE', 'WeirOverflowFloat_STATE', 'FlushFloat_STATE', 'ServiceFloat_STATE'
];
const TELEMETRY_INTERVAL_MS = 2000;
const FLOAT_TELEMETRY_KEYS = new Set([
  'SupplyFloat_STATE', 'WeirFloat_STATE', 'WasteFloat_STATE',
  'SupplyOverflowFloat_STATE', 'WeirOverflowFloat_STATE', 'FlushFloat_STATE', 'ServiceFloat_STATE'
]);

let previousWeirState = null;
let previousSupplyOverflowState = null;
let lastDataAt = 0;
let staleTimer = null;
let lastDisconnectReason = 'unknown';
let lastTelemetrySentAt = 0;
let telemetryTimer = null;
let telemetrySending = false;
let lastTelemetryErrorAt = 0;
const conditions = new Map();

export function areWeirOverflowNotificationsEnabled() {
  try { return localStorage.getItem(LOCAL_ENABLED_KEY) === 'true'; } catch (_) { return false; }
}

export async function setWeirOverflowNotificationsEnabled(enabled) {
  let value = !!enabled;
  if (value && 'Notification' in window && Notification.permission !== 'granted') {
    const permission = await Notification.requestPermission();
    value = permission === 'granted';
    if (!value) store.log('warning', 'Desktop notification permission was not granted');
  }
  try { localStorage.setItem(LOCAL_ENABLED_KEY, String(value)); } catch (_) { /* ignore */ }
  store.emit('notification-config', { weirOverflow: value, remote: getRemoteAlertConfig() });
  return value;
}

export function getRemoteAlertConfig() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(REMOTE_CONFIG_KEY) || '{}'); } catch (_) { /* ignore */ }
  const config = { ...DEFAULT_CONFIG, ...stored };
  if (!config.deviceId) {
    config.deviceId = `ids-${randomId().slice(0, 12)}`;
    persistRemoteConfig(config);
  }
  config.workerUrl = String(config.workerUrl || '').replace(/\/$/, '');
  config.debounceSeconds = clampNumber(config.debounceSeconds, 0, 30, 3);
  config.staleAfterSeconds = clampNumber(config.staleAfterSeconds, 5, 300, 15);
  return config;
}

export function setRemoteAlertConfig(next) {
  const current = getRemoteAlertConfig();
  const config = {
    ...current,
    ...next,
    enabled: !!next.enabled,
    workerUrl: String(next.workerUrl || '').trim().replace(/\/$/, ''),
    deviceToken: String(next.deviceToken || '').trim(),
    ntfyTopic: String(next.ntfyTopic || '').trim().slice(0, 64),
    deviceId: String(next.deviceId || current.deviceId).trim().slice(0, 80),
    debounceSeconds: clampNumber(next.debounceSeconds, 0, 30, 3),
    staleAfterSeconds: clampNumber(next.staleAfterSeconds, 5, 300, 15)
  };
  persistRemoteConfig(config);
  store.emit('notification-config', { weirOverflow: areWeirOverflowNotificationsEnabled(), remote: config });
  return config;
}

export function initNotifications() {
  store.on('data', onData);
  store.on('float-config', () => {
    previousWeirState = null;
    resetCondition('weir_ovf');
    scheduleTelemetry(true);
  });
  store.on('error', onAlarm);
  store.on('heater-visibility', () => onAlarm({ raw: store.alarmRaw }));
  store.on('disconnect-reason', reason => { lastDisconnectReason = reason || 'unknown'; });
  store.on('connection', onConnection);
  staleTimer = setInterval(checkStaleData, 2000);
  window.addEventListener('beforeunload', () => {
    clearInterval(staleTimer);
    if (telemetryTimer) clearTimeout(telemetryTimer);
  }, { once: true });
}

export async function sendRemoteTestAlert(configOverride) {
  const config = configOverride ? setRemoteAlertConfig(configOverride) : getRemoteAlertConfig();
  validateRemoteConfig(config, false);
  return postRemoteEvent('test', 'Manual test sent from IDS alert settings.', config);
}

async function onData(data) {
  if (store.replayActive) return;
  lastDataAt = Date.now();
  scheduleTelemetry();
  if (store.connection === 'CONNECTED') {
    transitionCondition('data_stale', false, 'data_stale', 'data_recovered');
  }

  if (data.WeirOverflowFloat_STATE !== undefined) {
    const state = getFloatDisplayState('WeirOverflowFloat_STATE', data.WeirOverflowFloat_STATE);
    if (state !== null) {
      if (previousWeirState === null) {
        if (!conditions.has('weir_ovf')) establishCondition('weir_ovf', false);
        if (state === 1) {
          showLocalWeirAlert(data);
          transitionCondition('weir_ovf', true, 'weir_ovf_active', 'weir_ovf_recovered');
        } else {
          transitionCondition('weir_ovf', false, 'weir_ovf_active', 'weir_ovf_recovered');
        }
      } else if (state !== previousWeirState) {
        if (previousWeirState === 0 && state === 1) showLocalWeirAlert(data);
        transitionCondition('weir_ovf', state === 1, 'weir_ovf_active', 'weir_ovf_recovered');
      }
      previousWeirState = state;
    }
  }

  if (data.SupplyOverflowFloat_STATE !== undefined) {
    const state = getFloatDisplayState('SupplyOverflowFloat_STATE', data.SupplyOverflowFloat_STATE);
    if (state !== null) {
      if (previousSupplyOverflowState === null) {
        if (!conditions.has('supply_ovf')) establishCondition('supply_ovf', false);
        transitionCondition('supply_ovf', state === 1, 'supply_ovf_active', 'supply_ovf_recovered');
      } else if (state !== previousSupplyOverflowState) {
        transitionCondition('supply_ovf', state === 1, 'supply_ovf_active', 'supply_ovf_recovered');
      }
      previousSupplyOverflowState = state;
    }
  }
}

function onAlarm({ raw } = {}) {
  if (store.replayActive) return;
  const decoded = decodeAlarmStatus(raw);
  const active = isActiveError(decoded.error.code) && !shouldSuppressHeaterError(decoded.error.code, raw);
  if (!conditions.has('firmware_alarm')) establishCondition('firmware_alarm', false);
  const activeMessage = active
    ? `Firmware reported ${decoded.error.code}: ${decoded.error.title}. ${decoded.error.action}`
    : null;
  transitionCondition(
    'firmware_alarm', active, 'firmware_alarm_active', 'firmware_alarm_recovered',
    activeMessage, 'The IDS firmware alarm returned to NO_ERROR.'
  );
}

function onConnection(state) {
  scheduleTelemetry(true);
  if (state === 'CONNECTED') {
    lastDataAt = Date.now();
    transitionCondition('controller_connection', false, 'controller_disconnected', 'controller_reconnected');
    transitionCondition('data_stale', false, 'data_stale', 'data_recovered');
    lastDisconnectReason = 'unknown';
    return;
  }
  if (state === 'DISCONNECTED') {
    previousWeirState = null;
    previousSupplyOverflowState = null;
    transitionCondition('data_stale', false, 'data_stale', 'data_recovered');
    if (lastDisconnectReason === 'unexpected') {
      transitionCondition('controller_connection', true, 'controller_disconnected', 'controller_reconnected');
    } else {
      establishCondition('controller_connection', false);
    }
  }
}

function scheduleTelemetry(immediate = false) {
  const config = getRemoteAlertConfig();
  if (!config.enabled || !config.workerUrl || !config.deviceToken) return;
  if (telemetryTimer) clearTimeout(telemetryTimer);
  const elapsed = Date.now() - lastTelemetrySentAt;
  const delay = immediate ? 0 : Math.max(0, TELEMETRY_INTERVAL_MS - elapsed);
  telemetryTimer = setTimeout(() => {
    telemetryTimer = null;
    void postTelemetrySnapshot(config);
  }, delay);
}

async function postTelemetrySnapshot(config) {
  if (telemetrySending) return scheduleTelemetry();
  telemetrySending = true;
  const telemetry = {};
  for (const key of TELEMETRY_KEYS) {
    if (store.data[key] === undefined) continue;
    telemetry[key] = FLOAT_TELEMETRY_KEYS.has(key)
      ? getFloatDisplayState(key, store.data[key])
      : store.data[key];
  }
  try {
    const response = await fetch(`${config.workerUrl}/api/v1/telemetry`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.deviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: config.deviceId,
        systemId: store.data.SystemID || null,
        connection: store.connection,
        sourceTime: new Date().toISOString(),
        telemetry
      })
    });
    if (!response.ok) throw new Error(`telemetry relay returned HTTP ${response.status}`);
    lastTelemetrySentAt = Date.now();
  } catch (error) {
    if (Date.now() - lastTelemetryErrorAt > 60_000) {
      store.log('error', `Remote status update failed: ${error.message}`);
      lastTelemetryErrorAt = Date.now();
    }
  } finally {
    telemetrySending = false;
  }
}

function checkStaleData() {
  if (store.connection !== 'CONNECTED' || !lastDataAt) return;
  const config = getRemoteAlertConfig();
  const stale = Date.now() - lastDataAt >= config.staleAfterSeconds * 1000;
  transitionCondition('data_stale', stale, 'data_stale', 'data_recovered');
}

function establishCondition(key, active) {
  const existing = conditions.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  conditions.set(key, { observed: !!active, sentActive: existing?.sentActive || false, timer: null });
}

function resetCondition(key) {
  const state = conditions.get(key);
  if (state?.timer) clearTimeout(state.timer);
  conditions.delete(key);
}

function transitionCondition(key, active, activeType, recoveredType, activeMessage = null, recoveredMessage = null) {
  const value = !!active;
  const existing = conditions.get(key);
  if (!existing) {
    establishCondition(key, value);
    return;
  }
  if (existing.observed === value) return;
  if (existing.timer) clearTimeout(existing.timer);
  existing.observed = value;
  existing.timer = null;

  if (!value && !existing.sentActive) return;
  const config = getRemoteAlertConfig();
  if (!config.enabled) return;
  const delay = config.debounceSeconds * 1000;
  existing.timer = setTimeout(async () => {
    existing.timer = null;
    if (existing.observed !== value) return;
    try {
      await postRemoteEvent(value ? activeType : recoveredType, value ? activeMessage : recoveredMessage, config);
      existing.sentActive = value;
      store.log(value ? 'warning' : 'info', `Remote alert sent: ${value ? activeType : recoveredType}`);
    } catch (error) {
      store.log('error', `Remote alert failed: ${error.message}`);
    }
  }, delay);
}

function showLocalWeirAlert(data) {
  if (!areWeirOverflowNotificationsEnabled()) return;
  const systemId = data.SystemID ? ` on ${data.SystemID}` : '';
  const message = `Weir overflow float activated${systemId}.`;
  store.log('warning', message);
  if ('Notification' in window && Notification.permission === 'granted') {
    const notice = new Notification('IDS Weir OVF Alert', {
      body: `${message} Check the ink delivery system.`,
      tag: 'ids-weir-overflow',
      requireInteraction: true
    });
    notice.onclick = () => window.focus();
  }
}

async function postRemoteEvent(type, message, config = getRemoteAlertConfig()) {
  validateRemoteConfig(config, type !== 'test');
  const body = {
    type,
    deviceId: config.deviceId,
    systemId: store.data.SystemID || null,
    sourceTime: new Date().toISOString(),
    message: message || undefined
  };
  const response = await fetch(`${config.workerUrl}/api/v1/events`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.deviceToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomId()
    },
    body: JSON.stringify(body)
  });
  let result = {};
  try { result = await response.json(); } catch (_) { /* use HTTP error below */ }
  if (!response.ok) throw new Error(result.error || `relay returned HTTP ${response.status}`);
  if (result.event?.notification_status === 'failed' && config.ntfyTopic) {
    await publishDirectNtfy(type, body, config);
    const deliveryResponse = await fetch(`${config.workerUrl}/api/v1/events/${encodeURIComponent(result.event.id)}/delivery`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.deviceToken}`, 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (deliveryResponse.ok) {
      const deliveryResult = await deliveryResponse.json();
      result.event = deliveryResult.event;
    } else {
      result.event.notification_status = 'sent-direct';
    }
    result.directFallback = true;
  }
  return result;
}

async function publishDirectNtfy(type, body, config) {
  const definition = {
    weir_ovf_active: ['IDS Weir OVF activated', '5', 'rotating_light,droplet'],
    weir_ovf_recovered: ['IDS Weir OVF cleared', '3', 'white_check_mark,droplet'],
    supply_ovf_active: ['IDS Supply OVF activated', '5', 'rotating_light,droplet'],
    supply_ovf_recovered: ['IDS Supply OVF cleared', '3', 'white_check_mark,droplet'],
    firmware_alarm_active: ['IDS firmware alarm', '5', 'rotating_light,warning'],
    firmware_alarm_recovered: ['IDS firmware alarm cleared', '3', 'white_check_mark,wrench'],
    controller_disconnected: ['IDS controller disconnected', '4', 'warning,electric_plug'],
    controller_reconnected: ['IDS controller reconnected', '3', 'white_check_mark,electric_plug'],
    data_stale: ['IDS data stream is stale', '4', 'warning,hourglass'],
    data_recovered: ['IDS data stream recovered', '3', 'white_check_mark,chart_with_upwards_trend'],
    test: ['IDS test notification', '3', 'test_tube,white_check_mark']
  }[type];
  const location = body.systemId || body.deviceId;
  const defaultMessages = {
    weir_ovf_active: `Weir overflow float activated on ${location}. Check the ink delivery system.`,
    weir_ovf_recovered: `Weir overflow float returned to normal on ${location}.`,
    supply_ovf_active: `Supply overflow float activated on ${location}. Check the ink supply immediately.`,
    supply_ovf_recovered: `Supply overflow float returned to normal on ${location}.`,
    firmware_alarm_active: `The IDS firmware reported an active alarm on ${location}. Check the controller.`,
    firmware_alarm_recovered: `The IDS firmware alarm cleared on ${location}.`,
    controller_disconnected: `The IDS controller disconnected from ${location}.`,
    controller_reconnected: `The IDS controller reconnected to ${location}.`,
    data_stale: `No fresh IDS telemetry has been received from ${location}.`,
    data_recovered: `IDS telemetry resumed from ${location}.`,
    test: `Test alert received from ${location}. Direct ntfy fallback is working.`
  };
  // JSON publishing at the root keeps this a CORS "simple request" (no custom
  // headers/preflight), which is required for direct browser fallback.
  const response = await fetch('https://ntfy.sh/', {
    method: 'POST',
    body: JSON.stringify({
      topic: config.ntfyTopic,
      title: definition[0],
      priority: Number(definition[1]),
      tags: definition[2].split(','),
      click: 'https://mattlmccoy.github.io/ids-gui/remote.html',
      message: body.message || defaultMessages[type]
    })
  });
  if (!response.ok) throw new Error(`relay and direct ntfy delivery failed (ntfy HTTP ${response.status})`);
}

function validateRemoteConfig(config, requireEnabled) {
  if (requireEnabled && !config.enabled) throw new Error('remote alerts are disabled');
  if (!/^https?:\/\//.test(config.workerUrl)) throw new Error('enter a valid Worker URL');
  if (!config.deviceToken) throw new Error('enter the device token');
  if (!config.deviceId) throw new Error('enter a device ID');
}

function persistRemoteConfig(config) {
  try { localStorage.setItem(REMOTE_CONFIG_KEY, JSON.stringify(config)); } catch (_) { /* ignore */ }
}

function randomId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}
