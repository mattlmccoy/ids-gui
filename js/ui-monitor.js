/* ===== ui-monitor.js — Monitor tab (categorized accordion) ===== */

import store from './state.js';
import { send } from './serial.js';
import { humanizeKey, unitForKey, flashSentButton } from './utils.js';

/* ---------- Category Definitions ---------- */
const CATEGORIES = [
  {
    id: 'pumps', title: 'Pumps', icon: 'bi-water',
    keys: [
      'InputPump_STATE', 'RecirculationPump_STATE', 'DrainPump_STATE',
      'BulkSupplyPump_STATE', 'VacuumPump_STATE', 'FlushPump_STATE',
      'InputPumpSpeed_SETPOINT', 'FlushPumpSpeed_SETPOINT',
      'DrainPumpSpeed_SETPOINT', 'ServiceRecirculationPumpSpeed_SETPOINT'
    ]
  },
  {
    id: 'valves', title: 'Valves', icon: 'bi-diagram-3',
    keys: ['ManifoldValve1_STATE', 'DrainValve_STATE', 'BulkSupplyValve_STATE']
  },
  {
    id: 'temperatures', title: 'Temperatures', icon: 'bi-thermometer-half',
    keys: [
      'FluidTemperature_STATE', 'MainHeaterTemperature_STATE',
      'AUXHeaterTemperature_STATE', 'MainHeaterSSR_STATE', 'AUXHeaterSSR_STATE',
      'Temperature_SETPOINT', 'TemperatureMAX_SETPOINT', 'HeaterTemperature_SETPOINT'
    ]
  },
  {
    id: 'pressure', title: 'Pressure / Vacuum', icon: 'bi-speedometer',
    keys: ['Vacuum_STATE', 'Vacuum_SETPOINT', 'Pressure_STATE', 'PressureMAX_SETPOINT']
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
    keys: ['AlarmStatus', 'ErrorCode_STATE']
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
  bindEvents();
  store.on('data', updateMonitor);
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
    <div class="row g-3">
      <div class="col-lg-8">
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
      <div class="col-lg-4">
        <div class="dash-card accent-cyan mb-3">
          <div class="card-header"><i class="bi bi-terminal me-1"></i> Raw Command</div>
          <div class="card-body">
            <div class="d-flex gap-2">
              <input type="text" class="form-control form-control-sm font-monospace"
                     id="raw-cmd-input" placeholder='{"key":"value"}'>
              <button class="btn-control btn-connect" id="btn-raw-send" style="white-space:nowrap">Send</button>
            </div>
            <div class="small mt-1" style="color:var(--text-muted)">Send raw JSON to firmware</div>
            <div id="raw-cmd-history" class="mt-2" style="max-height:200px;overflow-y:auto;font-size:0.75rem"></div>
          </div>
        </div>
        <div class="dash-card">
          <div class="card-body text-center">
            <span style="color:var(--text-muted);font-size:0.78rem">Last Update:
              <span id="mon-last-update" class="font-monospace" style="color:var(--accent-blue)">--</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function bindEvents() {
  const cmdInput = document.getElementById('raw-cmd-input');
  const btnSend = document.getElementById('btn-raw-send');

  function sendRaw() {
    const val = cmdInput.value.trim();
    if (!val) return;
    send(val);
    store.log('command', `Raw: ${val}`);
    flashSentButton(btnSend, 'Send');
    const hist = document.getElementById('raw-cmd-history');
    const div = document.createElement('div');
    div.style.color = 'var(--text-muted)';
    div.textContent = `> ${val}`;
    hist.prepend(div);
    if (hist.children.length > 20) hist.lastElementChild.remove();
    cmdInput.value = '';
  }

  btnSend.addEventListener('click', sendRaw);
  cmdInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendRaw(); });
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
      rows.push(`<tr><td>${humanizeKey(key)}</td><td>${key}</td><td>${data[key]}${unitForKey(key)}</td></tr>`);
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
