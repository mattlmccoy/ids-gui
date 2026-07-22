/* ===== ui-charts.js — Trending tab (Chart.js temperature + pressure graphs) ===== */

import store from './state.js';
import { isDataKeyVisible } from './heater-visibility.js';
import { getPollIntervalMs, setPollIntervalMs, getNominalPollIntervalMs } from './serial.js';
import { FLOATS, getFloatDisplayState, formatFloatState } from './float-state.js';
import { initTrendHistory, persistTrendPoint, clearTrendHistory } from './trend-history.js';

const MAX_POINTS = 18_000; // one hour at the fastest supported 200 ms poll rate
const FLOAT_TRACKS_KEY = 'ids-show-float-tracks';
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
];

let dataBuffer = [];
let tempChart = null;
let pressureChart = null;
let floatChart = null;
let paused = false;
let windowMs = TIME_WINDOWS[1].ms;
let maxObservedPressure = 0;
let showFloatTracks = readFloatTracksPreference();
let replaySamples = [];
let replayTimer = null;

export function initChartsTab() {
  const panel = document.getElementById('panel-trending');
  panel.innerHTML = buildHTML();
  createCharts();
  bindEvents();
  store.on('data', onData);
  store.on('heater-visibility', refreshCharts);
  store.on('float-config', () => {
    updateFloatStatus(store.data);
    refreshCharts();
  });
  store.on('replay', updateReplayControls);
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
      if (showFloatTracks) floatChart?.resize();
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
      <span style="width:1px;height:20px;background:var(--border-color)"></span>
      <div class="form-check form-switch mb-0">
        <input class="form-check-input" type="checkbox" role="switch" id="toggle-float-tracks"
               ${showFloatTracks ? 'checked' : ''}>
        <label class="form-check-label small" for="toggle-float-tracks">Graph float states</label>
      </div>
      <span class="ms-auto" style="color:var(--text-muted);font-size:0.75rem" id="chart-point-count">0 points</span>
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
      <div class="col-lg-6">
        <div class="dash-card accent-blue">
          <div class="card-header"><i class="bi bi-thermometer-half me-1"></i> Temperature</div>
          <div class="card-body">
            <div class="chart-container"><canvas id="chart-temperature"></canvas></div>
          </div>
        </div>
      </div>
      <div class="col-lg-6">
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
      <div class="col-12 ${showFloatTracks ? '' : 'd-none'}" id="float-track-card">
        <div class="dash-card accent-cyan">
          <div class="card-header"><i class="bi bi-toggles me-1"></i> Float State History</div>
          <div class="card-body">
            <div class="chart-container chart-container-floats"><canvas id="chart-floats"></canvas></div>
            <div class="small mt-2" style="color:var(--text-muted)">
              Each lane steps between OFF / DOWN and ON / UP. Raw firmware samples remain unchanged in exported data.
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
      datasets: PRESSURE_TRACES.map(t => ({
        label: t.label, borderColor: t.color, backgroundColor: t.color + '15',
        borderWidth: 1.5, borderDash: t.borderDash || [], pointRadius: 0, tension: 0.3, data: [],
        yAxisID: t.yAxisID || 'y'
      }))
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
          beginAtZero: true,
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

  floatChart = new Chart(document.getElementById('chart-floats'), {
    type: 'line',
    data: {
      datasets: FLOATS.map(f => ({
        label: f.label,
        borderColor: f.color,
        backgroundColor: f.color,
        borderWidth: 2,
        pointRadius: 0,
        stepped: true,
        spanGaps: true,
        data: []
      }))
    },
    options: {
      ...commonOpts,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: commonOpts.scales.x,
        y: {
          min: -0.35,
          max: FLOATS.length * 2 - 0.65,
          grid: { color: gridColor },
          afterBuildTicks: axis => {
            axis.ticks = Array.from({ length: FLOATS.length * 2 }, (_, value) => ({ value }));
          },
          ticks: {
            color: tickColor,
            font: { size: 9 },
            callback: value => {
              const index = Math.floor(Number(value) / 2);
              const f = FLOATS[index];
              if (!f) return '';
              return `${f.label} ${Number(value) % 2 ? 'ON / UP' : 'OFF / DOWN'}`;
            }
          }
        }
      },
      plugins: {
        ...commonOpts.plugins,
        tooltip: {
          callbacks: {
            label: item => {
              const f = FLOATS[item.datasetIndex];
              return `${f.label}: ${Math.round(item.parsed.y) % 2 ? 'ON / UP' : 'OFF / DOWN'}`;
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
  document.getElementById('toggle-float-tracks')?.addEventListener('change', e => {
    showFloatTracks = e.target.checked;
    try { localStorage.setItem(FLOAT_TRACKS_KEY, String(showFloatTracks)); } catch (_) { /* ignore */ }
    document.getElementById('float-track-card')?.classList.toggle('d-none', !showFloatTracks);
    if (showFloatTracks) {
      refreshCharts();
      requestAnimationFrame(() => floatChart?.resize());
    }
  });
}

function onData(data) {
  updateFloatStatus(data);
  if (paused) return;
  const point = { timestamp: Date.now() };
  const p = parseFloat(data.Pressure_STATE);
  if (Number.isFinite(p)) maxObservedPressure = Math.max(maxObservedPressure, p);
  let hasValue = false;
  for (const t of [...TEMP_TRACES, ...PRESSURE_TRACES]) {
    if (!isDataKeyVisible(t.key)) continue;
    if (data[t.key] !== undefined) {
      point[t.key] = parseFloat(data[t.key]);
      if (!isNaN(point[t.key])) hasValue = true;
    }
  }
  for (const f of FLOATS) {
    if (data[f.key] === undefined) continue;
    point[f.key] = data[f.key];
    hasValue = true;
  }
  if (!hasValue) return;
  dataBuffer.push(point);
  if (dataBuffer.length > MAX_POINTS) dataBuffer = dataBuffer.slice(-MAX_POINTS);
  if (!store.replayActive) persistTrendPoint(point);
  refreshCharts();
}

function refreshCharts() {
  const cutoff = Date.now() - windowMs;
  const visible = dataBuffer.filter(p => p.timestamp >= cutoff);
  const countEl = document.getElementById('chart-point-count');
  if (countEl) countEl.textContent = `${dataBuffer.length} points`;

  TEMP_TRACES.forEach((t, i) => {
    tempChart.data.datasets[i].hidden = !isDataKeyVisible(t.key);
    tempChart.data.datasets[i].data = visible.filter(p => p[t.key] !== undefined).map(p => ({ x: p.timestamp, y: p[t.key] }));
  });
  tempChart.update('none');

  PRESSURE_TRACES.forEach((t, i) => {
    pressureChart.data.datasets[i].hidden = !isDataKeyVisible(t.key);
    pressureChart.data.datasets[i].data = visible.filter(p => p[t.key] !== undefined).map(p => ({ x: p.timestamp, y: p[t.key] }));
  });
  updatePressureAxisRange();
  syncPressureAxisVisibility(pressureChart);
  pressureChart.update('none');

  if (showFloatTracks && floatChart) {
    FLOATS.forEach((f, i) => {
      floatChart.data.datasets[i].data = visible
        .filter(p => p[f.key] !== undefined && getFloatDisplayState(f.key, p[f.key]) !== null)
        .map(p => ({ x: p.timestamp, y: i * 2 + getFloatDisplayState(f.key, p[f.key]) }));
    });
    floatChart.update('none');
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

function readFloatTracksPreference() {
  try { return localStorage.getItem(FLOAT_TRACKS_KEY) === 'true'; } catch (_) { return false; }
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
