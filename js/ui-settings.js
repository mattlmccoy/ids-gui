/* ===== ui-settings.js — Settings tab (all writable firmware parameters) ===== */

import store from './state.js';
import { send } from './serial.js';
import { flashSentButton } from './utils.js';

/* ---------- Settings Groups ---------- */
const SETTINGS_GROUPS = [
  {
    id: 'network', title: 'Network Configuration', icon: 'bi-ethernet',
    params: [
      { key: 'IP1_SETUP', label: 'IP Octet 1', min: 0, max: 255, step: 1, unit: '' },
      { key: 'IP2_SETUP', label: 'IP Octet 2', min: 0, max: 255, step: 1, unit: '' },
      { key: 'IP3_SETUP', label: 'IP Octet 3', min: 0, max: 255, step: 1, unit: '' },
      { key: 'IP4_SETUP', label: 'IP Octet 4', min: 0, max: 255, step: 1, unit: '' },
    ]
  },
  {
    id: 'temperature', title: 'Temperature Settings', icon: 'bi-thermometer-half',
    params: [
      { key: 'Temperature_SETPOINT', label: 'Fluid Temp Setpoint', min: 0, max: 70, step: 1, unit: '\u00B0C' },
      { key: 'TemperatureMAX_SETPOINT', label: 'Max Heater Temp', min: 20, max: 100, step: 1, unit: '\u00B0C' },
      { key: 'HeaterTemperature_SETPOINT', label: 'Heater Temp Setpoint', min: 20, max: 100, step: 1, unit: '\u00B0C' },
    ]
  },
  {
    id: 'pressure', title: 'Pressure / Vacuum', icon: 'bi-speedometer',
    params: [
      { key: 'Vacuum_SETPOINT', label: 'Vacuum Setpoint', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'Flow_SETPOINT', label: 'Flow Setpoint', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'PressureMAX_SETPOINT', label: 'Max Pressure', min: 0, max: 100, step: 1, unit: 'psi' },
    ]
  },
  {
    id: 'pumps', title: 'Pump Speeds', icon: 'bi-water',
    params: [
      { key: 'InputPumpSpeed_SETPOINT', label: 'Input Pump', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'FlushPumpSpeed_SETPOINT', label: 'Flush Pump', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'DrainPumpSpeed_SETPOINT', label: 'Drain Pump', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'ServiceRecirculationPumpSpeed_SETPOINT', label: 'Svc Recirc Pump', min: 0, max: 100, step: 1, unit: '%' },
    ]
  },
  {
    id: 'safety', title: 'Safety / Timeouts', icon: 'bi-shield-check',
    params: [
      { key: 'BulkSupplyTimeout_SETPOINT', label: 'Bulk Supply Timeout', min: 0, max: 3600, step: 1, unit: 's' },
    ]
  }
];

let populated = false;
const nominalSettings = {};
const settingsHistory = {};

export function initSettingsTab() {
  const panel = document.getElementById('panel-settings');
  panel.innerHTML = buildHTML();
  bindEvents();
  store.on('data', autoPopulate);
}

