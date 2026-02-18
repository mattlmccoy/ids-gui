const NOMINAL_STORAGE_KEY = 'ids-nominal-config-v1';

export async function loadNominalConfig() {
  const stored = loadStoredNominalConfig();
  if (stored) return stored;

  try {
    const res = await fetch('./nominal-config.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    return normalizeNominal(json);
  } catch (_) {
    return null;
  }
}

export function saveNominalConfig(config) {
  const normalized = normalizeNominal(config);
  try {
    localStorage.setItem(NOMINAL_STORAGE_KEY, JSON.stringify(normalized));
  } catch (_) {
    // ignore storage failures
  }
}

function loadStoredNominalConfig() {
  try {
    const raw = localStorage.getItem(NOMINAL_STORAGE_KEY);
    if (!raw) return null;
    return normalizeNominal(JSON.parse(raw));
  } catch (_) {
    return null;
  }
}

function normalizeNominal(config) {
  if (!config || typeof config !== 'object') return { settings: {}, setpoints: {} };
  return {
    settings: sanitizeObject(config.settings),
    setpoints: sanitizeObject(config.setpoints)
  };
}

function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = String(v);
  }
  return out;
}
