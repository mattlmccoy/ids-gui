# Changelog

All notable changes to this project are documented in this file.

## 2026-07-22

### Added
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
