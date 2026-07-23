/* Shared operating-mode definitions and safe command planning. */

export const MODE_KEYS = ['Run_MODE', 'Purge_MODE', 'Flush_MODE', 'Drain_MODE', 'Bypass_MODE'];
export const MAINTENANCE_MODE_KEYS = ['Purge_MODE', 'Flush_MODE', 'Drain_MODE'];
export const GUI_AUTO_OFF_DEFAULTS = {
  Purge_MODE: 30,
  Drain_MODE: 60,
  Bypass_MODE: 120
};
export const GUI_AUTO_OFF_OPTIONS = [0, 15, 30, 60, 120, 300];

export const MODE_DEFINITIONS = {
  Purge_MODE: {
    label: 'Purge', durationSeconds: null,
    purpose: 'Pulse the recirculation path while the system is stopped.',
    outputs: ['Recirculation pump (100 ms pulses)', 'Input pump (conditional)'],
    use: 'Line preparation or clearing only after verifying the physical hose route and waste destination.',
    warning: 'R17 does not independently open the flush or drain hardware. The 1 s dashboard poll can miss its short pulses.'
  },
  Flush_MODE: {
    label: 'Flush', durationSeconds: 5,
    purpose: 'Run the dedicated flush pump and flush valve for a timed cleaning cycle.',
    outputs: ['Flush pump', 'Flush valve'],
    use: 'Cleaning with compatible flush fluid connected and waste safely routed.',
    warning: 'Known R17 firmware defect: the five-second timer is not reset when a new cycle starts, so this command may clear immediately.'
  },
  Drain_MODE: {
    label: 'Drain', durationSeconds: null,
    purpose: 'Open both manifold valves and run the drain pump while stopped.',
    outputs: ['Drain pump', 'Manifold valve 1', 'Manifold valve 2'],
    use: 'Emptying the verified manifold path before service or a fluid change.',
    warning: 'The firmware commands DrainValve_STATE OFF in this mode. Verify the real hose destination before use.'
  },
  Bypass_MODE: {
    label: 'Bypass', durationSeconds: null,
    purpose: 'Hold the bypass valve open independently of Run and the other maintenance modes.',
    outputs: ['Bypass valve'],
    use: 'Diagnostics or a procedure that explicitly calls for the verified bypass path.',
    warning: 'Persistent mode: it can remain active during Run and has no firmware timeout.'
  }
};

export function allModesOffCommands() {
  return MODE_KEYS.map(key => JSON.stringify({ [key]: '0' }));
}

export function activeMaintenanceMode(data = {}, excluding = '') {
  return MAINTENANCE_MODE_KEYS.find(key => key !== excluding && Number(data[key]) === 1) || null;
}

export function modeReadbackMatches(data, key, expected) {
  return data?.[key] !== undefined && Number(data[key]) === Number(expected);
}

export function formatCountdown(milliseconds) {
  const seconds = Math.max(0, Math.ceil(Number(milliseconds) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function normalizeAutoOffSeconds(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return GUI_AUTO_OFF_OPTIONS.includes(parsed) ? parsed : fallback;
}
