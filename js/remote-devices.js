/* Pure ordering for the remote viewer: show the freshest device first so only the live machine
   leads and older/stale records (the Worker keeps every device that ever reported) fall behind. */

export function orderDevicesByFreshness(devices) {
  if (!Array.isArray(devices)) return [];
  return [...devices].sort((a, b) => timestamp(b) - timestamp(a));
}

function timestamp(device) {
  const t = new Date(device?.updated_at).getTime();
  return Number.isFinite(t) ? t : 0;
}
