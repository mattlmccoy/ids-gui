# Changelog

All notable changes to this project are documented in this file. The most recent entries are
also shown in-app via the header **What's new** dropdown (see `js/changelog.js`).

## 2026-07-23

### Added
- **What's new** dropdown in the header, backed by a human-readable in-app changelog
  (`js/changelog.js`); a small badge appears after each update until viewed.
- Global **Simple / Pro** dashboard switch in the header.
- Per-chart show/hide toggles on the Trends tab (Temperature, Pressure / Vacuum, Floats & State).
- Commissioning **Skip test** and **Start over** controls.

### Changed
- Serial now **auto-reconnects** after an unexpected controller disconnect, resuming telemetry
  only (no commands are re-sent); manual Disconnect cancels it.
- Connect sends an immediate telemetry poll so readouts populate right away.
- The printhead inlet/return dual-pressure feature is hidden everywhere unless enabled in Settings.
- Commissioning float checks are observational (floats are not manually forced).
- The "Recirc Drive" control keeps the old **Flow** name alongside it.

### Fixed
- Commissioning page no longer glitches every second (structural re-render only; live values and the
  evidence chart update in place).
- A heater/HTC alarm from a channel marked not-installed is reliably suppressed and no longer blocks
  the guided commissioning tests.

## 2026-07-22

### Added
- A dedicated **Debug** page with system health summaries, filterable raw telemetry,
  automatic findings, recent command/event history, guarded raw JSON commands, and the
  secret-free diagnostic export.
- A first-pass animated plumbing map for Run, Purge, Flush, Drain, and Bypass. Live mode
  highlighting follows controller state; disconnected preview buttons never send commands.
  Unverified physical hose paths remain dashed and explicitly labeled for lab tracing.
- Firmware-backed operating-mode guide with verified R17 output maps, prominent uncertainty
  warnings for unverified plumbing, live readback highlighting, and a persistent Bypass alert.
- A controlled **All Modes Off** command that requests Run, Purge, Flush, Drain, and Bypass
  OFF and reports whether each command is acknowledged by controller telemetry.
- Compact clock badges for Run startup/wind-down, Flush, reboot, commissioning waits/dwells,
  and the 30-minute remote-control safety latch.
- Secret-free diagnostic bundle export with recent raw telemetry, command/connection history,
  UI/firmware context, and basic anomaly findings.
- Persistent Settings toggles for Main and AUX heater installation. Marking an unplugged
  channel unused hides its readbacks/trends and suppresses a generic HTC fault only when
  live temperature telemetry clearly identifies that channel as the source.
- Integrated commissioning automation directly into the step-by-step test wizard. Circuit
  tests now show animated phase progress, live readback plots, safety interlocks, automatic
  electronic analysis, and linked physical-confirmation results; alert delivery tests now
  run from their matching guided steps.
- Per-category test-fire buttons for Weir overflow, Supply overflow, firmware alarms,
  controller disconnects, and stale telemetry. Test events use normal Slack/ntfy delivery
  without changing live incident state or suppressing a subsequent real alert.
- Safety-gated automated commissioning checks for Flush, Drain, Bypass, and an optional
  Run/vacuum-response sequence, with live readback evaluation and an operator stop control.
- Unit coverage for command allowlisting, alarm gating, readback matching, shutdown command
  generation, test selection, and vacuum-response evaluation.

### Fixed
- Removed the always-visible R17 warning grid from Operation. Detailed mode behavior and
  limitations now live behind expandable sections on Debug.
- Replaced unexplained `ACK ON/OFF` pills with transient **Sending…** and **No response**
  feedback. Normal confirmed state is conveyed by the ON/OFF control itself and plain-language
  status text.
- Mode buttons now distinguish requested commands from firmware-acknowledged state instead of
  immediately presenting an optimistic local selection as live hardware state.
- Purge, Flush, and Drain are mutually exclusive in the web UI; Bypass requires an explicit
  persistent-mode confirmation.
- Drain commissioning now verifies the actual compiled R17 outputs: drain pump plus both
  manifold valves. It no longer incorrectly expects the separate drain valve to turn on.
- Flush commissioning detects the known R17 timer-reset failure and returns an explicit
  firmware defect instead of a vague timeout or an unsafe automatic retry.
- Operator-facing `Flow_SETPOINT` labels now say **Recirculation Drive** because R17 uses the
  value as pump drive and does not report measured flow.
- GitHub Pages now assigns one deployment version to every nested JavaScript import and the
  main stylesheet, preventing a fresh entry point from loading stale Settings modules.
- Commissioning now requires a known clear alarm status and stops on alarms, disconnects,
  timeouts, failures, or operator aborts, then requests the all-modes-OFF baseline.

## 2026-02-18

### Added
- New **Ink Check** tab with:
  - per-sample logging (family, nominal wt%, known volume, measured mass, bottle volume, notes, baseline flag)
  - family-scoped analysis and filtering
  - trend chart for sample density and IPA add-back
  - bottle-basis IPA add-back KPIs
  - in-the-moment aliquot reconstitution calculator
  - reminder banner/modal with snooze
- Persistent cross-platform ink-history storage via Electron IPC:
  - auto-load / auto-save default JSON in app user-data folder
  - explicit `Load Stored`, `Save Stored`, `Import JSON`, `Export JSON` controls
- Technical reference document: `INK_CHECK_TECHNICAL_SHEET.md`.
- Generated validation dataset: `ink-check-sample-data-2weeks.json`.
- Heater visibility module and related integration (`js/heater-visibility.js`).
- Nominal config module and packaged nominal config support (`js/nominal-config.js`, `nominal-config.json`).
- Vacuum scaling helper module (`js/vacuum-scale.js`).

### Changed
- Operation tab:
  - improved setpoint/config workflows including robust `Send All`
  - config status/progress feedback and better load/send copy
  - mode controls/tooltips aligned with firmware behavior
  - service mode control removed from UI when not operationally meaningful
- Error handling UX:
  - active error card now supports explicit dismissal workflow
  - improved no-active-error visual state and messaging
- Heater handling UX:
  - hide/show controls for heaters
  - KPI tile ordering and disabled presentation behavior
  - heater-linked alarm suppression behavior aligned to selected visibility logic
- Trending charts:
  - clearer axes/units/legend behavior
  - pressure/vacuum axis visibility synced to enabled traces
  - polling interval control added with nominal reset
- App wiring:
  - tab/module bootstrapping updated for new features
  - preload/main IPC surface expanded for persistence/import/export

### Fixed
- `Send All` reliability issues and delayed/unclear response behavior.
- Config load glitches where selected file state was not stable across repeated loads.
- Startup dimmed-screen/backdrop issues caused by hidden-tab modals.
- Error suppression edge cases for unrelated heaters.
- Several robustness issues around state synchronization across tabs, charts, and operation controls.

### Data Model / Compatibility
- Ink history JSON now stores versioned payloads and normalizes loaded content.
- Family-scoped fields are supported directly:
  - `inkFamily`
  - `nominalCarbonWtPctAtSample`
- Import path accepts wrapped payload (`{version, state}`) and normalized state content.
