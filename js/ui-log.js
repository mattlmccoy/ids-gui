/* ===== ui-log.js — Event Log tab ===== */

import store from './state.js';
import { formatTimestamp } from './utils.js';

const MAX_LOG_ENTRIES = 2000;
let logEntries = [];
let activeFilter = 'all';

export function initLogTab() {
  const panel = document.getElementById('panel-log');
  panel.innerHTML = buildHTML();
  bindEvents();
  store.on('log', addEntry);
}

function buildHTML() {
  return `
    <div class="d-flex flex-wrap gap-2 mb-3 align-items-center">
      <span style="color:var(--text-secondary);font-weight:500;font-size:0.82rem">Filter:</span>
      <div class="d-flex gap-1" id="log-filter-btns">
        <button class="btn-control btn-connect btn-log-filter" data-filter="all" style="padding:0.25rem 0.6rem;font-size:0.75rem">All</button>
        <button class="btn-control btn-disconnect btn-log-filter" data-filter="error" style="padding:0.25rem 0.6rem;font-size:0.75rem">Errors</button>
        <button class="btn-control btn-disconnect btn-log-filter" data-filter="warning" style="padding:0.25rem 0.6rem;font-size:0.75rem">Warnings</button>
        <button class="btn-control btn-disconnect btn-log-filter" data-filter="info" style="padding:0.25rem 0.6rem;font-size:0.75rem">Info</button>
        <button class="btn-control btn-disconnect btn-log-filter" data-filter="command" style="padding:0.25rem 0.6rem;font-size:0.75rem">Commands</button>
      </div>
      <span style="width:1px;height:20px;background:var(--border-color)"></span>
      <button class="btn-control btn-disconnect" id="btn-log-export" style="padding:0.25rem 0.6rem;font-size:0.75rem">
        <i class="bi bi-download me-1"></i>Export CSV
      </button>
      <button class="btn-control btn-reboot" id="btn-log-clear" style="padding:0.25rem 0.6rem;font-size:0.75rem">
        <i class="bi bi-trash me-1"></i>Clear
      </button>
      <span class="ms-auto" style="color:var(--text-muted);font-size:0.75rem" id="log-count">0 entries</span>
    </div>
    <div class="dash-card">
      <div class="table-responsive" style="max-height:60vh;overflow-y:auto">
        <table class="table table-sm table-hover log-table mb-0">
          <thead class="sticky-top">
            <tr>
              <th style="width:120px">Time</th>
              <th style="width:80px">Severity</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody id="log-tbody"></tbody>
        </table>
      </div>
    </div>
  `;
}

function bindEvents() {
  document.querySelectorAll('.btn-log-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-log-filter').forEach(b => b.className = 'btn-control btn-disconnect btn-log-filter');
      btn.className = 'btn-control btn-connect btn-log-filter';
      activeFilter = btn.dataset.filter;
      renderLog();
    });
  });
  document.getElementById('btn-log-clear').addEventListener('click', () => { logEntries = []; renderLog(); });
  document.getElementById('btn-log-export').addEventListener('click', exportLogCSV);
}

function severityBadge(sev) {
  const map = {
    error:   '<span style="color:var(--accent-red);font-weight:600;font-size:0.72rem">ERROR</span>',
    warning: '<span style="color:var(--accent-amber);font-weight:600;font-size:0.72rem">WARN</span>',
    info:    '<span style="color:var(--accent-blue);font-weight:600;font-size:0.72rem">INFO</span>',
    command: '<span style="color:var(--accent-green);font-weight:600;font-size:0.72rem">CMD</span>'
  };
  return map[sev] || `<span style="color:var(--text-muted);font-weight:600;font-size:0.72rem">${sev.toUpperCase()}</span>`;
}

function addEntry(entry) {
  logEntries.push(entry);
  if (logEntries.length > MAX_LOG_ENTRIES) logEntries = logEntries.slice(-MAX_LOG_ENTRIES);
  appendRow(entry);
  document.getElementById('log-count').textContent = `${logEntries.length} entries`;
}

function appendRow(entry) {
  if (activeFilter !== 'all' && entry.severity !== activeFilter) return;
  const tbody = document.getElementById('log-tbody');
  const tr = document.createElement('tr');
  tr.className = `log-row-${entry.severity}`;
  tr.innerHTML = `
    <td>${formatTimestamp(entry.timestamp)}</td>
    <td>${severityBadge(entry.severity)}</td>
    <td style="color:var(--text-secondary)">${escapeHtml(entry.message)}</td>
  `;
  tbody.prepend(tr);
  while (tbody.children.length > 500) tbody.lastElementChild.remove();
}

function renderLog() {
  const tbody = document.getElementById('log-tbody');
  tbody.innerHTML = '';
  const filtered = activeFilter === 'all' ? logEntries : logEntries.filter(e => e.severity === activeFilter);
  const visible = filtered.slice(-500).reverse();
  for (const entry of visible) {
    const tr = document.createElement('tr');
    tr.className = `log-row-${entry.severity}`;
    tr.innerHTML = `
      <td>${formatTimestamp(entry.timestamp)}</td>
      <td>${severityBadge(entry.severity)}</td>
      <td style="color:var(--text-secondary)">${escapeHtml(entry.message)}</td>
    `;
    tbody.appendChild(tr);
  }
  document.getElementById('log-count').textContent = `${logEntries.length} entries`;
}

function exportLogCSV() {
  if (logEntries.length === 0) return;
  let csv = 'Timestamp,Severity,Message\n';
  for (const e of logEntries) {
    csv += `${e.timestamp.toISOString()},${e.severity},"${e.message.replace(/"/g, '""')}"\n`;
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const d = new Date();
  const p = v => String(v).padStart(2, '0');
  a.download = `ids-log-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function getLogEntries() { return logEntries; }
