/* ===== ui-monitor.js — Monitor tab (categorized accordion) ===== */

import store from './state.js';
import { humanizeKey, unitForKey } from './utils.js';
import { FLOATS, formatFloatState } from './float-state.js';

const FLOAT_KEYS = new Set(FLOATS.map(f => f.key));

/* ---------- Category Definitions ---------- */
const CATEGORIES = [
  {
    id: 'pumps', title: 'Pumps', icon: 'bi-water',
    keys: [
      'InputPump_STATE', 'RecirculationPump_STATE', 'DrainPump_STATE',
      'BulkSupplyPump_STATE', 'VacuumPump_STATE', 'flushPump_STATE',
      'ServiceRecirculationPump_STATE',
      'InputPumpSpeed_SETPOINT', 'FlushPumpSpeed_SETPOINT',
      'DrainPumpSpeed_SETPOINT', 'ServiceRecirculationPumpSpeed_SETPOINT'
    ]
  },
  {
    id: 'valves', title: 'Valves', icon: 'bi-diagram-3',
    keys: [
      'ManifoldValve1_STATE', 'ManifoldValve2_STATE', 'DrainValve_STATE',
      'BulkSupplyValve_STATE', 'flushValve_STATE',
      'ServiceInputValve_STATE', 'serviceRecirculationValve_STATE'
    ]
  },
  {
    id: 'temperatures', title: 'Temperatures', icon: 'bi-thermometer-half',
    keys: [
      'FluidTemperature_STATE', 'MainHeaterTemperature_STATE',
      'AUXHeaterTemperature_STATE', 'MainHeaterSSR_STATE', 'AUXHeaterSSR_STATE',
      'ServiceTemperature_STATE', 'ServiceHeaterTemperature_STATE', 'ServiceHeaterSSR_STATE',
      'Temperature_SETPOINT', 'TemperatureMAX_SETPOINT', 'HeaterTemperature_SETPOINT'
    ]
  },
  {
    id: 'pressure', title: 'Pressure / Vacuum', icon: 'bi-speedometer',
    keys: [
      'Vacuum_STATE', 'Vacuum_SETPOINT', 'Pressure_STATE', 'PressureMAX_SETPOINT',
      'ServiceVacuum_STATE'
    ]
  },
  {
    id: 'floats', title: 'Float Switches', icon: 'bi-life-preserver',
    keys: [
      'SupplyFloat_STATE', 'WeirFloat_STATE', 'WasteFloat_STATE',
      'SupplyOverflowFloat_STATE', 'WeirOverflowFloat_STATE',
      'FlushFloat_STATE', 'ServiceFloat_STATE'
    ]
  },
  {
    id: 'setpoints', title: 'Setpoints', icon: 'bi-sliders2',
    keys: [
      'Vacuum_SETPOINT', 'Flow_SETPOINT', 'Temperature_SETPOINT',
      'TemperatureMAX_SETPOINT', 'InputPumpSpeed_SETPOINT',
      'FlushPumpSpeed_SETPOINT', 'DrainPumpSpeed_SETPOINT',
      'ServiceRecirculationPumpSpeed_SETPOINT', 'HeaterTemperature_SETPOINT',
      'PressureMAX_SETPOINT', 'BulkSupplyTimeout_SETPOINT'
    ]
  },
  {
    id: 'modes', title: 'Modes', icon: 'bi-toggles',
    keys: ['Run_MODE', 'Purge_MODE', 'Flush_MODE', 'Drain_MODE', 'Service_MODE', 'AlarmStatus', 'ErrorCode_STATE']
  },
  {
    id: 'system', title: 'System', icon: 'bi-cpu',
    keys: ['SystemID', 'SoftwareRev', 'IP1_SETUP', 'IP2_SETUP', 'IP3_SETUP', 'IP4_SETUP']
  }
];

const categorizedKeys = new Set(CATEGORIES.flatMap(c => c.keys));

export function initMonitorTab() {
  const panel = document.getElementById('panel-monitor');
  panel.innerHTML = buildHTML();
  store.on('data', updateMonitor);
  store.on('float-config', () => updateMonitor(store.data));
}

function buildHTML() {
  const accordionItems = CATEGORIES.map((cat, idx) => `
    <div class="accordion-item">
      <h2 class="accordion-header">
        <button class="accordion-button ${idx > 0 ? 'collapsed' : ''}" type="button"
                data-bs-toggle="collapse" data-bs-target="#mon-${cat.id}">
          <i class="bi ${cat.icon} me-2"></i>${cat.title}
          <span class="badge bg-secondary ms-2" style="font-size:0.68rem" id="mon-count-${cat.id}">0</span>
        </button>
      </h2>
      <div id="mon-${cat.id}" class="accordion-collapse collapse ${idx === 0 ? 'show' : ''}">
        <div class="accordion-body">
          <table class="table table-sm monitor-table">
            <tbody id="mon-tbody-${cat.id}"></tbody>
          </table>
        </div>
      </div>
    </div>
  `).join('');

  return `
    <div class="d-flex align-items-center justify-content-between mb-2"><div class="small text-muted">Categorized controller readbacks</div><div class="small text-muted">Last update: <span id="mon-last-update" class="font-monospace text-primary">--</span></div></div>
    <div class="row g-3">
      <div class="col-12">
        <div class="accordion monitor-accordion" id="monitor-accordion">
          ${accordionItems}
          <div class="accordion-item">
            <h2 class="accordion-header">
              <button class="accordion-button collapsed" type="button"
                      data-bs-toggle="collapse" data-bs-target="#mon-other">
                <i class="bi bi-three-dots me-2"></i>Other
                <span class="badge bg-secondary ms-2" style="font-size:0.68rem" id="mon-count-other">0</span>
              </button>
            </h2>
            <div id="mon-other" class="accordion-collapse collapse">
              <div class="accordion-body">
                <table class="table table-sm monitor-table">
                  <tbody id="mon-tbody-other"></tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function updateMonitor(data) {
  const now = new Date();
  document.getElementById('mon-last-update').textContent =
    `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

  for (const cat of CATEGORIES) {
    const tbody = document.getElementById(`mon-tbody-${cat.id}`);
    if (!tbody) continue;
    let count = 0;
    const rows = [];
    for (const key of cat.keys) {
      if (data[key] === undefined) continue;
      count++;
      const display = FLOAT_KEYS.has(key)
        ? `${formatFloatState(key, data[key])} <span class="text-muted">(raw ${data[key]})</span>`
        : `${data[key]}${unitForKey(key)}`;
      rows.push(`<tr><td>${humanizeKey(key)}</td><td>${key}</td><td>${display}</td></tr>`);
    }
    tbody.innerHTML = rows.join('');
    const badge = document.getElementById(`mon-count-${cat.id}`);
    if (badge) badge.textContent = count;
  }

  const otherTbody = document.getElementById('mon-tbody-other');
  const otherRows = [];
  let otherCount = 0;
  for (const key of Object.keys(data)) {
    if (categorizedKeys.has(key)) continue;
    otherCount++;
    otherRows.push(`<tr><td>${humanizeKey(key)}</td><td>${key}</td><td>${data[key]}</td></tr>`);
  }
  otherTbody.innerHTML = otherRows.join('');
  const otherBadge = document.getElementById('mon-count-other');
  if (otherBadge) otherBadge.textContent = otherCount;
}
