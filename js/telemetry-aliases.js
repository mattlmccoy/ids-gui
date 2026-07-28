/* ===== telemetry-aliases.js — reconcile firmware key names with the keys the UI reads =====

   R17 emits some analog readings under bare names (`Vacuum`, `Pressure`) while the GUI —
   charts, tachometers, diagnostics, the plumbing map and the relay — reads the `_STATE`
   form (FIRMWARE_SPEC_R17 §2.4 "GUI ↔ firmware key gaps"). Aliasing once at ingest keeps
   every consumer working without scattering fallbacks through the app. */

/** Bare firmware key -> the `_STATE` key the UI reads. */
const ALIASES = {
  Vacuum: 'Vacuum_STATE',
  Pressure: 'Pressure_STATE'
};

/**
 * Return a frame with bare firmware keys mirrored onto their `_STATE` names.
 * An explicit `_STATE` value already in the frame always wins; raw keys are preserved
 * so the Debug telemetry table still shows exactly what the controller sent.
 */
export function applyTelemetryAliases(frame) {
  if (!frame || typeof frame !== 'object') return frame;
  let result = frame;
  for (const [bare, stateKey] of Object.entries(ALIASES)) {
    const value = frame[bare];
    if (value === undefined || value === null) continue;
    if (frame[stateKey] !== undefined && frame[stateKey] !== null) continue;
    if (result === frame) result = { ...frame };
    result[stateKey] = value;
  }
  return result;
}
