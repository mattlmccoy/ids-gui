import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const relayUrl = 'http://127.0.0.1:8787';
const ntfyMessages = [];
const runId = `integration-${Date.now()}`;
const repoRoot = new URL('../..', import.meta.url);

const migration = spawnSync('wrangler', [
  'd1', 'migrations', 'apply', 'DB', '--local', '--config', 'worker/wrangler.jsonc'
], { cwd: repoRoot, encoding: 'utf8' });
if (migration.status !== 0) {
  throw new Error(`Local D1 migration failed:\n${migration.stdout}\n${migration.stderr}`);
}

const ntfy = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    ntfyMessages.push({ url: request.url, headers: request.headers, body });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `mock-${ntfyMessages.length}` }));
  });
});

await new Promise((resolve, reject) => {
  ntfy.once('error', reject);
  ntfy.listen(8790, '127.0.0.1', resolve);
});

const worker = spawn('wrangler', ['dev', '--config', 'worker/wrangler.jsonc', '--port', '8787'], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe']
});
let workerOutput = '';
worker.stdout.on('data', chunk => { workerOutput += chunk; });
worker.stderr.on('data', chunk => { workerOutput += chunk; });

try {
  await waitForWorker();

  let response = await fetch(`${relayUrl}/health`);
  assert.equal(response.status, 200);

  response = await postEvent('weir_ovf_active', `${runId}-active-unauthorized`, 'wrong');
  assert.equal(response.status, 401);

  response = await postEvent('weir_ovf_active', `${runId}-active-1`);
  if (response.status !== 201) {
    throw new Error(`Expected active event HTTP 201, received ${response.status}: ${await response.text()}\n${workerOutput}`);
  }
  let result = await response.json();
  assert.equal(result.event.notification_status, 'sent');
  assert.equal(ntfyMessages.length, 1);
  assert.equal(ntfyMessages[0].headers.priority, '5');

  response = await postEvent('weir_ovf_active', `${runId}-active-2`);
  result = await response.json();
  assert.equal(result.duplicate, true);
  assert.equal(result.event.notification_status, 'suppressed');
  assert.equal(ntfyMessages.length, 1);

  response = await postEvent('weir_ovf_active', `${runId}-active-1`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).duplicate, true);

  response = await api('/api/v1/status', 'local-viewer-token');
  assert.equal(response.status, 200);
  result = await response.json();
  assert.equal(result.states.find(state => state.device_id === runId)?.active, 1);

  response = await postEvent('weir_ovf_recovered', `${runId}-recovered-1`);
  result = await response.json();
  assert.equal(result.event.notification_status, 'sent');
  assert.equal(ntfyMessages.length, 2);

  response = await postEvent('supply_ovf_active', `${runId}-supply-active-1`);
  result = await response.json();
  assert.equal(result.event.notification_status, 'sent');
  assert.equal(ntfyMessages.length, 3);

  response = await postEvent('supply_ovf_active', `${runId}-supply-active-2`);
  result = await response.json();
  assert.equal(result.event.notification_status, 'suppressed');
  assert.equal(ntfyMessages.length, 3);

  response = await postEvent('supply_ovf_recovered', `${runId}-supply-recovered-1`);
  assert.equal((await response.json()).event.notification_status, 'sent');
  assert.equal(ntfyMessages.length, 4);

  response = await postEvent('firmware_alarm_active', `${runId}-alarm-active-1`);
  result = await response.json();
  assert.equal(result.event.notification_status, 'sent');
  assert.equal(ntfyMessages.length, 5);
  assert.equal(ntfyMessages[4].headers.priority, '5');

  response = await postEvent('firmware_alarm_recovered', `${runId}-alarm-recovered-1`);
  assert.equal((await response.json()).event.notification_status, 'sent');
  assert.equal(ntfyMessages.length, 6);

  response = await api(`/api/v1/events/${result.event.id}/ack`, 'local-viewer-token', {
    method: 'POST', body: JSON.stringify({ by: 'Integration test' })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).event.acknowledged_by, 'Integration test');

  response = await fetch(`${relayUrl}/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(response.status, 403);

  console.log(`Worker integration passed: ${ntfyMessages.length} ntfy messages, duplicate suppression and acknowledgement verified.`);
} finally {
  worker.kill('SIGTERM');
  await new Promise(resolve => ntfy.close(resolve));
}

async function postEvent(type, idempotencyKey, token = 'local-device-token') {
  return api('/api/v1/events', token, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ type, deviceId: runId, systemId: 'IDS TEST' })
  });
}

function api(path, token, options = {}) {
  return fetch(`${relayUrl}${path}`, {
    method: options.method || 'GET',
    body: options.body,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

async function waitForWorker() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`Wrangler exited early:\n${workerOutput}`);
    try {
      const response = await fetch(`${relayUrl}/health`);
      if (response.ok) return;
    } catch (_) { /* keep waiting */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for Wrangler:\n${workerOutput}`);
}
