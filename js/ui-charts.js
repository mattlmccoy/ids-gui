/* ===== ui-charts.js — Trending tab (Chart.js temperature + pressure graphs) ===== */

import store from './state.js';
import { isDataKeyVisible } from './heater-visibility.js';
import { getPollIntervalMs, setPollIntervalMs, getNominalPollIntervalMs } from './transport.js';
import { FLOATS, getFloatDisplayState, formatFloatState } from './float-state.js';
import { initTrendHistory, persistTrendPoint, clearTrendHistory } from './trend-history.js';
import { calculateDualPressure, filterActivePressureTraces } from './pressure-sensing.js';
import { CHART_IDS, normalizeVisibleCharts } from './chart-visibility.js';

const MAX_POINTS = 18_000; // one hour at the fastest supported 200 ms poll rate
const STATE_TRACKS_KEY = 'ids-visible-state-tracks-v1';
const VISIBLE_CHARTS_KEY = 'ids-visible-charts-v1';
// Maps a logical chart id to the DOM id of its wrapping column, plus a human label for the toggle UI.
const CHART_CARDS = [
  { id: 'temperature', cardId: 'chart-card-temperature', label: 'Temperature' },
  { id: 'pressure', cardId: 'chart-card-pressure', label: 'Pressure / Vacuum' },
  { id: 'states', cardId: 'state-track-card', label: 'Floats & State' }
];
const TIME_WINDOWS = [
  { label: '1m',  ms: 60_000 },
  { label: '5m',  ms: 300_000 },
  { label: '15m', ms: 900_000 },
  { label: '30m', ms: 1_800_000 },
  { label: '1h',  ms: 3_600_000 },
];

const TEMP_TRACES = [
  { key: 'FluidTemperature_STATE',      label: 'Fluid Temp',  color: '#4c8dff' },
  { key: 'MainHeaterTemperature_STATE',  label: 'Main Heater', color: '#f87171' },
  { key: 'AUXHeaterTemperature_STATE',   label: 'Aux Heater',  color: '#fb923c' },
  { key: 'Temperature_SETPOINT',         label: 'Setpoint',    color: '#34d399', borderDash: [5, 5] },
];

const PRESSURE_TRACES = [
  { key: 'Vacuum_STATE',    label: 'Vacuum (cmH\u2082O)',      color: '#4c8dff', yAxisID: 'yVacuum' },
  { key: 'Vacuum_SETPOINT', label: 'Vac Setpoint (% raw)',     color: '#34d399', borderDash: [5, 5], yAxisID: 'ySetpoint' },
  { key: 'Pressure_STATE',  label: 'Pressure (psi)',           color: '#f87171', yAxisID: 'yPressure' },
  { key: 'InletPressureAdjusted', label: 'Printhead inlet (psi)', color: '#f59e0b', yAxisID: 'yPressure' },
  { key: 'ReturnPressureAdjusted', label: 'Printhead return (psi)', color: '#a78bfa', yAxisID: 'yPressure' },
  { key: 'DifferentialPressureDerived', label: 'Printhead ΔP (psi)', color: '#22d3ee', yAxisID: 'yPressure' },
  { key: 'MeniscusPressureEstimated', label: 'Meniscus estimate (psi)', color: '#34d399', borderDash: [4, 4], yAxisID: 'yPressure' },
];

