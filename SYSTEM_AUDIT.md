# IDS GUI Software Audit

Audit date: 2026-07-22

## Scope and evidence

This audit covers the browser/Electron UI, serial framing, firmware command names, displayed firmware state names, trending, local persistence, and packaging. It compares the UI with:

- the legacy `NANO_SINGLE_GUI_R17_RELEASE.html` beside this repository; and
- the compiled R17 firmware ELF beside this repository (string-level inspection).

No IDS hardware was available. Physical GPIO assignments, electrical polarity, switch mechanics, and the firmware's internal mode-to-output control logic therefore remain bench-test items. A compiled binary is enough to verify protocol names, but not enough to prove pin routing.

## Results

### Serial path

- Web Serial opens at 115200 baud and filters for Arduino vendor ID `0x2341`.
- The UI polls with `{"GET":"ALL"}` once per second by default (adjustable from 200–5000 ms).
- Outbound JSON is newline-terminated.
- Inbound data uses a brace-counting parser that supports partial and concatenated JSON objects, quoted braces, and an 8 KB overflow guard.
- Confirmed control keys match the R17 artifacts: `Run_MODE`, `WatchdogTrigger_MODE`, `Purge_MODE`, `Flush_MODE`, `Drain_MODE`, and `Bypass_MODE`.
- Confirmed setpoint/setup keys used by the UI appear in the firmware artifact, including `WeirFloatInvert_SETUP` (the regular Weir float firmware setting).

### Findings corrected in this update

1. The UI listened for `FlushPump_STATE`; R17 emits `flushPump_STATE`. The operation and monitor mappings now use the firmware's exact casing.
2. R17 output states that were uncategorized are now visible: manifold valve 2, bypass valve, flush valve, and service-side pump/valve/heater/vacuum states.
3. Trend charts could initialize at zero size while their tab was hidden. They now resize and refresh when Trending becomes visible.
4. Weir OVF display inversion is now a persisted UI preference, enabled by default. It gives float down = OFF and float up = ON without modifying the raw firmware value.
5. Trending now shows current states for all seven floats and an optional, separate stepped history chart.
6. An opt-in local desktop notification fires on a new Weir OVF OFF-to-ON transition while the app is open and connected.
7. Numeric setpoints/settings are now range-checked before individual or bulk sends.
8. Trend and CSV buffers now retain one hour even at the fastest supported 200 ms polling interval.

### Items that still require hardware or source

- Confirm each physical float's down/up electrical polarity. Only Weir OVF was deliberately inverted in the display.
- Confirm each mode drives the intended physical pumps and valves. The UI sends the correct mode keys, but the mapping is implemented inside firmware.
- `RecirculationPump_STATE` exists in the legacy R17 HTML but is not present as a literal in the compiled R17 artifact. It remains accepted by the UI for compatibility, but should be checked on a live `GET ALL` response.
- Confirm clone/replacement controllers: the current serial chooser filters to Arduino VID `0x2341` and may hide compatible devices with a different vendor ID.
- Exercise disconnect/reconnect, malformed serial data, every setpoint boundary, alarm transitions, and notification permissions on both macOS and Windows.

### Software/deployment follow-ups

- Package metadata still says `0.1.0` while the repository is tagged `v0.2.0` and the UI identifies itself as R18. Choose one release scheme before the next distribution.
- The Electron build completes, but currently uses the default Electron icon and is unsigned because no valid macOS signing identity is configured. This will produce installation warnings.
- Electron has no automatic updater. Users must replace/reinstall the build manually.
- Trends and session CSV data are memory-only and limited to the most recent hour; reload/close clears them.
- The serial device filter accepts only Arduino VID `0x2341`; a configurable/remembered device policy would be more robust.
- The raw-command control intentionally bypasses UI validation and should remain restricted to trained users.
- Automated commissioning is limited to documented mode commands and named readbacks. It is
  gated by local acknowledgements, a connected controller, and a known clear alarm status;
  it commands every mode OFF on entry, exit, abort, and failure. A readback pass is electronic
  evidence only and cannot replace inspection for leaks, routing, motion, or safe fluid supply.
- The HTML includes local vendor assets plus multiple CDN stylesheet fallbacks. For a controlled/offline deployment, remove redundant CDN loads or add an explicit, tested fallback strategy.
- There is no automated firmware simulator or hardware-in-the-loop suite yet. `npm test` verifies syntax, protocol names, and important UI wiring, not physical behavior.

## Updating and deployment recommendation

The application is already static HTML/CSS/JavaScript; Electron is only a wrapper around a local HTTP server plus desktop file dialogs. A rewrite is not required.

Recommended primary delivery:

1. Publish the static repository assets with GitHub Pages over HTTPS.
2. Open the Pages URL in current desktop Chrome or Edge and connect directly with Web Serial.
3. Add a small service worker/PWA layer for offline use and controlled update prompts.
4. Keep Electron as an optional offline/managed fallback if desktop file persistence is important.

This makes UI updates available as soon as a Pages deployment completes. In browser mode, Ink Check data uses local browser storage and JSON export instead of Electron's automatic data file.

## Email alert architecture

Do not place SMTP or email-provider credentials in this client or in GitHub Pages. Reliable email also cannot depend on a browser tab staying open.

Use one of these authenticated relay patterns:

- a small local companion service that reads serial continuously and calls an email provider; or
- an HTTPS webhook (for example, a serverless function or institutional automation endpoint) called by the UI/local companion, with secrets stored server-side.

The event should be edge-triggered (OFF to ON), deduplicated, timestamped, include `SystemID`, and send a recovery event when the state returns OFF. Add retry/backoff and a cooldown before relying on it operationally.

## Verification commands

Run:

```bash
npm test
npm run pack
```

The first command checks JavaScript syntax, required firmware commands, corrected state mappings, and the new controls. The second verifies that Electron can package the current source.
