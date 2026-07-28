/* ===== pairing.js — shared "pair a laptop" action for the Operation and Settings tabs =====

   Pairing implies intent to control: handing someone a code and then discovering their
   commands are silently ignored (because the separate 30-minute window was never armed) is
   the confusing failure this module removes. Creating a code arms remote control too. */

import store from './state.js';
import { getRemoteAlertConfig } from './notifications.js';
import { enableRemoteControl } from './remote-control.js';

/**
 * Mint a 4-digit pairing code for a laptop and arm the remote-control window.
 * Returns { code, controlArmed, controlError }. Throws with an operator-readable message.
 */
export async function createPairCode() {
  const cfg = getRemoteAlertConfig();
  if (store.connection !== 'CONNECTED') {
    throw new Error('Connect the USB controller first (Connect button on this page).');
  }
  if (!cfg.workerUrl || !cfg.deviceToken) {
    throw new Error('Set the Worker URL and device token in Settings → Remote alerts first.');
  }

  const res = await fetch(`${cfg.workerUrl}/api/v1/pair`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: cfg.deviceId })
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 404) throw new Error('Pairing endpoint missing — redeploy the cloud relay (wrangler deploy).');
  if (res.status === 401) throw new Error('Device token rejected by the relay — check the token in Settings.');
  if (!res.ok) throw new Error(data.error || `Pairing failed (${res.status})`);

  // Arm control in the same click so the paired laptop can actually drive the machine.
  let controlArmed = false;
  let controlError = '';
  try {
    enableRemoteControl();
    controlArmed = true;
  } catch (error) {
    controlError = error.message;
  }
  return { code: data.code, controlArmed, controlError };
}