const PUMP_TRACES = [
  ['InputPump_STATE', 'Input Pump'], ['RecirculationPump_STATE', 'Recirc Pump'],
  ['DrainPump_STATE', 'Drain Pump'], ['BulkSupplyPump_STATE', 'Bulk Supply Pump'],
  ['VacuumPump_STATE', 'Vacuum Pump'], ['flushPump_STATE', 'Flush Pump'],
  ['ServiceRecirculationPump_STATE', 'Service Recirc Pump']
];
const VALVE_TRACES = [
  ['ManifoldValve1_STATE', 'Manifold Valve 1'], ['ManifoldValve2_STATE', 'Manifold Valve 2'],
  ['DrainValve_STATE', 'Drain Valve'], ['BulkSupplyValve_STATE', 'Bulk Supply Valve'],
  ['flushValve_STATE', 'Flush Valve'],
  ['ServiceInputValve_STATE', 'Service Input Valve'],
  ['serviceRecirculationValve_STATE', 'Service Recirc Valve']
];
const STATE_COLORS = ['#4c8dff', '#34d399', '#f87171', '#fb923c', '#a78bfa', '#22d3ee', '#fbbf24', '#f472b6', '#60a5fa', '#2dd4bf', '#f97316', '#c084fc', '#84cc16', '#e879f9', '#38bdf8', '#facc15', '#fb7185', '#10b981', '#818cf8', '#eab308', '#06b6d4', '#a3e635'];
const STATE_TRACES = [
  ...FLOATS.map(f => ({ ...f, group: 'Floats', display: raw => getFloatDisplayState(f.key, raw) })),
  ...PUMP_TRACES.map(([key, label]) => ({ key, label, group: 'Pumps', display: normalizeBinary })),
  ...VALVE_TRACES.map(([key, label]) => ({ key, label, group: 'Valves', display: normalizeBinary }))
].map((trace, index) => ({ ...trace, color: trace.color || STATE_COLORS[index % STATE_COLORS.length] }));
const DEFAULT_STATE_KEYS = new Set(['WeirFloat_STATE', 'WeirOverflowFloat_STATE', 'VacuumPump_STATE', 'ManifoldValve1_STATE']);

let dataBuffer = [];
let tempChart = null;
let pressureChart = null;
let stateChart = null;
let paused = false;
let windowMs = TIME_WINDOWS[1].ms;
let maxObservedPressure = 0;
// Pressure traces actually shown: the derived dual-pressure series are dropped while the feature is disabled.
let activePressureTraces = filterActivePressureTraces(PRESSURE_TRACES);
let visibleStateKeys = readStateTrackPreference();
let visibleCharts = readVisibleChartsPreference();
let replaySamples = [];
let replayTimer = null;

export function initChartsTab() {
  const panel = document.getElementById('panel-trending');
  panel.innerHTML = buildHTML();
  createCharts();
  applyChartVisibility();
  bindEvents();
  store.on('data', onData);
  store.on('heater-visibility', refreshCharts);
  store.on('float-config', () => {
    updateFloatStatus(store.data);
    refreshCharts();
  });
  store.on('replay', updateReplayControls);
  store.on('pressure-sensing-config', rebuildPressureTraces);
  initTrendHistory().then(samples => {
    if (!samples.length || dataBuffer.length) return;
    dataBuffer = samples.slice(-MAX_POINTS);
    for (const point of dataBuffer) {
      const pressure = Number(point.Pressure_STATE);
      if (Number.isFinite(pressure)) maxObservedPressure = Math.max(maxObservedPressure, pressure);
    }
    refreshCharts();
    store.log('info', `Restored ${dataBuffer.length} persisted trend samples`);
  }).catch(error => console.warn('[trend-history] Restore failed:', error));
  document.getElementById('tab-trending')?.addEventListener('shown.bs.tab', () => {
    requestAnimationFrame(() => {
      tempChart?.resize();
      pressureChart?.resize();
      stateChart?.resize();
      refreshCharts();
    });
  });
}

