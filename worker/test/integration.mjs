import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const relayUrl = 'http://127.0.0.1:8787';
const ntfyMessages = [];
const slackMessages = [];
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

const slack = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    slackMessages.push(JSON.parse(body));
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ok');
  });
});

await new Promise((resolve, reject) => {
  ntfy.once('error', reject);
  ntfy.listen(8790, '127.0.0.1', resolve);
});
await new Promise((resolve, reject) => {
  slack.once('error', reject);
  slack.listen(8791, '127.0.0.1', resolve);
});

const worker = spawn('wrangler', [
  'dev', '--config', 'worker/wrangler.jsonc', '--port', '8787',
  '--var', 'SLACK_WEBHOOK_URL:http://127.0.0.1:8791',
  '--var', 'OPERATOR_TOKEN:local-operator-token'
], {
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

  response = await postTelemetry();
  assert.equal(response.status, 200);

  response = await postCommand('set_vacuum', 42, 'wrong');
  assert.equal(response.status, 401);
  response = await postCommand('set_vacuum', 42);
  assert.equal(response.status, 201);
  let commandResult = await response.json();
  const commandId = commandResult.command.id;
  response = await api(`/api/v1/commands?deviceId=${encodeURIComponent(runId)}`, 'local-device-token');
  assert.equal((await response.json()).commands.length, 1);
  response = await api(`/api/v1/commands/${commandId}/claim`, 'local-device-token', { method: 'POST', body: '{}' });
  assert.equal((await response.json()).command.status, 'claimed');
  response = await api(`/api/v1/commands/${commandId}/ack`, 'local-device-token', {
    method: 'POST', body: JSON.stringify({ status: 'executed', message: 'readback confirmed' })
  });
  assert.equal((await response.json()).command.status, 'executed');

  response = await postEvent('weir_ovf_active', `${runId}-active-unauthorized`, 'wrong');
  assert.equal(response.status, 401);

  response = await postEvent('weir_ovf_active', `${runId}-active-1`);
  if (response.status !== 201) {
    throw new Error(`Expected active event HTTP 201, received ${response.status}: ${await response.text()}\n${workerOutput}`);
  }
  let result = await response.json();
  assert.equal(result.event.notification_status, 'sent');
  assert.equal(ntfyMessages.length, 1);
  assert.equal(slackMessages.length, 1);
  assert.match(slackMessages[0].text, /Weir OVF activated/);
  assert.equal(ntfyMessages[0].headers.priority, '5');

  response = await postEvent('weir_ovf_active', `${runId}-active-2`);
  result = await response.json();
  assert.equal(result.duplicate, true);
  assert.equal(result.event.notification_status, 'suppressed');
  assert.equal(ntfyMessages.length, 1);
  assert.equal(slackMessages.length, 1);

  response = await postEvent('weir_ovf_active', `${runId}-active-1`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).duplicate, true);

  response = await api('/api/v1/status', 'local-viewer-token');
  assert.equal(response.status, 200);
  result = await response.json();
  assert.equal(result.states.find(state => state.device_id === runId)?.active, 1);
  assert.equal(result.devices.find(device => device.device_id === runId)?.telemetry?.Vacuum_STATE, 18.4);

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

  response = await postEvent('firmware_alarm_active', `${runId}-alarm-active-1`, 'local-device-token', 'Firmware reported HEATER_ERROR');
  result = await response.json();
  assert.equal(result.event.notification_status, 'sent');
  assert.equal(ntfyMessages.length, 5);
  assert.equal(ntfyMessages[4].headers.priority, '5');

  response = await postEvent('firmware_alarm_active', `${runId}-alarm-active-2`, 'local-device-token', 'Firmware reported HTC_ERROR');
  result = await response.json();
  assert.equal(result.event.notification_status, 'sent');
  assert.equal(ntfyMessages.length, 6);

  response = await postEvent('firmware_alarm_recovered', `${runId}-alarm-recovered-1`);
  assert.equal((await response.json()).event.notification_status, 'sent');
  assert.equal(ntfyMessages.length, 7);

  response = await api(`/api/v1/events/${result.event.id}/ack`, 'local-viewer-token', {
    method: 'POST', body: JSON.stringify({ by: 'Integration test' })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).event.acknowledged_by, 'Integration test');

  response = await fetch(`${relayUrl}/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(response.status, 403);

  assert.equal(slackMessages.length, ntfyMessages.length);
  console.log(`Worker integration passed: ${ntfyMessages.length} ntfy + ${slackMessages.length} Slack messages, duplicate suppression and acknowledgement verified.`);
} finally {
  worker.kill('SIGTERM');
  await new Promise(resolve => ntfy.close(resolve));
  await new Promise(resolve => slack.close(resolve));
}

async function postEvent(type, idempotencyKey, token = 'local-device-token', message = undefined) {
  return api('/api/v1/events', token, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ type, deviceId: runId, systemId: 'IDS TEST', message })
  });
}

function postTelemetry(token = 'local-device-token') {
  return api('/api/v1/telemetry', token, {
    method: 'POST',
    body: JSON.stringify({
      deviceId: runId,
      systemId: 'IDS TEST',
      connection: 'CONNECTED',
      sourceTime: new Date().toISOString(),
      telemetry: { SystemID: 'IDS TEST', Vacuum_STATE: 18.4, Run_MODE: 1, ignored_private_field: 'drop me' }
    })
  });
}

function postCommand(type, value, token = 'local-operator-token') {
  return api('/api/v1/commands', token, {
    method: 'POST',
    headers: { 'Idempotency-Key': `${runId}-command-${type}-${token}` },
    body: JSON.stringify({ type, value, deviceId: runId, requestedBy: 'Integration test' })
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
