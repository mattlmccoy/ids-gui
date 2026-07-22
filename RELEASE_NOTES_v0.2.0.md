# Release v0.2.0

Date: 2026-02-18  
Commit: `942af21`

## Summary
Major feature and reliability release introducing the new Ink Check workflow, cross-platform persistence, and broad operation/trending/error UX improvements.

## Highlights

### Ink Check (new tab)
- Added full Ink Check workflow for IPA-based ink concentration monitoring.
- Added per-sample logging with:
  - bottle state
  - ink family
  - nominal wt% at sample
  - known volume (mL)
  - sample mass (g)
  - current bottle volume (mL)
  - baseline flag and notes
- Added one-family-at-a-time analysis/filtering.
- Added trend chart for density and IPA add-back.
- Added bottle-basis IPA add-back KPI outputs.
- Added in-the-moment aliquot reconstitution calculator.
- Added reminder banner/modal with snooze.

### Ink Data Persistence / Portability
- Added Electron IPC APIs for stored ink history JSON:
  - load default
  - save default
  - import JSON
  - export JSON
- Added automatic load/save behavior on app use.
- Added explicit UI controls for load/save/import/export.
- Added versioned, normalized data schema support.

### Operation / Controls / Alarms
- Improved `Send All` reliability and progress feedback.
- Improved config load/send robustness and status copy.
- Added heater visibility controls and aligned KPI/plot behavior.
- Added active error dismissal flow and improved no-error state.
- Updated mode-control behavior/tooltips to match firmware behavior.
- Removed non-meaningful service mode control from UI.

### Trending / Monitoring
- Improved axis visibility and units/legend clarity.
- Added polling interval controls with nominal reset.
- Improved pressure/vacuum chart behavior and readability.

### Documentation / Artifacts
- Added `INK_CHECK_TECHNICAL_SHEET.md` with full formulas and functional spec.
- Updated `README.md` with Ink Check usage and persistence details.
- Added comprehensive `CHANGELOG.md` entry for this release.
- Added sample dataset:
  - `ink-check-sample-data-2weeks.json`
  - includes baseline, 4-hour cadence for 2 weeks, sample depletion + passive loss.

## Changed Files (major)
- `README.md`
- `CHANGELOG.md`
- `INK_CHECK_TECHNICAL_SHEET.md`
- `index.html`
- `main.js`
- `preload.js`
- `js/ui-ink.js`
- `js/ui-operation.js`
- `js/ui-charts.js`
- `js/serial.js`
- `js/app.js`
- `css/styles.css`
- `ink-check-sample-data-2weeks.json`

## Notes
- GitHub CLI was not authenticated at release time, so this release is recorded in-repo and tagged.  
- To publish as a GitHub Release in UI: create release from tag `v0.2.0` and paste this file body.
