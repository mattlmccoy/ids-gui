/* ===== app.js — Entry point: wires serial, state, and UI modules ===== */

import store from './state.js';
import { isSerialSupported } from './serial.js';
import { decodeAlarmStatus, isActiveError } from './errors.js';
import { initDialogs } from './ui-dialogs.js';
import { initOperationTab } from './ui-operation.js';
import { initMonitorTab } from './ui-monitor.js';
import { initSettingsTab } from './ui-settings.js';
import { initChartsTab } from './ui-charts.js';
import { initLogTab } from './ui-log.js';
import { initCSVExport, exportSessionCSV } from './csv-export.js';

/* ---------- Boot ---------- */

function boot() {
  initThemeToggle();
  initSerialPicker();

  // Check Web Serial support
  if (!isSerialSupported()) {
    document.querySelector('.container-fluid.mt-2').innerHTML = `
      <div class="alert alert-danger mt-4" role="alert">
        <h4 class="alert-heading"><i class="bi bi-exclamation-triangle-fill me-2"></i>Web Serial Not Supported</h4>
        <p class="mb-0">This browser does not support the Web Serial API. Please use
        <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> (version 89+).</p>
      </div>
    `;
    return;
  }

  // Initialize modules
  initDialogs();
  initOperationTab();
  initMonitorTab();
  initSettingsTab();
  initChartsTab();
  initLogTab();
  initCSVExport();

  // Wire up connection badge
  store.on('connection', updateConnectionBadge);

  // Wire up navbar badges (SystemID, SoftwareRev)
  store.on('data', updateNavbarBadges);

  // Wire up page title from SystemID
  store.on('data', updatePageTitle);

  // Wire up alarm banner dismiss button
  document.getElementById('alarm-banner-dismiss').addEventListener('click', () => {
    document.getElementById('alarm-banner').classList.add('d-none');
  });

  // Log error transitions to Event Log
  store.on('error', logErrorEvent);

  // Add CSV export button to trending tab toolbar
  addCSVExportButton();

  store.log('info', 'IDS GUI R18 initialized');
}

// Boot immediately if DOM is already ready (module loaded after DOMContentLoaded)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

function initThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  const icon = document.getElementById('theme-toggle-icon');
  if (!btn || !icon) return;

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-bs-theme', theme);
    icon.className = theme === 'dark' ? 'bi bi-moon-stars-fill' : 'bi bi-sun-fill';
  }

  const stored = localStorage.getItem('ids-theme');
  const initial = stored || document.documentElement.getAttribute('data-bs-theme') || 'dark';
  applyTheme(initial);

  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-bs-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('ids-theme', next);
    applyTheme(next);
  });
}

function initSerialPicker() {
  if (!window.serialPicker) return;
  const modalEl = document.getElementById('serial-modal');
  const listEl = document.getElementById('serial-port-list');
  const cancelBtn = document.getElementById('serial-modal-cancel');
  if (!modalEl || !listEl) return;
  const modal = new bootstrap.Modal(modalEl);

  function renderList(ports) {
    listEl.innerHTML = '';
    ports.forEach(p => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'list-group-item list-group-item-action';
      const vid = p.vendorId ? `VID:${p.vendorId}` : 'VID:—';
      const pid = p.productId ? `PID:${p.productId}` : 'PID:—';
      const name = p.displayName || p.path || 'Serial Device';
      btn.innerHTML = `<div class="d-flex justify-content-between align-items-center">
        <span>${name}</span>
        <span class="text-muted small">${vid} ${pid}</span>
      </div>`;
      btn.addEventListener('click', () => {
        window.serialPicker.selectPort(p.portId);
        modal.hide();
      });
      listEl.appendChild(btn);
    });
    modal.show();
  }

  window.serialPicker.onPortList(renderList);
  cancelBtn?.addEventListener('click', () => window.serialPicker.cancel());
}

/* ---------- Connection Badge ---------- */

function updateConnectionBadge(state) {
  const badge = document.getElementById('connection-badge');
  const text = document.getElementById('connection-status-text');

  const stateMap = {
    DISCONNECTED: { class: 'disconnected', text: 'Disconnected' },
    CONNECTING:   { class: 'connecting',   text: 'Connecting...' },
    CONNECTED:    { class: 'connected',    text: 'Connected' },
    ERROR:        { class: 'error',        text: 'Error' }
  };

  const cfg = stateMap[state] || stateMap.DISCONNECTED;
  badge.className = `connection-badge ${cfg.class}`;
  text.textContent = cfg.text;
}

/* ---------- Navbar Badges ---------- */

function updateNavbarBadges(data) {
  if (data.SystemID) {
    const el = document.getElementById('system-id-badge');
    el.textContent = data.SystemID;
    el.classList.remove('d-none');
  }
  if (data.SoftwareRev) {
    const el = document.getElementById('sw-rev-badge');
    el.textContent = `FW ${data.SoftwareRev}`;
    el.classList.remove('d-none');
  }
}

/* ---------- Page Title ---------- */

let titleSet = false;
let lastLoggedErrorCode = null;

function updatePageTitle(data) {
  if (!titleSet && data.SystemID) {
    document.title = `${data.SystemID} — APS IDS R18`;
    titleSet = true;
  }
}

function logErrorEvent(payload) {
  const { error } = decodeAlarmStatus(payload.raw);
  if (isActiveError(error.code)) {
    if (error.code === lastLoggedErrorCode) return;
    lastLoggedErrorCode = error.code;
    const sev = error.severity === 'warning' ? 'warning' : (error.severity === 'info' ? 'info' : 'error');
    const msg = `${error.code} — ${error.title}. ${error.detail}`;
    store.log(sev, msg);
  } else if (lastLoggedErrorCode) {
    store.log('info', `Error cleared (${lastLoggedErrorCode})`);
    lastLoggedErrorCode = null;
  }
}

/* ---------- CSV Export Button ---------- */

function addCSVExportButton() {
  // Observe when trending tab becomes visible and add export button
  const trendingToolbar = document.querySelector('#panel-trending .d-flex');
  if (trendingToolbar) {
    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn btn-sm btn-outline-secondary';
    exportBtn.innerHTML = '<i class="bi bi-download me-1"></i>Export Data CSV';
    exportBtn.addEventListener('click', exportSessionCSV);

    // Insert before the point count span
    const countSpan = document.getElementById('chart-point-count');
    if (countSpan) {
      trendingToolbar.insertBefore(exportBtn, countSpan);
    } else {
      trendingToolbar.appendChild(exportBtn);
    }
  }
}
