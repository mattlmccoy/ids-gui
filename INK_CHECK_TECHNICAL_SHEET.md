# Ink Check Tool: Technical Sheet

## 1. Purpose
The Ink Check tool estimates concentration drift of IPA-based carbon ink and computes recommended IPA add-back.

Primary goals:
- Log timed sample measurements (known volume + measured mass).
- Track drift relative to a baseline sample.
- Estimate current concentration (wt%) trend.
- Compute IPA add-back for:
  - the current bottle volume, and
  - an operator-selected aliquot volume.

## 2. UI Functionality
Implemented in:
- `/Users/mattmccoy/GaTech Dropbox/Matthew McCoy/mattmccoy-research/research/binderjet/software/aps-engineering/ids-gui/js/ui-ink.js`

### 2.1 Log Sample Inputs
Per sample:
- `Bottle State`: `brand_new` or `opened`
- `Known Volume (uL)`
- `Ink Family` (example: `IPA 25 wt%`)
- `Nominal wt% (sample)`
- `Sample Mass (g)`
- `Current Ink Volume (mL)` (mass basis for bottle-scale add-back)
- `Notes` (optional)
- `Mark as baseline reference` (optional)

### 2.2 Analysis Scope
- One ink family is analyzed at a time (`Viewing family` selector).
- Trend chart, KPI summary, lookup table, reminder timing, and add-back calculations are all scoped to the active family.

### 2.3 Output Views
- KPI cards:
  - Baseline density
  - Latest density
  - Estimated carbon wt%
  - IPA add-back (bottle basis)
- Trend chart:
  - Sample Density (g/mL)
  - IPA Add-back (g)
- Lookup/history table:
  - Timestamp, family, sample metrics, estimated concentration, bottle-scale add-back
- In-the-moment calculator:
  - Operator enters aliquot volume (mL)
  - Tool returns IPA to add (g and mL)

### 2.4 Persistence & Data Exchange
Buttons:
- `Load Stored`
- `Save Stored`
- `Import JSON`
- `Export JSON`
- `Export CSV`

Electron-backed persistent file APIs are implemented in:
- `/Users/mattmccoy/GaTech Dropbox/Matthew McCoy/mattmccoy-research/research/binderjet/software/aps-engineering/ids-gui/main.js`
- `/Users/mattmccoy/GaTech Dropbox/Matthew McCoy/mattmccoy-research/research/binderjet/software/aps-engineering/ids-gui/preload.js`

Default stored file paths:
- macOS: `~/Library/Application Support/rf-am-ink-delivery-system/ink-check-data.json`
- Windows: `%APPDATA%\\rf-am-ink-delivery-system\\ink-check-data.json`

## 3. Data Model
Top-level JSON payload:
- `version` (integer; current `1`)
- `updatedAt` (ISO-8601 UTC)
- `state` object:
  - `entries[]`
  - `settings`
  - `reminder`

### 3.1 Entry Schema
Each sample entry contains:
- `id`: string
- `timestamp`: ISO-8601 UTC string
- `bottleState`: `brand_new | opened`
- `inkFamily`: string
- `nominalCarbonWtPctAtSample`: number (0.1 to 95)
- `sampleVolumeUl`: number (> 0)
- `sampleMassG`: number (> 0)
- `bottleVolumeMl`: number (> 0)
- `note`: string
- `useAsBaseline`: boolean

### 3.2 Settings Schema
- `activeFamily`: string (default `IPA 25 wt%`)
- `ipaDensityGml`: number (default `0.786`)
- `reminderHours`: number (default `24`)
- `defaultSampleVolumeUl`: number
- `defaultBottleVolumeMl`: number

### 3.3 Reminder Schema
- `snoozeUntil`: epoch ms

## 4. Computation Definitions

### 4.1 Density
For each sample:

- Convert sample volume to mL:
  - `V_sample_ml = sampleVolumeUl / 1000`
- Compute sample density:
  - `rho_sample = sampleMassG / V_sample_ml`  (g/mL)

### 4.2 Baseline Selection
For active family only:
- Baseline entry = latest entry flagged `useAsBaseline == true`.
- If none is flagged, baseline defaults to first entry of that family.

Baseline density:
- `rho_base = density(baselineEntry)`

### 4.3 Estimated Concentration
For each sample:
- Density ratio:
  - `R = rho_sample / rho_base`
- Nominal concentration at sample:
  - `C_nom = nominalCarbonWtPctAtSample`
- Estimated concentration:
  - `C_est = clamp(C_nom * R, 0, 95)`  (wt%)

### 4.4 IPA Add-back (Bottle Basis)
For each sample:
- Current bottle ink mass estimate:
  - `M_ink = rho_sample * bottleVolumeMl` (g)
- Ratio factor:
  - `F = C_est / C_nom`
- IPA add-back mass:
  - `M_IPA_add = max(0, M_ink * (F - 1))` (g)
- IPA add-back volume:
  - `V_IPA_add = M_IPA_add / rho_IPA` (mL)
  - where `rho_IPA = settings.ipaDensityGml`

### 4.5 In-the-Moment Aliquot Add-back
Given operator aliquot volume `V_aliquot` (mL), use latest active-family sample:
- `M_aliquot = rho_latest * V_aliquot`
- `F_latest = C_est_latest / C_nom_latest`
- `M_IPA_add_aliquot = max(0, M_aliquot * (F_latest - 1))`
- `V_IPA_add_aliquot = M_IPA_add_aliquot / rho_IPA`

## 5. Reminder Logic
- Per active family, reminder is due if no sample exists within `reminderHours`.
- Dismiss action snoozes reminders for fixed `4` hours.
- Reminder modal is only shown when Ink Check tab is active to avoid hidden-tab backdrop issues.

## 6. Assumptions
- Concentration drift is dominated by IPA evaporation.
- Density increase tracks concentration increase.
- Bottle volume input is operator-provided and used directly for bottle-scale add-back.
- IPA density is treated as constant over operating conditions.

## 7. Limitations
- Model does not currently include:
  - non-IPA volatile loss,
  - particulate settling effects on sampled aliquot representativeness,
  - temperature correction on density,
  - uncertainty propagation / confidence intervals.
- Add-back is model-based guidance and should be validated with process-specific empirical calibration.

## 8. Cross-Platform / Version Notes
- JSON is versioned (`version: 1`) and normalized on load.
- Loader accepts either wrapped payload (`{version, state}`) or direct state object.
- Family-based fields are required in current behavior; defaults are applied during normalization if missing.

## 9. Test Dataset
A two-week, 4-hour cadence sample dataset is provided at:
- `/Users/mattmccoy/GaTech Dropbox/Matthew McCoy/mattmccoy-research/research/binderjet/software/aps-engineering/ids-gui/ink-check-sample-data-2weeks.json`

Contains:
- Baseline at `500 uL`, `0.2243 g`, `500 mL`.
- Gradual density drift.
- Volume depletion from sample withdrawal + passive loss.
- Family tagging (`IPA 25 wt%`) and per-sample nominal wt%.
