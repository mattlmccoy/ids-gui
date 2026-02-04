/* ===== csv-export.js — Data logger + CSV download for session data ===== */

import store from './state.js';
import { formatFileDate } from './utils.js';

const MAX_RECORDS = 3600; // ~1 hour at 1 sample/sec
let sessionData = [];      // Array of { timestamp, ...allKeys }
let allKeysSet = new Set();

export function initCSVExport() {
  store.on('data', recordData);
}

function recordData(data) {
  const record = { timestamp: new Date().toISOString() };
  for (const [key, value] of Object.entries(data)) {
    record[key] = value;
    allKeysSet.add(key);
  }
  sessionData.push(record);
  if (sessionData.length > MAX_RECORDS) {
    sessionData = sessionData.slice(-MAX_RECORDS);
  }
}

/**
 * Export all session data as CSV.
 * Columns: timestamp + all firmware keys ever seen.
 */
export function exportSessionCSV() {
  if (sessionData.length === 0) {
    store.log('warning', 'No session data to export');
    return;
  }

  const keys = ['timestamp', ...Array.from(allKeysSet).sort()];
  let csv = keys.join(',') + '\n';

  for (const record of sessionData) {
    const row = keys.map(k => {
      const val = record[k] ?? '';
      // Escape commas and quotes
      const str = String(val);
      return str.includes(',') || str.includes('"')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    });
    csv += row.join(',') + '\n';
  }

  downloadCSV(csv, `ids-session-${formatFileDate()}.csv`);
  store.log('info', `Exported ${sessionData.length} data records to CSV`);
}

/** Clear session data buffer */
export function clearSessionData() {
  sessionData = [];
  allKeysSet.clear();
}

/** Get current session data count */
export function getSessionDataCount() {
  return sessionData.length;
}

function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
