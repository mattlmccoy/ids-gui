# Ink Check Tool: Technical Sheet

## 1. Purpose
The Ink Check tool logs density drift of IPA-based carbon ink and calculates concentration
only from a process-specific empirical calibration. Concentration and IPA dosing remain
disabled until at least two known calibration points are installed.

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
- `Known Volume (mL)` in GUI (stored internally as `sampleVolumeUl` for compatibility)
- `Ink Family` (example: `IPA 25 wt%`)
- `Nominal wt% (sample)`
- `Sample Mass (g)`
- `Sample Temperature (°C)` (optional but recommended)
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
- `version` (integer; current `3`)
- `updatedAt` (ISO-8601 UTC)
- `state` object:
  - `entries[]`
  - `settings`
  - `reminder`
  - `calibrationPoints[]`

### 3.1 Entry Schema
Each sample entry contains:
- `id`: string
- `timestamp`: ISO-8601 UTC string
- `bottleState`: `brand_new | opened`
- `inkFamily`: string
- `nominalCarbonWtPctAtSample`: number (0.1 to 95)
- `sampleVolumeUl`: number (> 0)
- `sampleMassG`: number (> 0)
- `temperatureC`: number (0 to 80) or `null`
- `bottleVolumeMl`: number (> 0)
- `note`: string
- `useAsBaseline`: boolean

### 3.2 Settings Schema
- `activeFamily`: string (default `IPA 25 wt%`)
- `ipaDensityGml`: number (default `0.786`)
- `reminderHours`: number (default `24`)
- `defaultSampleVolumeUl`: number (default `1000`, displayed as 1 mL)
- `defaultBottleVolumeMl`: number

### 3.3 Reminder Schema
- `snoozeUntil`: epoch ms

### 3.4 Calibration Point Schema

- `densityGml`: density of independently prepared known mixture
- `carbonWtPct`: known carbon concentration
- `temperatureC`: measurement temperature or `null`
- At least two points are required; density and concentration must both increase strictly.

## 4. Computation Definitions

### 4.1 Density
For each sample:

- Convert sample volume to mL:
  - `V_sample_ml = sampleVolumeUl / 1000`
- Compute sample density:
  - `rho_sample = sampleMassG / V_sample_ml`  (g/mL)

### 4.2 Baseline Selection
For active family only, entries are sorted chronologically. The first entry starts the
first baseline segment. Every later entry flagged `useAsBaseline == true` starts a new
segment from that timestamp forward. A future baseline therefore never rewrites older
history.

Baseline density:
- `rho_base = density(baselineEntry)`

### 4.3 Calibrated Concentration

- Calibration points are sorted by density.
- A sample must fall between two measured calibration densities.
- Concentration is linearly interpolated between those adjacent known points.
- Extrapolation outside the measured range is prohibited.
- When calibration temperatures are supplied, sample temperature is required and must be
  within 2 °C of the calibration mean.
- If any condition fails, `C_est` is unavailable and every dosing output is disabled.

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
- Density contains a large solvent contribution and is mapped to concentration only through
  known formulation-specific calibration points.

### 6.1 Provisional plausibility guard

- The tool previews density before logging.
- Density below `0.9 * configured IPA density` or above `2.0 g/mL` is marked suspect.
- Suspect data may be retained for troubleshooting after confirmation, but bottle and
  aliquot dosing recommendations are disabled for that latest sample.

## 7. Limitations
- Model does not currently include:
  - non-IPA volatile loss,
  - particulate settling effects on sampled aliquot representativeness,
  - temperature correction on density,
  - uncertainty propagation / confidence intervals.
- The UI prevents carbon and add-back results when calibration is missing, out of range, or
  temperature-incompatible.
- Add-back is model-based guidance and should be validated with process-specific empirical calibration.

## 8. Cross-Platform / Version Notes
- JSON is versioned (`version: 3`) and normalized on load.
- Loader accepts either wrapped payload (`{version, state}`) or direct state object.
- Family-based fields are required in current behavior; defaults are applied during normalization if missing.

## 9. Archived Synthetic Dataset
An older two-week synthetic dataset remains in the repository for regression/audit work at:
- `/Users/mattmccoy/GaTech Dropbox/Matthew McCoy/mattmccoy-research/research/binderjet/software/aps-engineering/ids-gui/ink-check-sample-data-2weeks.json`

Its baseline (`500 uL`, `0.2243 g`) computes to `0.4486 g/mL`, which is implausibly below
the configured IPA density. It is intentionally excluded from the published Pages artifact
and must not be used as a physical reference. Tomorrow's lab measurements will replace it
with a validated calibration dataset.
