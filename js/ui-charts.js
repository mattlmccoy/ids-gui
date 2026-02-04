/* ===== ui-charts.js — Trending tab (Chart.js temperature + pressure graphs) ===== */

import store from './state.js';

const MAX_POINTS = 3600;
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
  { key: 'Vacuum_STATE',    label: 'Vacuum',       color: '#4c8dff' },
  { key: 'Pressure_STATE',  label: 'Pressure',     color: '#f87171' },
  { key: 'Vacuum_SETPOINT', label: 'Vac Setpoint', color: '#34d399', borderDash: [5, 5] },
];

let dataBuffer = [];
let tempChart = null;
let pressureChart = null;
let paused = false;
let windowMs = TIME_WINDOWS[1].ms;

export function initChartsTab() {
  const panel = document.getElementById('panel-trending');
  panel.innerHTML = buildHTML();
  createCharts();
  bindEvents();
  store.on('data', onData);
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
      <span class="ms-auto" style="color:var(--text-muted);font-size:0.75rem" id="chart-point-count">0 points</span>
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
        borderWidth: 1.5, borderDash: t.borderDash || [], pointRadius: 0, tension: 0.3, data: []
      }))
    },
    options: { ...commonOpts, scales: { ...commonOpts.scales, y: { ...commonOpts.scales.y, title: { display: true, text: 'cmH\u2082O / psi', color: tickColor } } } }
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

  document.getElementById('btn-chart-clear').addEventListener('click', () => { dataBuffer = []; refreshCharts(); });
}

function onData(data) {
  if (paused) return;
  const point = { timestamp: Date.now() };
  let hasValue = false;
  for (const t of [...TEMP_TRACES, ...PRESSURE_TRACES]) {
    if (data[t.key] !== undefined) {
      point[t.key] = parseFloat(data[t.key]);
      if (!isNaN(point[t.key])) hasValue = true;
    }
  }
  if (!hasValue) return;
  dataBuffer.push(point);
  if (dataBuffer.length > MAX_POINTS) dataBuffer = dataBuffer.slice(-MAX_POINTS);
  refreshCharts();
}

function refreshCharts() {
  const cutoff = Date.now() - windowMs;
  const visible = dataBuffer.filter(p => p.timestamp >= cutoff);
  const countEl = document.getElementById('chart-point-count');
  if (countEl) countEl.textContent = `${dataBuffer.length} points`;

  TEMP_TRACES.forEach((t, i) => {
    tempChart.data.datasets[i].data = visible.filter(p => p[t.key] !== undefined).map(p => ({ x: p.timestamp, y: p[t.key] }));
  });
  tempChart.update('none');

  PRESSURE_TRACES.forEach((t, i) => {
    pressureChart.data.datasets[i].data = visible.filter(p => p[t.key] !== undefined).map(p => ({ x: p.timestamp, y: p[t.key] }));
  });
  pressureChart.update('none');
}

export function getChartData() { return dataBuffer; }
