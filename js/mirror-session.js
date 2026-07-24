/* Mirror session — a laptop paired to a connected desktop stores the target
   device + relay tokens here, and redeems a 4-digit pair code to obtain them. */

const KEY = 'ids-mirror-session-v1';
const DEFAULT_WORKER_URL = 'https://ids-alert-relay.mattlmccoy.workers.dev';

export function getMirrorSession() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    return s && s.deviceId && s.operatorToken ? s : null;
  } catch (_) { return null; }
}

export function clearMirrorSession() { localStorage.removeItem(KEY); }

export async function redeemPairCode(code, workerUrl = DEFAULT_WORKER_URL) {
  const res = await fetch(`${workerUrl}/api/v1/pair/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Pairing failed (${res.status})`);
  const session = {
    workerUrl: data.workerUrl || workerUrl,
    deviceId: data.deviceId,
    viewerToken: data.viewerToken,
    operatorToken: data.operatorToken,
  };
  localStorage.setItem(KEY, JSON.stringify(session));
  return session;
}
