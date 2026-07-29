/* Human-readable in-app changelog. Newest entry first.
   Append a new object here for every release so the header "What's new" dropdown stays current. */

export const CHANGELOG = [
  {
    version: '2026-07-29',
    title: 'Workflow navigation',
    items: [
      'Reordered the primary tabs to Operation, Trends, Event Log, Live I/O, Debug, Settings, Commissioning, and Ink Check.',
      'Added persistent, per-machine observed runtime and start counters for the six firmware-reported pumps. The compact table stays collapsed on Debug and never estimates through disconnects, replay, or simulation.',
      'Reduced visual density without removing controls: compact Simple-mode readings, consolidated remote pairing, collapsed remote configuration and system map, and a responsive tab strip.'
    ]
  },
  {
    version: '2026-07-23',
    title: 'Reliability, commissioning, and UI fixes',
    items: [
      'Auto-reconnect: the app now reopens the controller automatically after an unexpected USB drop, resuming telemetry only (no commands re-sent).',
      'Commissioning: fixed the every-second page glitch; a disabled-heater HTC alarm no longer blocks the guided tests.',
      'Commissioning: float checks are observational (no forcing floats), plus new "Skip test" and "Start over" controls.',
      'Connect now populates telemetry immediately instead of waiting a full poll interval.',
      'Heater/HTC alarms from a channel marked "not installed" in Settings are reliably suppressed.',
      'Added a global Simple / Pro switch to the header.',
      'Trends: show or hide each chart (Temperature, Pressure / Vacuum, Floats & State).',
      'The printhead inlet/return pressure feature is hidden everywhere unless enabled in Settings.',
      'Kept the old "Flow" name alongside the "Recirc Drive" label.',
      'The pressure tile is labeled "not measured in R17" so its 0 reading is not mistaken for a fault.',
      'Remote viewer simplified: shows only the live machine (older/stale records collapse behind a toggle), status-first with details collapsed.',
      'Remote viewer no longer shows a heater alarm that is suppressed on the main dashboard.',
      'Added this "What\'s new" dropdown and a human-readable changelog.'
    ]
  },
  {
    version: '2026-07-22',
    title: 'Debug page, plumbing map, and commissioning automation',
    items: [
      'Added the Debug page, an animated plumbing map, and a firmware-backed operating-mode guide.',
      'Integrated commissioning automation into the guided wizard with live evidence plots and safety interlocks.',
      'Added the Ink Check workflow, remote alerts and dashboard, and per-channel heater settings.'
    ]
  }
];

/** Latest (top) entry's version, or null when the list is empty. */
export function latestVersion(entries = CHANGELOG) {
  return entries[0]?.version || null;
}

/** How many entries are newer than the version the operator last viewed (list is newest-first). */
export function unseenCount(entries, lastSeenVersion) {
  if (!Array.isArray(entries)) return 0;
  if (!lastSeenVersion) return entries.length;
  const seenIndex = entries.findIndex(entry => entry.version === lastSeenVersion);
  return seenIndex === -1 ? entries.length : seenIndex;
}