function buildHTML() {
  return `
    <div class="row g-2">
      ${SETTINGS_GROUPS.map(group => `
        <div class="col-xl-4 col-lg-6">
          <div class="dash-card settings-group mb-3">
            <div class="card-header">
              <i class="bi ${group.icon} me-1"></i> ${group.title}
            </div>
            <div class="card-body">
              <div class="sp-grid" style="grid-template-columns:1fr">
                ${group.params.map(p => `
                  <div class="sp-item">
                    <label>${p.label}</label>
                    <input type="number" id="set-${p.key}"
                           min="${p.min}" max="${p.max}" step="${p.step}"
                           placeholder="${p.min}-${p.max}">
                    <button class="btn-sp-send btn-send-setting" data-key="${p.key}">Send</button>
                    <span class="sp-readback" id="setval-${p.key}">--</span>
                    <span class="sp-unit">${p.unit}</span>
                    <div class="sp-meta">
                      <span>Nominal:</span>
                      <button class="value-chip muted" data-kind="nominal" data-key="${p.key}">--</button>
                      <span>Recent:</span>
                      <button class="value-chip muted" data-kind="recent" data-idx="0" data-key="${p.key}">--</button>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="row g-2">
      <div class="col-xl-4 col-lg-6">
        <div class="dash-card settings-group mb-3">
          <div class="card-header">
            <i class="bi bi-sliders me-1"></i> Weir Float Logic
          </div>
          <div class="card-body">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <button class="btn-control btn-connect" id="btn-weir-normal">Set Normal (1)</button>
              <button class="btn-control btn-disconnect" id="btn-weir-invert">Set Invert (0)</button>
              <span class="small" style="color:var(--text-muted)">
                Current:
                <span class="font-monospace" id="setval-WeirFloatInvert_SETUP">--</span>
              </span>
            </div>
            <div class="small mt-2" style="color:var(--text-muted)">
              Sends <span class="font-monospace">WeirFloatInvert_SETUP</span> to firmware.
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="small mt-1" style="color:var(--text-muted)">
      <i class="bi bi-info-circle me-1"></i>
      Values are sent to the firmware immediately. Current firmware values shown on the right.
    </div>
  `;
}

function bindEvents() {
  document.getElementById('btn-weir-normal')?.addEventListener('click', () => {
    send('{"WeirFloatInvert_SETUP":"1"}');
    store.log('command', 'WeirFloatInvert_SETUP = 1');
  });
  document.getElementById('btn-weir-invert')?.addEventListener('click', () => {
    send('{"WeirFloatInvert_SETUP":"0"}');
    store.log('command', 'WeirFloatInvert_SETUP = 0');
  });

  document.querySelectorAll('.btn-send-setting').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      const input = document.getElementById(`set-${key}`);
      const val = input.value.trim();
      if (val === '') return;
      pushHistory(settingsHistory, key, val);
      refreshSettingChips(key);
      send(`{"${key}":"${val}"}`);
      flashSentButton(btn, 'Send');
      store.log('command', `Setting ${key} = ${val}`);
    });
  });

  document.querySelectorAll('.value-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const key = chip.dataset.key;
      const kind = chip.dataset.kind;
      const idx = chip.dataset.idx ? parseInt(chip.dataset.idx, 10) : null;
      let val = null;
      if (kind === 'nominal') val = nominalSettings[key];
      if (kind === 'recent' && idx !== null) val = (settingsHistory[key] || [])[idx];
      if (val === undefined || val === null || val === '--') return;
      const input = document.getElementById(`set-${key}`);
      if (input) input.value = val;
    });
  });

}

function autoPopulate(data) {
  const weirRead = document.getElementById('setval-WeirFloatInvert_SETUP');
  if (weirRead && data.WeirFloatInvert_SETUP !== undefined) {
    weirRead.textContent = data.WeirFloatInvert_SETUP;
  }

  for (const group of SETTINGS_GROUPS) {
    for (const p of group.params) {
      const readEl = document.getElementById(`setval-${p.key}`);
      if (readEl && data[p.key] !== undefined) {
        readEl.textContent = data[p.key];
        if (nominalSettings[p.key] === undefined) {
          nominalSettings[p.key] = data[p.key];
          refreshSettingChips(p.key);
        }
      }
    }
  }

  if (populated) return;
  let any = false;
  for (const group of SETTINGS_GROUPS) {
    for (const p of group.params) {
      if (data[p.key] !== undefined) {
        const input = document.getElementById(`set-${p.key}`);
        if (input && !input.value) { input.value = data[p.key]; any = true; }
      }
    }
  }
  if (any) populated = true;
}

function pushHistory(map, key, val) {
  if (!map[key]) map[key] = [];
  const list = map[key];
  list.unshift(val);
  if (list.length > 1) list.length = 1;
}

function refreshSettingChips(key) {
  const nom = nominalSettings[key];
  const recent = settingsHistory[key] || [];
  document.querySelectorAll(`.value-chip[data-key="${key}"][data-kind="nominal"]`).forEach(el => {
    el.textContent = nom !== undefined ? nom : '--';
    el.classList.toggle('muted', nom === undefined);
  });
  document.querySelectorAll(`.value-chip[data-key="${key}"][data-kind="recent"][data-idx="0"]`).forEach(el => {
    const v = recent[0];
    el.textContent = v !== undefined ? v : '--';
    el.classList.toggle('muted', v === undefined);
  });
}
