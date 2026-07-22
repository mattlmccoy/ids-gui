/* ===== trend-history.js — Persistent browser trend samples ===== */

const DB_NAME = 'ids-gui-trends';
const STORE_NAME = 'samples';
const DB_VERSION = 1;
const RETENTION_MS = 60 * 60 * 1000;
const MAX_LOAD = 18_000;
let writeQueue = [];
let flushTimer = null;

export async function initTrendHistory() {
  if (!('indexedDB' in window)) return [];
  const db = await openDatabase();
  const cutoff = Date.now() - RETENTION_MS;
  await deleteRange(db, IDBKeyRange.upperBound(cutoff, true));
  const transaction = db.transaction(STORE_NAME, 'readonly');
  const request = transaction.objectStore(STORE_NAME).index('timestamp').getAll(IDBKeyRange.lowerBound(cutoff));
  const rows = await requestResult(request);
  db.close();
  return rows.slice(-MAX_LOAD).map(({ id, ...sample }) => sample);
}

export function persistTrendPoint(point) {
  if (!('indexedDB' in window)) return;
  writeQueue.push({ ...point });
  if (writeQueue.length >= 25) flushTrendHistory();
  else if (!flushTimer) flushTimer = setTimeout(flushTrendHistory, 2000);
}

export async function flushTrendHistory() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const batch = writeQueue.splice(0);
  if (!batch.length || !('indexedDB' in window)) return;
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    batch.forEach(sample => store.add(sample));
    await transactionDone(transaction);
    db.close();
  } catch (error) {
    console.warn('[trend-history] Persist failed:', error);
  }
}

export async function clearTrendHistory() {
  writeQueue = [];
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).clear();
  await transactionDone(transaction);
  db.close();
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      store.createIndex('timestamp', 'timestamp');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deleteRange(db, range) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const request = transaction.objectStore(STORE_NAME).index('timestamp').openKeyCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      transaction.objectStore(STORE_NAME).delete(cursor.primaryKey);
      cursor.continue();
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
