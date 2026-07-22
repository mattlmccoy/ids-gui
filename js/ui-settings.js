/* ===== ui-settings.js — Settings tab (all writable firmware parameters) ===== */

import store from './state.js';
import { send } from './serial.js';
import { flashSentButton } from './utils.js';
import { loadNominalConfig } from './nominal-config.js';
import { isWeirOverflowInverted, setWeirOverflowInverted } from './float-state.js';
import {
  areWeirOverflowNotificationsEnabled,
  setWeirOverflowNotificationsEnabled,
  getRemoteAlertConfig,
  setRemoteAlertConfig,
  sendRemoteTestAlert
} from './notifications.js';
import { enableRemoteControl, disableRemoteControl, getRemoteControlState } from './remote-control.js';

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
  initNominalSettings();
  store.on('data', autoPopulate);
  store.on('float-config', syncWeirOverflowToggle);
  store.on('notification-config', syncNotificationToggle);
  store.on('remote-control', syncRemoteControlStatus);
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
      <div class="col-xl-4 col-lg-6">
        <div class="dash-card settings-group mb-3">
          <div class="card-header">
            <i class="bi bi-arrow-down-up me-1"></i> Weir OVF Display
          </div>
          <div class="card-body">
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" role="switch"
                     id="toggle-weir-ovf-invert">
              <label class="form-check-label" for="toggle-weir-ovf-invert">
                Invert Weir OVF status
              </label>
            </div>
            <div class="small mt-2" style="color:var(--text-muted)">
              Enabled gives the requested convention: float down = OFF, float up = ON.
              This changes display and trends only; the firmware value remains unchanged.
            </div>
          </div>
        </div>
      </div>
      <div class="col-xl-4 col-lg-6">
        <div class="dash-card settings-group mb-3">
          <div class="card-header">
            <i class="bi bi-bell me-1"></i> Local Alerts
          </div>
          <div class="card-body">
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" role="switch"
                     id="toggle-weir-ovf-notifications">
              <label class="form-check-label" for="toggle-weir-ovf-notifications">
                Notify when Weir OVF turns ON
              </label>
            </div>
            <div class="small mt-2" style="color:var(--text-muted)">
              Shows a desktop notification while this app is open and connected.
              Email delivery requires an external notification relay.
            </div>
          </div>
        </div>
      </div>
      <div class="col-xl-8 col-lg-12">
        <div class="dash-card settings-group mb-3">
          <div class="card-header d-flex justify-content-between align-items-center">
            <span><i class="bi bi-cloud-arrow-up me-1"></i> Remote Alerts</span>
            <span class="badge text-bg-secondary" id="remote-alert-status">Not configured</span>
          </div>
          <div class="card-body">
            <div class="form-check form-switch mb-3">
              <input class="form-check-input" type="checkbox" role="switch" id="toggle-remote-alerts">
              <label class="form-check-label" for="toggle-remote-alerts">
                Send critical IDS alerts and recoveries
              </label>
            </div>
            <div class="small mb-3" style="color:var(--text-muted)">
              Includes Weir/Supply overflow, firmware alarms, unexpected disconnects, stale telemetry, and read-only mobile status.
              Repeated readings are suppressed; alerts are sent only after the configured debounce.
            </div>
            <div class="row g-2">
              <div class="col-lg-7">
                <label class="form-label small mb-1" for="remote-worker-url">Cloudflare Worker URL</label>
                <input class="form-control form-control-sm font-monospace" type="url"
                       id="remote-worker-url" placeholder="https://ids-alert-relay.…workers.dev">
              </div>
              <div class="col-lg-5">
                <label class="form-label small mb-1" for="remote-device-id">Device ID</label>
                <input class="form-control form-control-sm font-monospace" id="remote-device-id"
                       maxlength="80" placeholder="ids-lab-computer">
              </div>
              <div class="col-lg-7">
                <label class="form-label small mb-1" for="remote-device-token">Device token</label>
                <input class="form-control form-control-sm font-monospace" type="password"
                       id="remote-device-token" autocomplete="off" placeholder="Worker DEVICE_TOKEN">
              </div>
              <div class="col-lg-5">
                <label class="form-label small mb-1" for="remote-ntfy-topic">Private ntfy topic (free fallback)</label>
                <input class="form-control form-control-sm font-monospace" type="password"
                       id="remote-ntfy-topic" autocomplete="off" maxlength="64" placeholder="Private topic name">
              </div>
              <div class="col-6 col-lg-2">
                <label class="form-label small mb-1" for="remote-debounce">Debounce (s)</label>
                <input class="form-control form-control-sm" type="number" id="remote-debounce"
                       min="0" max="30" step="1">
              </div>
              <div class="col-6 col-lg-3">
                <label class="form-label small mb-1" for="remote-stale-after">Stale after (s)</label>
                <input class="form-control form-control-sm" type="number" id="remote-stale-after"
                       min="5" max="300" step="1">
              </div>
            </div>
            <div class="d-flex align-items-center gap-2 mt-3 flex-wrap">
              <button class="btn-control btn-connect" id="btn-save-remote-alerts">
                <i class="bi bi-check-lg me-1"></i>Save
              </button>
              <button class="btn-control btn-disconnect" id="btn-test-remote-alerts">
                <i class="bi bi-send me-1"></i>Send test alert
              </button>
              <span class="small" id="remote-alert-feedback" style="color:var(--text-muted)">
                Credentials and the private ntfy topic stay in this browser and are not included in GitHub Pages.
              </span>
            </div>
            <div class="alert alert-warning mt-3 mb-0">
              <div class="fw-semibold"><i class="bi bi-shield-lock me-1"></i>Remote control safety latch</div>
              <div class="small my-2">Remote commands are ignored unless an operator at this computer enables a temporary 30-minute window. Cloud Stop is not an emergency stop and must not replace local safety controls.</div>
              <div class="d-flex gap-2 align-items-center flex-wrap">
                <button class="btn btn-sm btn-warning" id="btn-enable-remote-control">Enable for 30 minutes</button>
                <button class="btn btn-sm btn-outline-secondary" id="btn-disable-remote-control">Disable now</button>
                <span class="badge text-bg-secondary" id="remote-control-status">Disabled</span>
              </div>
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
  syncWeirOverflowToggle();
  syncNotificationToggle();
  syncRemoteAlertForm();
  syncRemoteControlStatus(getRemoteControlState());
  document.getElementById('toggle-weir-ovf-invert')?.addEventListener('change', e => {
    setWeirOverflowInverted(e.target.checked);
  });
  document.getElementById('toggle-weir-ovf-notifications')?.addEventListener('change', async e => {
    e.target.disabled = true;
    const enabled = await setWeirOverflowNotificationsEnabled(e.target.checked);
    e.target.checked = enabled;
    e.target.disabled = false;
  });
  document.getElementById('btn-weir-normal')?.addEventListener('click', () => {
    send('{"WeirFloatInvert_SETUP":"1"}');
    store.log('command', 'WeirFloatInvert_SETUP = 1');
  });
  document.getElementById('btn-weir-invert')?.addEventListener('click', () => {
    send('{"WeirFloatInvert_SETUP":"0"}');
    store.log('command', 'WeirFloatInvert_SETUP = 0');
  });
  document.getElementById('btn-save-remote-alerts')?.addEventListener('click', () => {
    const config = saveRemoteAlertForm();
    setRemoteFeedback(config.enabled ? 'Remote alerts enabled.' : 'Remote alert settings saved (disabled).', 'success');
  });
  document.getElementById('btn-test-remote-alerts')?.addEventListener('click', async e => {
    const button = e.currentTarget;
    button.disabled = true;
    setRemoteFeedback('Sending test alert…');
    try {
      const result = await sendRemoteTestAlert(readRemoteAlertForm());
      const delivery = result.event?.notification_status || 'accepted';
      const channels = result.deliveries
        ? ` ntfy: ${result.deliveries.ntfy}; Slack: ${result.deliveries.slack}.`
        : '';
      setRemoteFeedback(`Test alert ${delivery}.${channels}`, delivery === 'failed' ? 'danger' : 'success');
    } catch (error) {
      setRemoteFeedback(`Test failed: ${error.message}`, 'danger');
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('btn-enable-remote-control')?.addEventListener('click', () => {
    try {
      const status = enableRemoteControl();
      syncRemoteControlStatus(status);
    } catch (error) {
      setRemoteFeedback(error.message, 'danger');
    }
  });
  document.getElementById('btn-disable-remote-control')?.addEventListener('click', () => {
    syncRemoteControlStatus(disableRemoteControl('Disabled by local operator'));
  });

  document.querySelectorAll('.btn-send-setting').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      const input = document.getElementById(`set-${key}`);
      const val = input.value.trim();
      if (val === '') return;
      if (!input.checkValidity()) {
        input.reportValidity();
        store.log('warning', `Rejected out-of-range value for ${key}: ${val}`);
        return;
      }
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

function syncWeirOverflowToggle() {
  const toggle = document.getElementById('toggle-weir-ovf-invert');
  if (toggle) toggle.checked = isWeirOverflowInverted();
}

function syncNotificationToggle() {
  const toggle = document.getElementById('toggle-weir-ovf-notifications');
  if (toggle) toggle.checked = areWeirOverflowNotificationsEnabled();
}

function syncRemoteAlertForm() {
  const config = getRemoteAlertConfig();
  const fields = {
    'toggle-remote-alerts': config.enabled,
    'remote-worker-url': config.workerUrl,
    'remote-device-token': config.deviceToken,
    'remote-ntfy-topic': config.ntfyTopic,
    'remote-device-id': config.deviceId,
    'remote-debounce': config.debounceSeconds,
    'remote-stale-after': config.staleAfterSeconds
  };
  for (const [id, value] of Object.entries(fields)) {
    const element = document.getElementById(id);
    if (!element) continue;
    if (element.type === 'checkbox') element.checked = !!value;
    else element.value = value;
  }
  updateRemoteStatus(config);
}

function readRemoteAlertForm() {
  return {
    enabled: document.getElementById('toggle-remote-alerts')?.checked,
    workerUrl: document.getElementById('remote-worker-url')?.value,
    deviceToken: document.getElementById('remote-device-token')?.value,
    ntfyTopic: document.getElementById('remote-ntfy-topic')?.value,
    deviceId: document.getElementById('remote-device-id')?.value,
    debounceSeconds: document.getElementById('remote-debounce')?.value,
    staleAfterSeconds: document.getElementById('remote-stale-after')?.value
  };
}

function saveRemoteAlertForm() {
  const config = setRemoteAlertConfig(readRemoteAlertForm());
  syncRemoteAlertForm();
  return config;
}

function updateRemoteStatus(config) {
  const status = document.getElementById('remote-alert-status');
  if (!status) return;
  const configured = !!(config.workerUrl && config.deviceToken && config.deviceId);
  status.textContent = config.enabled && configured ? 'Enabled' : configured ? 'Configured' : 'Not configured';
  status.className = `badge ${config.enabled && configured ? 'text-bg-success' : configured ? 'text-bg-warning' : 'text-bg-secondary'}`;
}

function setRemoteFeedback(message, kind = '') {
  const element = document.getElementById('remote-alert-feedback');
  if (!element) return;
  element.textContent = message;
  element.style.color = kind === 'success' ? 'var(--accent-green)' : kind === 'danger' ? 'var(--accent-red)' : 'var(--text-muted)';
}

function syncRemoteControlStatus(status = getRemoteControlState()) {
  const element = document.getElementById('remote-control-status');
  if (!element) return;
  element.textContent = status.active ? `Enabled until ${new Date(status.enabledUntil).toLocaleTimeString()}` : 'Disabled';
  element.className = `badge ${status.active ? 'text-bg-warning' : 'text-bg-secondary'}`;
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

async function initNominalSettings() {
  const nominal = await loadNominalConfig();
  if (!nominal?.settings) return;
  for (const group of SETTINGS_GROUPS) {
    for (const p of group.params) {
      const val = nominal.settings[p.key];
      if (val === undefined) continue;
      nominalSettings[p.key] = val;
      refreshSettingChips(p.key);
    }
  }
}
