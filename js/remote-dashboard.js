const STORAGE_KEY = 'ids-remote-viewer-v1';
const DEFAULT_WORKER_URL = 'https://ids-alert-relay.mattlmccoy.workers.dev';
let refreshTimer = null;

const elements = {
  url: document.getElementById('remote-relay-url'),
  token: document.getElementById('remote-viewer-token'),
  name: document.getElementById('remote-viewer-name'),
  connect: document.getElementById('remote-connect'),
  forget: document.getElementById('remote-forget'),
  refresh: document.getElementById('remote-refresh'),
  cards: document.getElementById('remote-status-cards'),
  rows: document.getElementById('remote-event-rows'),
  updated: document.getElementById('remote-updated'),
  state: document.getElementById('remote-connection-state')
};

boot();

function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  const config = loadConfig();
  elements.url.value = config.workerUrl || DEFAULT_WORKER_URL;
  elements.token.value = config.viewerToken || '';
  elements.name.value = config.viewerName || '';
  elements.connect.addEventListener('click', saveAndConnect);
  elements.forget.addEventListener('click', forgetConfig);
  elements.refresh.addEventListener('click', refresh);
  elements.rows.addEventListener('click', onTableClick);
  if (config.workerUrl && config.viewerToken) startPolling();
}

function saveAndConnect() {
  const config = readForm();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  startPolling();
}

function forgetConfig() {
  localStorage.removeItem(STORAGE_KEY);
  elements.token.value = '';
  stopPolling();
  elements.cards.innerHTML = '';
  elements.rows.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">Credentials removed from this browser.</td></tr>';
  setConnection(false, 'Offline');
}

function startPolling() {
  stopPolling();
  refresh();
  refreshTimer = setInterval(refresh, 15000);
}

function stopPolling() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

async function refresh() {
  const config = loadConfig();
  if (!config.workerUrl || !config.viewerToken) return;
  elements.refresh.disabled = true;
  try {
    const response = await api('/api/v1/status', { method: 'GET' });
    renderStatus(response.states || []);
    renderEvents(response.events || []);
    elements.updated.textContent = `Updated ${new Date(response.generatedAt || Date.now()).toLocaleString()}`;
    setConnection(true, 'Connected');
  } catch (error) {
    setConnection(false, 'Error');
    elements.updated.textContent = `Update failed: ${error.message}`;
  } finally {
    elements.refresh.disabled = false;
  }
}

function renderStatus(states) {
  if (!states.length) {
    elements.cards.innerHTML = '<div class="col-12"><div class="alert alert-secondary mb-0">No device state has been reported yet.</div></div>';
    return;
  }
  elements.cards.innerHTML = states.map(state => {
    const active = Number(state.active) === 1;
    const accent = active ? 'accent-red' : 'accent-green';
    const badge = active ? 'text-bg-danger' : 'text-bg-success';
    return `<div class="col-md-6 col-xl-4">
      <div class="dash-card ${accent} h-100">
        <div class="card-header d-flex justify-content-between">
          <span>${escapeHtml(labelFor(state.alert_key))}</span>
          <span class="badge ${badge}">${active ? 'ACTIVE' : 'NORMAL'}</span>
        </div>
        <div class="card-body">
          <div class="fw-semibold">${escapeHtml(state.system_id || state.device_id)}</div>
          <div class="small text-muted mt-1">${escapeHtml(state.message)}</div>
          <div class="small text-muted mt-2">${formatTime(state.updated_at)}</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderEvents(events) {
  if (!events.length) {
    elements.rows.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">No events yet.</td></tr>';
    return;
  }
  elements.rows.innerHTML = events.map(event => {
    const phaseBadge = event.phase === 'active' ? 'text-bg-danger' : event.phase === 'recovered' ? 'text-bg-success' : 'text-bg-info';
    const acknowledgement = event.acknowledged_at
      ? `<span class="text-success"><i class="bi bi-check2-circle me-1"></i>${escapeHtml(event.acknowledged_by || 'Acknowledged')}</span>`
      : `<button class="btn btn-sm btn-outline-primary btn-ack" data-event-id="${escapeHtml(event.id)}">Acknowledge</button>`;
    return `<tr>
      <td class="small text-nowrap">${formatTime(event.created_at)}</td>
      <td>${escapeHtml(event.system_id || event.device_id)}</td>
      <td><span class="badge ${phaseBadge} me-1">${escapeHtml(event.phase)}</span>${escapeHtml(event.title)}<div class="small text-muted">${escapeHtml(event.message)}</div></td>
      <td><span class="badge text-bg-secondary">${escapeHtml(event.notification_status)}</span></td>
      <td class="small">${acknowledgement}</td>
    </tr>`;
  }).join('');
}

async function onTableClick(event) {
  const button = event.target.closest('.btn-ack');
  if (!button) return;
  button.disabled = true;
  try {
    const config = loadConfig();
    await api(`/api/v1/events/${encodeURIComponent(button.dataset.eventId)}/ack`, {
      method: 'POST',
      body: JSON.stringify({ by: config.viewerName || 'remote viewer' })
    });
    await refresh();
  } catch (error) {
    button.disabled = false;
    elements.updated.textContent = `Acknowledgement failed: ${error.message}`;
  }
}

async function api(path, options) {
  const config = loadConfig();
  const response = await fetch(`${config.workerUrl.replace(/\/$/, '')}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${config.viewerToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  let result = {};
  try { result = await response.json(); } catch (_) { /* use HTTP error */ }
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function loadConfig() {
  try { return { workerUrl: DEFAULT_WORKER_URL, viewerToken: '', viewerName: '', ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; }
  catch (_) { return { workerUrl: DEFAULT_WORKER_URL, viewerToken: '', viewerName: '' }; }
}

function readForm() {
  return {
    workerUrl: elements.url.value.trim().replace(/\/$/, ''),
    viewerToken: elements.token.value.trim(),
    viewerName: elements.name.value.trim().slice(0, 80)
  };
}

function setConnection(connected, text) {
  elements.state.textContent = text;
  elements.state.className = `badge ${connected ? 'text-bg-success' : text === 'Error' ? 'text-bg-danger' : 'text-bg-secondary'}`;
}

function labelFor(key) {
  return ({ weir_ovf: 'Weir OVF', controller_connection: 'Controller connection', data_stale: 'Telemetry freshness' })[key] || key;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}
