/* ===== notifications.js — Opt-in local overflow notifications ===== */

import store from './state.js';
import { getFloatDisplayState } from './float-state.js';

const ENABLED_KEY = 'ids-weir-ovf-notifications';
let previousState = null;

export function areWeirOverflowNotificationsEnabled() {
  try { return localStorage.getItem(ENABLED_KEY) === 'true'; } catch (_) { return false; }
}

export async function setWeirOverflowNotificationsEnabled(enabled) {
  let value = !!enabled;
  if (value && 'Notification' in window && Notification.permission !== 'granted') {
    const permission = await Notification.requestPermission();
    value = permission === 'granted';
    if (!value) store.log('warning', 'Desktop notification permission was not granted');
  }
  try { localStorage.setItem(ENABLED_KEY, String(value)); } catch (_) { /* ignore */ }
  store.emit('notification-config', { weirOverflow: value });
  return value;
}

export function initNotifications() {
  store.on('data', onData);
  store.on('float-config', () => { previousState = null; });
  store.on('connection', state => {
    if (state === 'DISCONNECTED') previousState = null;
  });
}

function onData(data) {
  if (data.WeirOverflowFloat_STATE === undefined) return;
  const state = getFloatDisplayState('WeirOverflowFloat_STATE', data.WeirOverflowFloat_STATE);
  if (state === null) return;

  // Establish a baseline silently, then notify only on a new OFF -> ON transition.
  if (previousState === 0 && state === 1 && areWeirOverflowNotificationsEnabled()) {
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
  previousState = state;
}
