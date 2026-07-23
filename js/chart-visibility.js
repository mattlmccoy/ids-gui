/* Persisted per-chart visibility for the Trends tab. Pure logic; no DOM access. */

export const CHART_IDS = Object.freeze(['temperature', 'pressure', 'states']);

/* Returns a {temperature, pressure, states} boolean map. Every chart is visible
   unless the stored preference explicitly set it to false. Unknown keys are dropped. */
export function normalizeVisibleCharts(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  for (const id of CHART_IDS) result[id] = source[id] !== false;
  return result;
}
