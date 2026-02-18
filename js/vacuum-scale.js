// Vacuum setpoint conversion model:
// 0% -> 0 cmH2O, 100% -> VACUUM_FULL_SCALE_CMH2O (negative vacuum).
export const VACUUM_FULL_SCALE_CMH2O = -70;

export function vacuumPercentToCmH2O(percent) {
  const p = Number(percent);
  if (!Number.isFinite(p)) return null;
  return (p / 100) * VACUUM_FULL_SCALE_CMH2O;
}