function buildHTML() {
  return `
    <div class="d-flex flex-wrap gap-2 mb-3 align-items-center">
      <span style="color:var(--text-secondary);font-weight:500;font-size:0.82rem">Time Window:</span>
      <div class="d-flex gap-1" id="time-window-btns">
        ${TIME_WINDOWS.map((tw, i) => `
          <button class="btn-control ${i === 1 ? 'btn-connect' : 'btn-disconnect'} btn-tw"
                  data-ms="${tw.ms}" style="padding:0.25rem 0.6rem;font-size:0.75rem">${tw.label}</button>
        `).join('')}
      </div>
      <span style="width:1px;height:20px;background:var(--border-color)"></span>
      <button class="btn-control btn-disconnect" id="btn-chart-pause" style="padding:0.25rem 0.6rem;font-size:0.75rem">
        <i class="bi bi-pause-fill me-1"></i>Pause
      </button>
      <button class="btn-control btn-reboot" id="btn-chart-clear" style="padding:0.25rem 0.6rem;font-size:0.75rem">
        <i class="bi bi-trash me-1"></i>Clear
      </button>
      <button class="btn-control btn-disconnect" id="btn-replay-save" style="padding:0.25rem 0.6rem;font-size:0.75rem" title="Save current trend data as a replay file">
        <i class="bi bi-record-circle me-1"></i>Save replay
      </button>
      <button class="btn-control btn-disconnect" id="btn-replay-load" style="padding:0.25rem 0.6rem;font-size:0.75rem" title="Load a saved IDS replay file">
        <i class="bi bi-folder2-open me-1"></i>Load replay
      </button>
      <input type="file" id="replay-file-input" accept="application/json,.json" class="d-none">
      <select class="form-select form-select-sm" id="replay-speed" style="width:72px" title="Replay speed">
        <option value="1">1×</option><option value="2">2×</option><option value="5">5×</option><option value="10">10×</option>
      </select>
      <button class="btn-control btn-connect" id="btn-replay-play" disabled style="padding:0.25rem 0.6rem;font-size:0.75rem">
        <i class="bi bi-play-fill me-1"></i>Play
      </button>
      <span style="width:1px;height:20px;background:var(--border-color)"></span>
      <span style="color:var(--text-secondary);font-weight:500;font-size:0.82rem">Data Poll (ms):</span>
      <input type="number" id="poll-interval-ms" min="200" max="5000" step="50" class="form-control form-control-sm" style="width:92px">
      <button class="btn-control btn-connect" id="btn-poll-apply" style="padding:0.25rem 0.6rem;font-size:0.75rem">Apply</button>
      <button class="btn-control btn-disconnect" id="btn-poll-nominal" style="padding:0.25rem 0.6rem;font-size:0.75rem">Nominal</button>
      <span class="ms-auto" style="color:var(--text-muted);font-size:0.75rem" id="chart-point-count">0 points</span>
    </div>
    <div class="d-flex flex-wrap gap-3 align-items-center mb-2" aria-label="Visible charts">
      <span style="color:var(--text-secondary);font-weight:500;font-size:0.82rem"><i class="bi bi-bar-chart-line me-1"></i>Show charts:</span>
      ${CHART_CARDS.map(c => `
        <label class="form-check form-check-inline mb-0">
          <input class="form-check-input chart-visibility-checkbox" type="checkbox" value="${c.id}" ${visibleCharts[c.id] ? 'checked' : ''}>
          <span class="form-check-label small">${c.label}</span>
        </label>
      `).join('')}
    </div>
    <div class="float-status-strip mb-3" aria-label="Current float switch status">
      ${FLOATS.map(f => `
        <div class="float-status-chip" id="float-status-${f.key}">
          <span class="state-dot off"></span>
          <span>${f.label}</span>
          <strong>--</strong>
        </div>
      `).join('')}
    </div>
    <div class="row g-3">
      <div class="col-12" id="chart-card-temperature">
        <div class="dash-card accent-blue">
          <div class="card-header"><i class="bi bi-thermometer-half me-1"></i> Temperature</div>
          <div class="card-body">
            <div class="chart-container"><canvas id="chart-temperature"></canvas></div>
          </div>
        </div>
      </div>
      <div class="col-12" id="chart-card-pressure">
        <div class="dash-card accent-purple">
          <div class="card-header"><i class="bi bi-speedometer me-1"></i> Pressure / Vacuum</div>
          <div class="card-body">
            <div class="chart-container"><canvas id="chart-pressure"></canvas></div>
            <div class="small mt-2" style="color:var(--text-muted)">
              Vacuum setpoint is shown in controller raw percent scale. Pressure axis is fixed to readable psi range.
            </div>
          </div>
        </div>
      </div>
      <div class="col-12" id="state-track-card">
        <div class="dash-card accent-cyan">
          <div class="card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
            <span><i class="bi bi-toggles me-1"></i> Machine State History</span>
            <span class="small" style="color:var(--text-muted)">Same time axis as Pressure / Vacuum</span>
          </div>
          <div class="card-body">
            <div class="state-trace-picker mb-3">
              ${['Floats', 'Pumps', 'Valves'].map(group => `
                <fieldset>
                  <legend>${group}</legend>
                  <div class="d-flex flex-wrap gap-3 row-gap-2">
                    ${STATE_TRACES.filter(t => t.group === group).map(t => `
                      <label class="form-check form-check-inline mb-0">
                        <input class="form-check-input state-track-checkbox" type="checkbox" value="${t.key}"
                               ${visibleStateKeys.has(t.key) ? 'checked' : ''}>
                        <span class="form-check-label small">${t.label}</span>
                      </label>
                    `).join('')}
                  </div>
                </fieldset>
              `).join('')}
            </div>
            <div class="chart-container chart-container-states"><canvas id="chart-states"></canvas></div>
            <div class="small mt-2" style="color:var(--text-muted)">
              Each selected lane steps between OFF and ON; float lanes use DOWN and UP. Raw firmware samples remain unchanged in exported data.
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function createCharts() {
  const gridColor = 'rgba(42,46,58,0.6)';
  const tickColor = '#8b8fa3';

  const commonOpts = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    scales: {
      x: {
        type: 'time',
        time: { tooltipFormat: 'HH:mm:ss', displayFormats: { second: 'HH:mm:ss', minute: 'HH:mm' } },
        grid: { color: gridColor },
        ticks: { color: tickColor, font: { size: 10 } }
      },
      y: {
        beginAtZero: true,
        grid: { color: gridColor },
        ticks: { color: tickColor, font: { size: 10 } }
      }
    },
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 10, color: tickColor, font: { size: 10 } } }
    }
  };

  tempChart = new Chart(document.getElementById('chart-temperature'), {
    type: 'line',
    data: {
      datasets: TEMP_TRACES.map(t => ({
        label: t.label, borderColor: t.color, backgroundColor: t.color + '15',
        borderWidth: 1.5, borderDash: t.borderDash || [], pointRadius: 0, tension: 0.3, data: []
      }))
    },
    options: { ...commonOpts, scales: { ...commonOpts.scales, y: { ...commonOpts.scales.y, title: { display: true, text: '\u00B0C', color: tickColor } } } }
  });

  pressureChart = new Chart(document.getElementById('chart-pressure'), {
    type: 'line',
    data: {
      datasets: activePressureTraces.map(pressureDataset)
    },
    options: {
      ...commonOpts,
      scales: {
        x: commonOpts.scales.x,
        yVacuum: {
          beginAtZero: false,
          grid: commonOpts.scales.y.grid,
          ticks: commonOpts.scales.y.ticks,
          title: { display: true, text: 'Vacuum (cmH\u2082O)', color: tickColor }
        },
        ySetpoint: {
          position: 'right',
          min: 0,
          max: 100,
          grid: { drawOnChartArea: false },
          ticks: { color: tickColor, font: { size: 10 } },
          title: { display: true, text: 'Vac Setpoint (% raw)', color: tickColor }
        },
        yPressure: {
          position: 'right',
          offset: true,
          beginAtZero: false,
          grid: { drawOnChartArea: false },
          ticks: { color: tickColor, font: { size: 10 } },
          title: { display: true, text: 'Pressure (psi)', color: tickColor }
        }
      },
      plugins: {
        ...commonOpts.plugins,
        legend: {
          ...commonOpts.plugins.legend,
          onClick: (e, legendItem, legend) => {
            const ci = legend.chart;
            const idx = legendItem.datasetIndex;
            if (ci.isDatasetVisible(idx)) ci.hide(idx);
            else ci.show(idx);
            syncPressureAxisVisibility(ci);
            ci.update();
          }
        }
      }
    }
  });
  syncPressureAxisVisibility(pressureChart);

  stateChart = new Chart(document.getElementById('chart-states'), {
    type: 'line',
    data: { datasets: [] },
    options: {
      ...commonOpts,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: commonOpts.scales.x,
        y: {
          min: -0.35,
          max: 1.65,
          grid: { color: gridColor },
          afterBuildTicks: axis => {
            const count = Math.max(stateChart?.data?.datasets?.length || 1, 1);
            axis.ticks = Array.from({ length: count * 2 }, (_, value) => ({ value }));
          },
          ticks: {
            color: tickColor,
            font: { size: 9 },
            callback: value => {
              const index = Math.floor(Number(value) / 2);
              const trace = stateChart?.data?.datasets?.[index]?.trace;
              if (!trace) return '';
              const on = Number(value) % 2 === 1;
              const state = trace.group === 'Floats' ? (on ? 'UP' : 'DOWN') : (on ? 'ON' : 'OFF');
              return `${trace.label} ${state}`;
            }
          }
        }
      },
      plugins: {
        ...commonOpts.plugins,
        tooltip: {
          callbacks: {
            label: item => {
              const trace = item.dataset.trace;
              const on = Math.round(item.parsed.y) % 2 === 1;
              const state = trace.group === 'Floats' ? (on ? 'ON / UP' : 'OFF / DOWN') : (on ? 'ON' : 'OFF');
              return `${trace.label}: ${state}`;
            }
          }
        }
      }
    }
  });
}

function bindEvents() {
  document.querySelectorAll('.btn-tw').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-tw').forEach(b => b.className = 'btn-control btn-disconnect btn-tw');
      btn.className = 'btn-control btn-connect btn-tw';
      windowMs = parseInt(btn.dataset.ms);
      refreshCharts();
    });
  });

  document.getElementById('btn-chart-pause').addEventListener('click', function () {
    paused = !paused;
    this.innerHTML = paused ? '<i class="bi bi-play-fill me-1"></i>Resume' : '<i class="bi bi-pause-fill me-1"></i>Pause';
  });

  document.getElementById('btn-chart-clear').addEventListener('click', () => {
    dataBuffer = [];
    maxObservedPressure = 0;
    clearTrendHistory().catch(error => console.warn('[trend-history] Clear failed:', error));
    refreshCharts();
  });
  document.getElementById('btn-replay-save')?.addEventListener('click', saveReplayFile);
  document.getElementById('btn-replay-load')?.addEventListener('click', () => document.getElementById('replay-file-input')?.click());
  document.getElementById('replay-file-input')?.addEventListener('change', loadReplayFile);
  document.getElementById('btn-replay-play')?.addEventListener('click', toggleReplay);
  const pollInput = document.getElementById('poll-interval-ms');
  const pollApply = document.getElementById('btn-poll-apply');
  const pollNominal = document.getElementById('btn-poll-nominal');
  if (pollInput) pollInput.value = String(getPollIntervalMs());
  pollApply?.addEventListener('click', () => {
    const next = setPollIntervalMs(pollInput?.value ?? '');
    if (pollInput) pollInput.value = String(next);
  });
  pollInput?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const next = setPollIntervalMs(pollInput.value);
    pollInput.value = String(next);
  });
  pollNominal?.addEventListener('click', () => {
    const next = setPollIntervalMs(getNominalPollIntervalMs());
    if (pollInput) pollInput.value = String(next);
  });
  document.querySelectorAll('.state-track-checkbox').forEach(input => input.addEventListener('change', () => {
    visibleStateKeys = new Set(Array.from(document.querySelectorAll('.state-track-checkbox:checked')).map(el => el.value));
    persistStateTrackPreference();
    refreshCharts();
    requestAnimationFrame(() => stateChart?.resize());
  }));
  document.querySelectorAll('.chart-visibility-checkbox').forEach(input => input.addEventListener('change', () => {
    const checked = new Set(Array.from(document.querySelectorAll('.chart-visibility-checkbox:checked')).map(el => el.value));
    visibleCharts = normalizeVisibleCharts(Object.fromEntries(CHART_IDS.map(id => [id, checked.has(id)])));
    persistVisibleCharts();
    applyChartVisibility();
  }));
}

function pressureDataset(t) {
  return {
    label: t.label, borderColor: t.color, backgroundColor: t.color + '15',
    borderWidth: 1.5, borderDash: t.borderDash || [], pointRadius: 0, tension: 0.3, data: [],
    yAxisID: t.yAxisID || 'y'
  };
}

// Rebuild the pressure chart's dataset set (and legend) when the dual-pressure feature is toggled.
function rebuildPressureTraces() {
  activePressureTraces = filterActivePressureTraces(PRESSURE_TRACES);
  if (!pressureChart) return;
  pressureChart.data.datasets = activePressureTraces.map(pressureDataset);
  refreshCharts();
}

function onData(data) {
  updateFloatStatus(data);
  if (paused) return;
  const point = { timestamp: Date.now() };
  const dualPressure = calculateDualPressure(data);
  if (dualPressure.available) {
    point.InletPressureAdjusted = dualPressure.inletPsi;
    point.ReturnPressureAdjusted = dualPressure.returnPsi;
    point.DifferentialPressureDerived = dualPressure.differentialPsi;
    point.MeniscusPressureEstimated = dualPressure.estimatedMeniscusPsi;
  }
  const p = parseFloat(data.Pressure_STATE);
  if (Number.isFinite(p)) maxObservedPressure = Math.max(maxObservedPressure, p);
  let hasValue = false;
  for (const t of [...TEMP_TRACES, ...activePressureTraces]) {
    if (!isDataKeyVisible(t.key)) continue;
    if (data[t.key] !== undefined) {
      point[t.key] = parseFloat(data[t.key]);
      if (!isNaN(point[t.key])) hasValue = true;
    }
  }
  for (const trace of STATE_TRACES) {
    if (data[trace.key] === undefined) continue;
    point[trace.key] = data[trace.key];
    hasValue = true;
  }
  if (!hasValue) return;
  dataBuffer.push(point);
  if (dataBuffer.length > MAX_POINTS) dataBuffer = dataBuffer.slice(-MAX_POINTS);
  if (!store.replayActive) persistTrendPoint(point);
  refreshCharts();
}

function refreshCharts() {
  const now = Date.now();
  const cutoff = now - windowMs;
  const visible = dataBuffer.filter(p => p.timestamp >= cutoff);
  const countEl = document.getElementById('chart-point-count');
  if (countEl) countEl.textContent = `${dataBuffer.length} points`;

  TEMP_TRACES.forEach((t, i) => {
    tempChart.data.datasets[i].hidden = !isDataKeyVisible(t.key);
    tempChart.data.datasets[i].data = visible.filter(p => p[t.key] !== undefined).map(p => ({ x: p.timestamp, y: p[t.key] }));
  });
  tempChart.update('none');

  activePressureTraces.forEach((t, i) => {
    pressureChart.data.datasets[i].hidden = !isDataKeyVisible(t.key);
    pressureChart.data.datasets[i].data = visible.filter(p => p[t.key] !== undefined).map(p => ({ x: p.timestamp, y: p[t.key] }));
  });
  pressureChart.options.scales.x.min = cutoff;
  pressureChart.options.scales.x.max = now;
  updatePressureAxisRange();
  syncPressureAxisVisibility(pressureChart);
  pressureChart.update('none');

  if (stateChart) {
    const selected = STATE_TRACES.filter(trace => visibleStateKeys.has(trace.key));
    stateChart.data.datasets = selected.map((trace, lane) => ({
      label: trace.label, trace,
      borderColor: trace.color, backgroundColor: trace.color,
      borderWidth: 2, pointRadius: 0, stepped: true, spanGaps: true,
      data: visible
        .filter(point => point[trace.key] !== undefined && trace.display(point[trace.key]) !== null)
        .map(point => ({ x: point.timestamp, y: lane * 2 + trace.display(point[trace.key]) }))
    }));
    stateChart.options.scales.x.min = cutoff;
    stateChart.options.scales.x.max = now;
    stateChart.options.scales.y.max = Math.max(selected.length * 2 - 0.65, 1.65);
    stateChart.update('none');
  }
}

export function getChartData() { return dataBuffer; }

function updatePressureAxisRange() {
  if (!pressureChart?.options?.scales?.yPressure) return;
  const configuredMax = Number(store.data?.PressureMAX_SETPOINT);
  const targetMax = Math.max(
    5,
    Number.isFinite(configuredMax) ? configuredMax : 0,
    maxObservedPressure * 1.2
  );
  const rounded = Math.ceil(targetMax / 5) * 5;
  pressureChart.options.scales.yPressure.max = rounded;
}

function syncPressureAxisVisibility(chart) {
  if (!chart?.options?.scales) return;
  const hasVisibleForAxis = (axisId) => chart.data.datasets.some((ds, i) => {
    const dsAxis = ds.yAxisID || 'y';
    if (dsAxis !== axisId) return false;
    return chart.isDatasetVisible(i);
  });
  chart.options.scales.yVacuum.display = hasVisibleForAxis('yVacuum');
  chart.options.scales.ySetpoint.display = hasVisibleForAxis('ySetpoint');
  chart.options.scales.yPressure.display = hasVisibleForAxis('yPressure');
}

function updateFloatStatus(data) {
  for (const f of FLOATS) {
    if (data[f.key] === undefined) continue;
    const chip = document.getElementById(`float-status-${f.key}`);
    if (!chip) continue;
    const state = getFloatDisplayState(f.key, data[f.key]);
    const dot = chip.querySelector('.state-dot');
    const text = chip.querySelector('strong');
    if (dot) dot.className = `state-dot ${state === 1 ? 'on' : 'off'}`;
    if (text) text.textContent = formatFloatState(f.key, data[f.key]);
  }
}

function normalizeBinary(raw) {
  if (raw === true || raw === 1 || raw === '1') return 1;
  if (raw === false || raw === 0 || raw === '0') return 0;
  return null;
}

function readStateTrackPreference() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STATE_TRACKS_KEY) || 'null');
    if (Array.isArray(parsed)) return new Set(parsed.filter(key => STATE_TRACES.some(trace => trace.key === key)));
  } catch (_) { /* use defaults */ }
  return new Set(DEFAULT_STATE_KEYS);
}

function persistStateTrackPreference() {
  try { localStorage.setItem(STATE_TRACKS_KEY, JSON.stringify([...visibleStateKeys])); } catch (_) { /* ignore */ }
}

function readVisibleChartsPreference() {
  try { return normalizeVisibleCharts(JSON.parse(localStorage.getItem(VISIBLE_CHARTS_KEY) || 'null')); }
  catch (_) { return normalizeVisibleCharts(null); }
}

function persistVisibleCharts() {
  try { localStorage.setItem(VISIBLE_CHARTS_KEY, JSON.stringify(visibleCharts)); } catch (_) { /* ignore */ }
}

// Show/hide each Trends chart card per the saved preference, then resize the ones now visible.
function applyChartVisibility() {
  for (const card of CHART_CARDS) {
    const el = document.getElementById(card.cardId);
    if (el) el.style.display = visibleCharts[card.id] ? '' : 'none';
  }
  requestAnimationFrame(() => {
    if (visibleCharts.temperature) tempChart?.resize();
    if (visibleCharts.pressure) pressureChart?.resize();
    if (visibleCharts.states) stateChart?.resize();
  });
}

function saveReplayFile() {
  if (!dataBuffer.length) {
    store.log('warning', 'No trend data is available to save as a replay');
    return;
  }
  const recording = {
    format: 'ids-replay-v1',
    createdAt: new Date().toISOString(),
    sampleCount: dataBuffer.length,
    samples: dataBuffer
  };
  const blob = new Blob([JSON.stringify(recording)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ids-replay-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  link.click();
  URL.revokeObjectURL(url);
  store.log('info', `Saved ${dataBuffer.length} samples as a replay`);
}

async function loadReplayFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed.format !== 'ids-replay-v1' || !Array.isArray(parsed.samples) || !parsed.samples.length) {
      throw new Error('not an IDS replay file');
    }
    replaySamples = parsed.samples
      .filter(sample => sample && Number.isFinite(Number(sample.timestamp)))
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    if (!replaySamples.length) throw new Error('recording has no valid samples');
    updateReplayControls();
    store.log('info', `Loaded replay with ${replaySamples.length} samples`);
  } catch (error) {
    store.log('error', `Replay load failed: ${error.message}`);
  }
}

function toggleReplay() {
  if (store.replayActive) stopReplay();
  else startReplay();
}

function startReplay() {
  if (!replaySamples.length) return;
  const speed = Number(document.getElementById('replay-speed')?.value) || 1;
  let index = 0;
  store.setReplayActive(true);
  const playNext = () => {
    if (!store.replayActive || index >= replaySamples.length) {
      stopReplay();
      return;
    }
    const current = replaySamples[index];
    const { timestamp, id, ...frame } = current;
    store.setData(frame);
    index += 1;
    if (index >= replaySamples.length) return playNext();
    const recordedDelay = Number(replaySamples[index].timestamp) - Number(timestamp);
    replayTimer = setTimeout(playNext, Math.min(Math.max(recordedDelay / speed, 10), 2000));
  };
  playNext();
  store.log('info', `Replay started at ${speed}× (remote alerts suppressed)`);
}

function stopReplay() {
  if (replayTimer) clearTimeout(replayTimer);
  replayTimer = null;
  if (store.replayActive) {
    store.setReplayActive(false);
    store.log('info', 'Replay stopped');
  }
  updateReplayControls();
}

function updateReplayControls() {
  const button = document.getElementById('btn-replay-play');
  const speed = document.getElementById('replay-speed');
  if (!button) return;
  button.disabled = !replaySamples.length;
  button.className = `btn-control ${store.replayActive ? 'btn-reboot' : 'btn-connect'}`;
  button.style.padding = '0.25rem 0.6rem';
  button.style.fontSize = '0.75rem';
  button.innerHTML = store.replayActive
    ? '<i class="bi bi-stop-fill me-1"></i>Stop'
    : '<i class="bi bi-play-fill me-1"></i>Play';
  if (speed) speed.disabled = store.replayActive;
}
