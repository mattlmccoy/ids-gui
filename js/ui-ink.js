import store from './state.js';

const STORAGE_KEY = 'ids-ink-check-v1';
const DATA_VERSION = 1;
const REMINDER_SNOOZE_HOURS = 4;
const DEFAULT_FAMILY_ID = 'IPA 25 wt%';
const DEFAULTS = {
  activeFamily: DEFAULT_FAMILY_ID,
  ipaDensityGml: 0.786,
  reminderHours: 24,
  defaultSampleVolumeUl: 10000,
  defaultBottleVolumeMl: 500
};

let inkState = null;
let trendChart = null;
let reminderTimer = null;
let reminderModalShown = false;
let persistentFilePath = '';
let pendingDataPrompt = false;

export function initInkTab() {
  const panel = document.getElementById('panel-ink');
  if (!panel) return;
  panel.innerHTML = buildHTML();
  inkState = loadState();
  bindEvents();
  applyDefaultsToForm();
  renderAll();
  startReminderLoop();
  bindTabActivationReminder();
  void hydratePersistentState();
}

function buildHTML() {
  return `
    <div class="alert alert-warning d-none" id="ink-reminder-banner">
      <div class="d-flex flex-wrap align-items-center gap-2">
        <span><i class="bi bi-exclamation-triangle me-1"></i>Ink concentration check is due. Log a fresh sample before printing.</span>
        <button class="btn btn-sm btn-outline-dark ms-auto" id="btn-ink-log-now">Log now</button>
        <button class="btn btn-sm btn-outline-secondary" id="btn-ink-dismiss-reminder">Dismiss ${REMINDER_SNOOZE_HOURS}h</button>
      </div>
    </div>

    <div class="row g-3">
      <div class="col-xl-5">
        <div class="dash-card accent-cyan mb-3">
          <div class="card-header"><i class="bi bi-clipboard2-pulse me-1"></i> Log Sample</div>
          <div class="card-body">
            <div class="row g-2">
              <div class="col-6">
                <label class="form-label small mb-1">Bottle State</label>
                <select class="form-select form-select-sm" id="ink-bottle-state">
                  <option value="brand_new">Brand new bottle</option>
                  <option value="opened">Already opened bottle</option>
                </select>
              </div>
              <div class="col-6">
                <label class="form-label small mb-1">Known Volume (mL)</label>
                <input type="number" min="0.1" step="0.1" class="form-control form-control-sm" id="ink-sample-volume-ml">
              </div>
              <div class="col-8">
                <label class="form-label small mb-1">Ink Family</label>
                <input type="text" class="form-control form-control-sm" id="ink-family-id" placeholder="e.g. IPA 25 wt%">
              </div>
              <div class="col-4">
                <label class="form-label small mb-1">Nominal wt% (sample)</label>
                <input type="number" min="0.1" max="95" step="0.1" class="form-control form-control-sm" id="ink-sample-nominal-wt">
              </div>
              <div class="col-6">
                <label class="form-label small mb-1">Sample Mass (g)</label>
                <input type="number" min="0.001" step="0.001" class="form-control form-control-sm" id="ink-sample-mass-g" placeholder="e.g. 0.842">
              </div>
              <div class="col-6">
                <label class="form-label small mb-1">Current Ink Volume (mL)</label>
                <input type="number" min="1" step="0.1" class="form-control form-control-sm" id="ink-bottle-volume-ml">
              </div>
              <div class="col-12">
                <label class="form-label small mb-1">Notes</label>
                <input type="text" class="form-control form-control-sm" id="ink-note" placeholder="Optional">
              </div>
              <div class="col-12">
                <div class="form-check">
                  <input class="form-check-input" type="checkbox" id="ink-mark-baseline">
                  <label class="form-check-label small" for="ink-mark-baseline">
                    Mark as baseline reference
                  </label>
                </div>
              </div>
              <div class="col-12 d-flex gap-2">
                <button class="btn-control btn-connect" id="btn-ink-log-sample">Log Sample</button>
                <button class="btn-control btn-disconnect" id="btn-ink-clear-logs">Clear Logs</button>
                <button class="btn-control btn-disconnect" id="btn-ink-export-csv">Export CSV</button>
              </div>
              <div class="col-12 d-flex gap-2 flex-wrap">
                <button class="btn-control btn-disconnect" id="btn-ink-load-stored">Load Stored</button>
                <button class="btn-control btn-disconnect" id="btn-ink-save-stored">Save Stored</button>
                <button class="btn-control btn-disconnect" id="btn-ink-import-json">Import JSON</button>
                <button class="btn-control btn-disconnect" id="btn-ink-export-json">Export JSON</button>
              </div>
              <div class="col-12 small" id="ink-storage-path" style="color:var(--text-muted)"></div>
              <div class="col-12 small" id="ink-status" style="color:var(--text-muted)"></div>
            </div>
          </div>
        </div>

        <div class="dash-card accent-purple">
          <div class="card-header"><i class="bi bi-sliders me-1"></i> Model Settings</div>
          <div class="card-body">
            <div class="row g-2">
              <div class="col-6">
                <label class="form-label small mb-1">IPA Density (g/mL)</label>
                <input type="number" min="0.1" max="2" step="0.001" class="form-control form-control-sm" id="ink-ipa-density">
              </div>
              <div class="col-6">
                <label class="form-label small mb-1">Reminder (hours)</label>
                <input type="number" min="1" max="168" step="1" class="form-control form-control-sm" id="ink-reminder-hours">
              </div>
              <div class="col-6 d-flex align-items-end">
                <button class="btn-control btn-connect w-100" id="btn-ink-apply-settings">Apply</button>
              </div>
            </div>
          </div>
        </div>

        <div class="dash-card accent-green mt-3">
          <div class="card-header"><i class="bi bi-beaker me-1"></i> In-the-Moment Mix Calculator</div>
          <div class="card-body">
            <div class="row g-2">
              <div class="col-7">
                <label class="form-label small mb-1">Aliquot Volume to Reconstitute (mL)</label>
                <input type="number" min="0.1" step="0.1" class="form-control form-control-sm" id="ink-aliquot-volume-ml" value="50">
              </div>
              <div class="col-5 d-flex align-items-end">
                <button class="btn-control btn-connect w-100" id="btn-ink-calc-aliquot">Compute IPA</button>
              </div>
              <div class="col-12 small" id="ink-aliquot-result" style="color:var(--text-muted)">
                Uses latest logged sample density/concentration estimate.
              </div>
            </div>
          </div>
        </div>

        <div class="dash-card accent-green mt-3">
          <div class="card-header"><i class="bi bi-eyedropper me-1"></i> Target Carbon Dilution (Add IPA)</div>
          <div class="card-body">
            <div class="row g-2">
              <div class="col-5">
                <label class="form-label small mb-1">Sample Volume (mL)</label>
                <input type="number" min="0.1" step="0.1" class="form-control form-control-sm" id="ink-target-volume-ml" value="50">
              </div>
              <div class="col-4">
                <label class="form-label small mb-1">Target Carbon (wt%)</label>
                <input type="number" min="0.1" max="95" step="0.1" class="form-control form-control-sm" id="ink-target-carbon-wt" value="25">
              </div>
              <div class="col-3 d-flex align-items-end">
                <button class="btn-control btn-connect w-100" id="btn-ink-calc-target">Compute IPA</button>
              </div>
              <div class="col-12 small" id="ink-target-result" style="color:var(--text-muted)">
                Uses latest logged estimated carbon wt% and density as the current state.
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="col-xl-7">
        <div class="d-flex align-items-center gap-2 mb-2">
          <span class="small" style="color:var(--text-secondary);font-weight:600">Viewing family:</span>
          <select class="form-select form-select-sm" id="ink-family-filter" style="max-width:280px"></select>
        </div>
        <div class="kpi-grid mb-3">
          <div class="kpi-tile">
            <span class="kpi-label">Baseline Density</span>
            <span class="kpi-value" id="ink-baseline-density">--</span>
            <span class="kpi-unit">g/mL</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-label">Latest Density</span>
            <span class="kpi-value" id="ink-latest-density">--</span>
            <span class="kpi-unit">g/mL</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-label">Estimated Carbon</span>
            <span class="kpi-value" id="ink-est-carbon">--</span>
            <span class="kpi-unit">wt%</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-label">IPA Add-back (Bottle Basis)</span>
            <span class="kpi-value" id="ink-ipa-add-g">--</span>
            <span class="kpi-unit" id="ink-ipa-add-ml">--</span>
          </div>
        </div>

        <div class="dash-card accent-blue mb-3">
          <div class="card-header"><i class="bi bi-graph-up me-1"></i> Density and IPA Add-back Trend</div>
          <div class="card-body">
            <div class="chart-container"><canvas id="ink-trend-chart"></canvas></div>
            <div class="small mt-2" style="color:var(--text-muted)">
              Calculation assumes concentration drift is dominated by IPA evaporation and uses baseline sample density as the reference.
            </div>
          </div>
        </div>

        <div class="dash-card">
          <div class="card-header"><i class="bi bi-table me-1"></i> Lookup / History</div>
          <div class="card-body p-0">
            <div class="table-responsive" style="max-height:46vh;overflow-y:auto">
              <table class="table table-sm table-hover mb-0">
                <thead class="sticky-top">
                  <tr>
                    <th>Timestamp</th>
                    <th>Bottle</th>
                    <th>Vol (mL)</th>
                    <th>Mass (g)</th>
                    <th>Density</th>
                    <th>Carbon (wt%)</th>
                    <th>Bottle Vol (mL)</th>
                    <th>IPA Add (g)</th>
                    <th>IPA Add (mL)</th>
                  </tr>
                </thead>
                <tbody id="ink-log-tbody"></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="modal fade" id="ink-reminder-modal" tabindex="-1" aria-labelledby="ink-reminder-modal-title" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="ink-reminder-modal-title">Ink Check Due</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            Log a known-volume sample mass before printing to verify concentration drift and IPA add-back.
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" id="btn-ink-modal-dismiss">Dismiss ${REMINDER_SNOOZE_HOURS}h</button>
            <button type="button" class="btn btn-primary" id="btn-ink-modal-log">Log now</button>
          </div>
        </div>
      </div>
    </div>

    <div class="modal fade" id="ink-data-modal" tabindex="-1" aria-labelledby="ink-data-modal-title" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="ink-data-modal-title">Load Historical Ink Data</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            No stored ink history was found. Load an existing JSON history file now, or start fresh.
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" id="btn-ink-data-start-fresh">Start fresh</button>
            <button type="button" class="btn btn-primary" id="btn-ink-data-import-now">Import JSON</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function bindEvents() {
  document.getElementById('ink-bottle-state')?.addEventListener('change', e => {
    document.getElementById('ink-mark-baseline').checked = e.target.value === 'brand_new';
  });

  document.getElementById('btn-ink-log-sample')?.addEventListener('click', onLogSample);
  document.getElementById('btn-ink-clear-logs')?.addEventListener('click', onClearLogs);
  document.getElementById('btn-ink-export-csv')?.addEventListener('click', onExportCSV);
  document.getElementById('btn-ink-load-stored')?.addEventListener('click', () => { void loadFromStoredFile(); });
  document.getElementById('btn-ink-save-stored')?.addEventListener('click', () => { void persistToStoredFile(); });
  document.getElementById('btn-ink-import-json')?.addEventListener('click', () => { void importInkJson(); });
  document.getElementById('btn-ink-export-json')?.addEventListener('click', () => { void exportInkJson(); });
  document.getElementById('btn-ink-apply-settings')?.addEventListener('click', onApplySettings);
  document.getElementById('btn-ink-calc-aliquot')?.addEventListener('click', computeAliquotAddback);
  document.getElementById('btn-ink-calc-target')?.addEventListener('click', computeTargetDilutionAddback);
  document.getElementById('ink-family-filter')?.addEventListener('change', e => {
    inkState.settings.activeFamily = String(e.target.value || DEFAULT_FAMILY_ID);
    saveState();
    renderAll();
  });

  document.getElementById('btn-ink-log-now')?.addEventListener('click', openInkTabAndFocus);
  document.getElementById('btn-ink-dismiss-reminder')?.addEventListener('click', dismissReminder);
  document.getElementById('btn-ink-modal-log')?.addEventListener('click', () => {
    try { bootstrap.Modal.getInstance(document.getElementById('ink-reminder-modal'))?.hide(); } catch (_) {}
    openInkTabAndFocus();
  });
  document.getElementById('btn-ink-modal-dismiss')?.addEventListener('click', () => {
    dismissReminder();
    try { bootstrap.Modal.getInstance(document.getElementById('ink-reminder-modal'))?.hide(); } catch (_) {}
  });

  document.getElementById('btn-ink-data-import-now')?.addEventListener('click', async () => {
    try { bootstrap.Modal.getInstance(document.getElementById('ink-data-modal'))?.hide(); } catch (_) {}
    await importInkJson();
  });
  document.getElementById('btn-ink-data-start-fresh')?.addEventListener('click', () => {
    try { bootstrap.Modal.getInstance(document.getElementById('ink-data-modal'))?.hide(); } catch (_) {}
    setInkStatus('Starting with empty history. You can import historical JSON any time.');
  });
}

function onLogSample() {
  const volumeMl = Number(document.getElementById('ink-sample-volume-ml').value);
  const massG = Number(document.getElementById('ink-sample-mass-g').value);
  const bottleVolumeMl = Number(document.getElementById('ink-bottle-volume-ml').value);
  const bottleState = document.getElementById('ink-bottle-state').value;
  const inkFamily = String(document.getElementById('ink-family-id').value || '').trim();
  const nominalAtSample = Number(document.getElementById('ink-sample-nominal-wt').value);
  const note = document.getElementById('ink-note').value.trim();
  const baseline = !!document.getElementById('ink-mark-baseline').checked;

  if (!Number.isFinite(volumeMl) || volumeMl <= 0) {
    setInkStatus('Known sample volume must be > 0 mL.');
    return;
  }
  if (!Number.isFinite(massG) || massG <= 0) {
    setInkStatus('Sample mass must be > 0 g.');
    return;
  }
  if (!Number.isFinite(bottleVolumeMl) || bottleVolumeMl <= 0) {
    setInkStatus('Current bottle volume must be > 0 mL.');
    return;
  }
  if (!inkFamily) {
    setInkStatus('Ink family is required (for example "IPA 25 wt%").');
    return;
  }
  if (!Number.isFinite(nominalAtSample) || nominalAtSample <= 0 || nominalAtSample > 95) {
    setInkStatus('Nominal wt% at sample must be > 0 and <= 95.');
    return;
  }

  const volumeUl = volumeMl * 1000;
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    bottleState,
    inkFamily,
    nominalCarbonWtPctAtSample: nominalAtSample,
    sampleVolumeUl: volumeUl,
    sampleMassG: massG,
    bottleVolumeMl,
    note,
    useAsBaseline: baseline
  };
  inkState.entries.push(entry);
  inkState.settings.activeFamily = inkFamily;
  inkState.reminder.snoozeUntil = 0;
  saveState();
  renderAll();
  setInkStatus(`Logged ${new Date(entry.timestamp).toLocaleString()}.`);
  store.log('info', `Ink sample logged (${volumeMl.toFixed(3)} mL, ${massG.toFixed(3)} g).`);
  document.getElementById('ink-sample-mass-g').value = '';
  document.getElementById('ink-note').value = '';
}

function onClearLogs() {
  if (!confirm('Clear all ink concentration logs?')) return;
  inkState.entries = [];
  saveState();
  renderAll();
}

function onExportCSV() {
  if (!inkState.entries.length) return;
  const rows = buildComputedRows(getVisibleEntries());
  let csv = 'Timestamp,InkFamily,NominalCarbon_wtPct_atSample,BottleState,SampleVolume_mL,SampleMass_g,Density_g_per_mL,EstimatedCarbon_wtPct,BottleVolume_mL,IPA_Add_g,IPA_Add_mL,BaselineRef,Notes\n';
  for (const r of rows) {
    const e = r.entry;
    csv += [
      e.timestamp,
      e.inkFamily,
      e.nominalCarbonWtPctAtSample,
      e.bottleState,
      fmt(e.sampleVolumeUl / 1000, 3),
      e.sampleMassG,
      fmt(r.density),
      fmt(r.estimatedCarbonWtPct),
      e.bottleVolumeMl,
      fmt(r.ipaAddG),
      fmt(r.ipaAddMl),
      e.useAsBaseline ? 'YES' : 'NO',
      `"${(e.note || '').replace(/"/g, '""')}"`
    ].join(',') + '\n';
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ink-concentration-log-${stampForFile(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function onApplySettings() {
  const next = {
    activeFamily: String(inkState.settings.activeFamily || DEFAULT_FAMILY_ID),
    ipaDensityGml: clampNum(document.getElementById('ink-ipa-density').value, 0.1, 2, DEFAULTS.ipaDensityGml),
    reminderHours: clampNum(document.getElementById('ink-reminder-hours').value, 1, 168, DEFAULTS.reminderHours),
    defaultSampleVolumeUl: inkState.settings.defaultSampleVolumeUl,
    defaultBottleVolumeMl: inkState.settings.defaultBottleVolumeMl
  };
  inkState.settings = next;
  saveState();
  renderAll();
  setInkStatus('Model settings updated.');
}

function applyDefaultsToForm() {
  document.getElementById('ink-mark-baseline').checked = true;
}

function renderAll() {
  syncActiveFamily();
  renderFamilyFilterOptions();
  applySettingsToInputs();
  renderSummaryAndTable();
  renderChart();
  updateReminderUI();
  computeAliquotAddback();
  computeTargetDilutionAddback();
  if (persistentFilePath) setStorageStatus(`Stored file: ${persistentFilePath}`);
}

function applySettingsToInputs() {
  const s = inkState.settings;
  document.getElementById('ink-ipa-density').value = String(s.ipaDensityGml);
  document.getElementById('ink-reminder-hours').value = String(s.reminderHours);
  const volumeInput = document.getElementById('ink-sample-volume-ml');
  const bottleInput = document.getElementById('ink-bottle-volume-ml');
  const familyInput = document.getElementById('ink-family-id');
  const nominalSampleInput = document.getElementById('ink-sample-nominal-wt');
  if (!volumeInput.value) volumeInput.value = String(s.defaultSampleVolumeUl / 1000);
  if (!bottleInput.value) bottleInput.value = String(s.defaultBottleVolumeMl);
  if (familyInput) familyInput.value = s.activeFamily || DEFAULT_FAMILY_ID;
  if (nominalSampleInput) nominalSampleInput.value = String(getActiveFamilyNominal());
}

function renderSummaryAndTable() {
  const familyEntries = getVisibleEntries();
  const rows = buildComputedRows(familyEntries);
  const latest = rows[rows.length - 1];
  const baseline = findBaselineRow(rows);

  document.getElementById('ink-baseline-density').textContent = baseline ? fmt(baseline.density, 4) : '--';
  document.getElementById('ink-latest-density').textContent = latest ? fmt(latest.density, 4) : '--';
  document.getElementById('ink-est-carbon').textContent = latest ? fmt(latest.estimatedCarbonWtPct, 2) : '--';
  document.getElementById('ink-ipa-add-g').textContent = latest ? `${fmt(latest.ipaAddG, 2)} g` : '--';
  document.getElementById('ink-ipa-add-ml').textContent = latest
    ? `${fmt(latest.ipaAddMl, 2)} mL IPA for ${fmt(latest.entry.bottleVolumeMl, 1)} mL ink`
    : '--';

  const tbody = document.getElementById('ink-log-tbody');
  tbody.innerHTML = '';
  const reversed = [...rows].reverse();
  for (const r of reversed) {
    const tr = document.createElement('tr');
    if (r.entry.useAsBaseline) tr.classList.add('ink-baseline-row');
    tr.innerHTML = `
      <td>${new Date(r.entry.timestamp).toLocaleString()}</td>
      <td>${r.entry.bottleState === 'brand_new' ? 'Brand new' : 'Opened'}${r.entry.useAsBaseline ? ' <span class="badge bg-info text-dark ms-1">Baseline</span>' : ''}<div class="small" style="color:var(--text-muted)">${escapeHtml(r.entry.inkFamily || '')}</div></td>
      <td>${fmt(r.entry.sampleVolumeUl / 1000, 3)}</td>
      <td>${fmt(r.entry.sampleMassG, 4)}</td>
      <td>${fmt(r.density, 4)}</td>
      <td>${fmt(r.estimatedCarbonWtPct, 2)}</td>
      <td>${fmt(r.entry.bottleVolumeMl, 1)}</td>
      <td>${fmt(r.ipaAddG, 2)}</td>
      <td>${fmt(r.ipaAddMl, 2)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function computeAliquotAddback() {
  const resultEl = document.getElementById('ink-aliquot-result');
  const volumeMl = Number(document.getElementById('ink-aliquot-volume-ml')?.value);
  if (!Number.isFinite(volumeMl) || volumeMl <= 0) {
    if (resultEl) resultEl.textContent = 'Enter aliquot volume > 0 mL.';
    return;
  }
  const rows = buildComputedRows(getVisibleEntries());
  const latest = rows[rows.length - 1];
  if (!latest) {
    if (resultEl) resultEl.textContent = 'Log at least one sample first.';
    return;
  }
  const settings = inkState.settings;
  const add = computeAddbackForVolume(volumeMl, latest.density, latest.estimatedCarbonWtPct, latest.entry.nominalCarbonWtPctAtSample, settings.ipaDensityGml);
  if (resultEl) {
    resultEl.textContent = `For ${fmt(volumeMl, 1)} mL aliquot: add ${fmt(add.ipaAddG, 2)} g IPA (${fmt(add.ipaAddMl, 2)} mL IPA).`;
  }
}

function computeTargetDilutionAddback() {
  const resultEl = document.getElementById('ink-target-result');
  const volumeMl = Number(document.getElementById('ink-target-volume-ml')?.value);
  const targetWtPct = Number(document.getElementById('ink-target-carbon-wt')?.value);
  if (!Number.isFinite(volumeMl) || volumeMl <= 0) {
    if (resultEl) resultEl.textContent = 'Enter sample volume > 0 mL.';
    return;
  }
  if (!Number.isFinite(targetWtPct) || targetWtPct <= 0 || targetWtPct > 95) {
    if (resultEl) resultEl.textContent = 'Enter target carbon wt% > 0 and <= 95.';
    return;
  }

  const rows = buildComputedRows(getVisibleEntries());
  const latest = rows[rows.length - 1];
  if (!latest) {
    if (resultEl) resultEl.textContent = 'Log at least one sample first.';
    return;
  }
  const currentWtPct = latest.estimatedCarbonWtPct;
  const add = computeDilutionToTargetForVolume(
    volumeMl,
    latest.density,
    currentWtPct,
    targetWtPct,
    inkState.settings.ipaDensityGml
  );
  if (resultEl) {
    if (add.ipaAddG <= 0) {
      resultEl.textContent = `Current estimate is ${fmt(currentWtPct, 2)} wt%. IPA add is only needed when target is lower than current concentration.`;
      return;
    }
    resultEl.textContent = `For ${fmt(volumeMl, 1)} mL sample: add ${fmt(add.ipaAddG, 2)} g IPA (${fmt(add.ipaAddMl, 2)} mL IPA) to reach ${fmt(targetWtPct, 2)} wt% from ${fmt(currentWtPct, 2)} wt%.`;
  }
}

function renderChart() {
  const canvas = document.getElementById('ink-trend-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const rows = buildComputedRows(getVisibleEntries());
  const densityData = rows.map(r => ({ x: new Date(r.entry.timestamp).getTime(), y: r.density }));
  const addBackData = rows.map(r => ({ x: new Date(r.entry.timestamp).getTime(), y: r.ipaAddG }));

  if (!trendChart) {
    trendChart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          { label: 'Sample Density (g/mL)', data: densityData, borderColor: '#4c8dff', backgroundColor: '#4c8dff25', yAxisID: 'yDensity', tension: 0.2, pointRadius: 2 },
          { label: 'IPA Add-back (g)', data: addBackData, borderColor: '#34d399', backgroundColor: '#34d39925', yAxisID: 'yAdd', tension: 0.2, pointRadius: 2 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: { type: 'time', grid: { color: 'rgba(42,46,58,0.6)' }, ticks: { color: '#8b8fa3', font: { size: 10 } } },
          yDensity: { position: 'left', title: { display: true, text: 'Density (g/mL)', color: '#8b8fa3' }, grid: { color: 'rgba(42,46,58,0.6)' }, ticks: { color: '#8b8fa3', font: { size: 10 } } },
          yAdd: { position: 'right', title: { display: true, text: 'IPA Add (g)', color: '#8b8fa3' }, grid: { drawOnChartArea: false }, ticks: { color: '#8b8fa3', font: { size: 10 } } }
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, color: '#8b8fa3', font: { size: 10 } } }
        }
      }
    });
  } else {
    trendChart.data.datasets[0].data = densityData;
    trendChart.data.datasets[1].data = addBackData;
    trendChart.update('none');
  }
}

function buildComputedRows(entries) {
  const source = Array.isArray(entries) ? entries : [];
  const baselineEntry = findBaselineEntry(source);
  const baselineDensity = baselineEntry ? computeDensity(baselineEntry) : null;
  return source.map(entry => computeRow(entry, baselineDensity, inkState.settings));
}

function computeRow(entry, baselineDensity, settings) {
  const density = computeDensity(entry);
  const base = baselineDensity || density;
  const ratio = base > 0 ? density / base : 1;
  const nominalAtSample = Number(entry.nominalCarbonWtPctAtSample) > 0 ? Number(entry.nominalCarbonWtPctAtSample) : getActiveFamilyNominal();
  const estimatedCarbonWtPct = Math.max(0, Math.min(95, nominalAtSample * ratio));
  const add = computeAddbackForVolume(
    entry.bottleVolumeMl,
    density,
    estimatedCarbonWtPct,
    nominalAtSample,
    settings.ipaDensityGml
  );
  const { ipaAddG, ipaAddMl } = add;
  return { entry, density, estimatedCarbonWtPct, ipaAddG, ipaAddMl };
}

function getVisibleEntries() {
  const active = String(inkState.settings.activeFamily || DEFAULT_FAMILY_ID);
  return inkState.entries.filter(e => String(e.inkFamily || DEFAULT_FAMILY_ID) === active);
}

function getFamilyList() {
  const set = new Set([DEFAULT_FAMILY_ID]);
  for (const e of inkState.entries) {
    if (e.inkFamily) set.add(String(e.inkFamily));
  }
  return Array.from(set);
}

function getActiveFamilyNominal() {
  const active = String(inkState.settings.activeFamily || DEFAULT_FAMILY_ID);
  for (let i = inkState.entries.length - 1; i >= 0; i -= 1) {
    const e = inkState.entries[i];
    if (String(e.inkFamily || DEFAULT_FAMILY_ID) !== active) continue;
    const n = Number(e.nominalCarbonWtPctAtSample);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 25;
}

function renderFamilyFilterOptions() {
  const sel = document.getElementById('ink-family-filter');
  if (!sel) return;
  const familyList = getFamilyList();
  const active = String(inkState.settings.activeFamily || DEFAULT_FAMILY_ID);
  sel.innerHTML = familyList
    .map(f => `<option value="${escapeHtmlAttr(f)}"${f === active ? ' selected' : ''}>${escapeHtml(f)}</option>`)
    .join('');
}

function syncActiveFamily() {
  if (!inkState.settings.activeFamily) inkState.settings.activeFamily = DEFAULT_FAMILY_ID;
  const active = String(inkState.settings.activeFamily);
  const list = getFamilyList();
  if (!list.includes(active)) inkState.settings.activeFamily = list[0] || DEFAULT_FAMILY_ID;
}

function computeAddbackForVolume(volumeMl, densityGml, estimatedCarbonWtPct, nominalCarbonWtPct, ipaDensityGml) {
  const currentMassG = densityGml * volumeMl;
  const factor = nominalCarbonWtPct > 0 ? (estimatedCarbonWtPct / nominalCarbonWtPct) : 1;
  const ipaAddG = Math.max(0, currentMassG * (factor - 1));
  const ipaAddMl = ipaDensityGml > 0 ? ipaAddG / ipaDensityGml : 0;
  return { ipaAddG, ipaAddMl };
}

function computeDilutionToTargetForVolume(volumeMl, densityGml, currentCarbonWtPct, targetCarbonWtPct, ipaDensityGml) {
  const currentMassG = densityGml * volumeMl;
  const factor = targetCarbonWtPct > 0 ? (currentCarbonWtPct / targetCarbonWtPct) : 1;
  const ipaAddG = Math.max(0, currentMassG * (factor - 1));
  const ipaAddMl = ipaDensityGml > 0 ? ipaAddG / ipaDensityGml : 0;
  return { ipaAddG, ipaAddMl };
}

function computeDensity(entry) {
  const ml = entry.sampleVolumeUl / 1000;
  if (!ml) return 0;
  return entry.sampleMassG / ml;
}

function findBaselineEntry(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].useAsBaseline) return entries[i];
  }
  return entries[0] || null;
}

function findBaselineRow(rows) {
  if (!rows.length) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].entry.useAsBaseline) return rows[i];
  }
  return rows[0];
}

function startReminderLoop() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(updateReminderUI, 60_000);
  updateReminderUI();
}

function updateReminderUI() {
  const due = isReminderDue();
  const banner = document.getElementById('ink-reminder-banner');
  if (!banner) return;
  banner.classList.toggle('d-none', !due);
  if (due) maybeShowReminderModal();
}

function maybeShowReminderModal() {
  if (reminderModalShown) return;
  if (!isReminderDue()) return;
  if (!isInkTabActive()) return;
  if (typeof bootstrap === 'undefined') return;
  const modalEl = document.getElementById('ink-reminder-modal');
  if (!modalEl) return;
  try {
    const modal = new bootstrap.Modal(modalEl);
    modal.show();
    reminderModalShown = true;
  } catch (_) {
    // ignore modal errors
  }
}

function dismissReminder() {
  const hours = REMINDER_SNOOZE_HOURS;
  inkState.reminder.snoozeUntil = Date.now() + hours * 3_600_000;
  saveState();
  updateReminderUI();
}

function isReminderDue() {
  const now = Date.now();
  const snooze = Number(inkState?.reminder?.snoozeUntil || 0);
  if (now < snooze) return false;
  const hours = Number(inkState?.settings?.reminderHours || DEFAULTS.reminderHours);
  const visible = getVisibleEntries();
  const latest = visible[visible.length - 1];
  if (!latest) return true;
  const lastTs = new Date(latest.timestamp).getTime();
  return (now - lastTs) >= hours * 3_600_000;
}

function openInkTabAndFocus() {
  try {
    const tabBtn = document.getElementById('tab-ink');
    if (tabBtn && typeof bootstrap !== 'undefined' && bootstrap.Tab) {
      bootstrap.Tab.getOrCreateInstance(tabBtn).show();
    }
  } catch (_) {}
  const input = document.getElementById('ink-sample-mass-g');
  if (input) input.focus();
}

function bindTabActivationReminder() {
  const inkTabBtn = document.getElementById('tab-ink');
  if (!inkTabBtn) return;
  inkTabBtn.addEventListener('shown.bs.tab', () => {
    reminderModalShown = false;
    updateReminderUI();
    if (pendingDataPrompt) promptLoadHistoricalData();
  });
}

function isInkTabActive() {
  const panel = document.getElementById('panel-ink');
  return !!panel && panel.classList.contains('active') && panel.classList.contains('show');
}

async function hydratePersistentState() {
  if (!window.inkDataAPI) {
    setStorageStatus('Local browser storage only (desktop file persistence unavailable).');
    return;
  }
  const loaded = await loadFromStoredFile({ quietMissing: true });
  if (loaded) return;

  if ((inkState.entries || []).length > 0) {
    const saved = await persistToStoredFile(true);
    if (saved) setInkStatus('Migrated existing local history into desktop stored file.');
    return;
  }
  promptLoadHistoricalData();
}

async function loadFromStoredFile(options = {}) {
  if (!window.inkDataAPI?.loadDefault) return false;
  const result = await window.inkDataAPI.loadDefault();
  if (!result?.ok) {
    setInkStatus(`Stored file load failed: ${result?.error || 'unknown error'}`);
    return false;
  }
  persistentFilePath = result.filePath || persistentFilePath;
  setStorageStatus(persistentFilePath ? `Stored file: ${persistentFilePath}` : '');
  if (!result.exists || !result.data) {
    if (!options.quietMissing) setInkStatus('No stored file found yet.');
    return false;
  }
  inkState = normalizeState(result.data);
  saveState({ skipPersist: true });
  renderAll();
  setInkStatus(`Loaded stored history (${inkState.entries.length} entries).`);
  return true;
}

async function persistToStoredFile(silent = false) {
  if (!window.inkDataAPI?.saveDefault) return false;
  const payload = buildPersistencePayload(normalizeState(inkState));
  const result = await window.inkDataAPI.saveDefault(payload);
  if (!result?.ok) {
    if (!silent) setInkStatus(`Stored file save failed: ${result?.error || 'unknown error'}`);
    return false;
  }
  persistentFilePath = result.filePath || persistentFilePath;
  setStorageStatus(persistentFilePath ? `Stored file: ${persistentFilePath}` : '');
  if (!silent) setInkStatus(`Saved to stored file (${inkState.entries.length} entries).`);
  return true;
}

async function importInkJson() {
  if (window.inkDataAPI?.importJson) {
    const result = await window.inkDataAPI.importJson();
    if (!result?.ok) {
      setInkStatus(`Import failed: ${result?.error || 'unknown error'}`);
      return;
    }
    if (result.canceled) return;
    inkState = normalizeState(result.data);
    saveState();
    renderAll();
    setInkStatus(`Imported ${inkState.entries.length} entries from ${result.filePath || 'JSON file'}.`);
    return;
  }
  setInkStatus('Import JSON is available in Electron desktop mode.');
}

async function exportInkJson() {
  const payload = buildPersistencePayload(normalizeState(inkState));
  if (window.inkDataAPI?.exportJson) {
    const result = await window.inkDataAPI.exportJson(payload);
    if (!result?.ok) {
      setInkStatus(`Export failed: ${result?.error || 'unknown error'}`);
      return;
    }
    if (result.canceled) return;
    setInkStatus(`Exported JSON to ${result.filePath || 'selected path'}.`);
    return;
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ink-check-data-${stampForFile(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setInkStatus('Exported JSON via browser download.');
}

function promptLoadHistoricalData() {
  if (!isInkTabActive()) {
    pendingDataPrompt = true;
    setInkStatus('No stored history found. Open Ink Check tab and use Import JSON to load historical data.');
    return;
  }
  pendingDataPrompt = false;
  if (typeof bootstrap === 'undefined') {
    setInkStatus('No stored history found. Use Import JSON to load historical data.');
    return;
  }
  const modalEl = document.getElementById('ink-data-modal');
  if (!modalEl) return;
  try {
    const modal = new bootstrap.Modal(modalEl);
    modal.show();
  } catch (_) {
    setInkStatus('No stored history found. Use Import JSON to load historical data.');
  }
}

function setInkStatus(message) {
  const el = document.getElementById('ink-status');
  if (el) el.textContent = message || '';
}

function setStorageStatus(message) {
  const el = document.getElementById('ink-storage-path');
  if (el) el.textContent = message || '';
}

function buildPersistencePayload(state) {
  return {
    version: DATA_VERSION,
    updatedAt: new Date().toISOString(),
    state
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultState();
    return normalizeState(JSON.parse(raw));
  } catch (_) {
    return createDefaultState();
  }
}

function saveState(options = {}) {
  const normalized = normalizeState(inkState);
  inkState = normalized;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch (_) {}
  if (!options.skipPersist) {
    void persistToStoredFile(true);
  }
}

function createDefaultState() {
  return {
    entries: [],
    settings: {
      activeFamily: DEFAULTS.activeFamily,
      ipaDensityGml: DEFAULTS.ipaDensityGml,
      reminderHours: DEFAULTS.reminderHours,
      defaultSampleVolumeUl: DEFAULTS.defaultSampleVolumeUl,
      defaultBottleVolumeMl: DEFAULTS.defaultBottleVolumeMl
    },
    reminder: { snoozeUntil: 0 }
  };
}

function normalizeState(state) {
  const src = (state && typeof state === 'object' && state.state && typeof state.state === 'object')
    ? state.state
    : state;
  const safe = createDefaultState();
  if (!src || typeof src !== 'object') return safe;
  safe.settings.activeFamily = String(src.settings?.activeFamily || DEFAULTS.activeFamily);
  safe.settings.ipaDensityGml = clampNum(src.settings?.ipaDensityGml, 0.1, 2, DEFAULTS.ipaDensityGml);
  safe.settings.reminderHours = clampNum(src.settings?.reminderHours, 1, 168, DEFAULTS.reminderHours);
  safe.settings.defaultSampleVolumeUl = clampNum(src.settings?.defaultSampleVolumeUl, 100, 500000, DEFAULTS.defaultSampleVolumeUl);
  safe.settings.defaultBottleVolumeMl = clampNum(src.settings?.defaultBottleVolumeMl, 1, 2000, DEFAULTS.defaultBottleVolumeMl);
  safe.reminder.snoozeUntil = Number(src.reminder?.snoozeUntil || 0);

  if (Array.isArray(src.entries)) {
    safe.entries = src.entries
      .map(e => ({
        id: String(e.id || ''),
        timestamp: String(e.timestamp || ''),
        bottleState: e.bottleState === 'brand_new' ? 'brand_new' : 'opened',
        inkFamily: String(e.inkFamily || DEFAULT_FAMILY_ID),
        nominalCarbonWtPctAtSample: clampNum(e.nominalCarbonWtPctAtSample, 0.1, 95, 25),
        sampleVolumeUl: Number(e.sampleVolumeUl),
        sampleMassG: Number(e.sampleMassG),
        bottleVolumeMl: Number(e.bottleVolumeMl),
        note: String(e.note || ''),
        useAsBaseline: !!e.useAsBaseline
      }))
      .filter(e =>
        e.timestamp &&
        Number.isFinite(e.sampleVolumeUl) && e.sampleVolumeUl > 0 &&
        Number.isFinite(e.sampleMassG) && e.sampleMassG > 0 &&
        Number.isFinite(e.bottleVolumeMl) && e.bottleVolumeMl > 0
      );
  }
  return safe;
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function fmt(v, digits = 3) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return n.toFixed(digits);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

function escapeHtmlAttr(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function stampForFile(d) {
  const p = v => String(v).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
