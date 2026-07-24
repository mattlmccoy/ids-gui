# Remote Laptop Mirror — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a laptop load the same website, pair to a serial-connected desktop with a 4-digit code, and control the machine with full feature parity, while the desktop stays the safety authority.

**Architecture:** A transport seam (`js/transport.js`) lets the app run over either `SerialTransport` (Web Serial, today) or `CloudTransport` (telemetry from the relay's `/status`, commands to `/commands`). Every command the desktop sends is a single-key JSON payload, validated on both the Cloudflare Worker and the host against one shared allow-list. Pairing mints a short-lived 4-digit code that the laptop redeems for the target device's viewer + operator tokens.

**Tech Stack:** Vanilla ES modules (browser), Cloudflare Worker + D1 (SQLite), `node --test` for units, `wrangler` local D1 for the worker integration test.

**Spec:** `docs/superpowers/specs/2026-07-24-remote-mirror-design.md`

---

## File Structure

**New (app):**
- `js/command-allowlist.js` — canonical command allow-list + `validateCommandPayload(jsonStr)` (pure). Derived from `SETPOINTS` (ranges) + mode/setup keys (binary) + `GET:ALL` (read).
- `js/transport.js` — active-transport facade; re-exports `connect/disconnect/send/isSupported/getPollIntervalMs/getNominalPollIntervalMs/setPollIntervalMs`; picks serial vs cloud at boot.
- `js/cloud-transport.js` — `CloudTransport`: polls `/status` → `store.setData`, `send()` → POST `/commands`.
- `js/mirror-session.js` — localStorage mirror session (`ids-mirror-session-v1`) + `redeemPairCode(code)`.

**New (worker):**
- `worker/src/command-allowlist.js` — mirror of `js/command-allowlist.js` (worker runtime can't import app JS) + `validateCommandPayload`.
- `worker/migrations/0004_command_payload.sql` — `ALTER TABLE remote_commands ADD COLUMN command_payload TEXT`.
- `worker/migrations/0005_pair_codes.sql` — `pair_codes` + `pair_attempts` tables.

**Modified (app):**
- `js/serial.js` — export a `SerialTransport` object (wraps existing functions).
- `js/app.js` — boot selects transport; non-serial browsers may still boot in mirror mode.
- `js/remote-control.js` — expand from 5 command types to payload commands validated via the shared allow-list.
- `js/ui-settings.js` — "Pair a laptop" button (desktop) + a "Connect to a machine remotely" entry.
- Import swap `from './serial.js'` → `from './transport.js'` for `send`/poll helpers in: `ui-operation.js`, `ui-validation.js`, `ui-debug.js`, `ui-charts.js`, `ui-settings.js`.

**Modified (worker):**
- `worker/src/index.js` — accept `type:'payload'` in `createRemoteCommand`; add `POST /api/v1/pair` and `POST /api/v1/pair/redeem`; store/return `command_payload`.
- `worker/test/integration.mjs` — add pairing + payload-command coverage.

**New tests:**
- `test/command-allowlist.test.mjs`, `test/transport.test.mjs`, `test/cloud-transport.test.mjs`, `test/allowlist-parity.test.mjs` (asserts app and worker allow-lists match).

**CRLF note:** `ui-charts.js` is CRLF. Its only change is a one-line import swap — do it byte-preserving (small node replace), not with the Edit tool.

---

## Phase A — Worker backend + shared allow-list

### Task A1: Canonical command allow-list (app) + validator

**Files:**
- Create: `js/command-allowlist.js`
- Test: `test/command-allowlist.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/command-allowlist.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_ALLOWLIST, validateCommandPayload } from '../js/command-allowlist.js';

test('binary command keys accept only "0"/"1"', () => {
  assert.deepEqual(validateCommandPayload('{"Run_MODE":"1"}'), { ok: true, key: 'Run_MODE', value: '1' });
  assert.equal(validateCommandPayload('{"Run_MODE":"2"}').ok, false);
});

test('range command keys enforce SETPOINT min/max', () => {
  assert.equal(validateCommandPayload('{"Vacuum_SETPOINT":"50"}').ok, true);
  assert.equal(validateCommandPayload('{"Vacuum_SETPOINT":"101"}').ok, false);
  assert.equal(validateCommandPayload('{"Temperature_SETPOINT":"70"}').ok, true);
  assert.equal(validateCommandPayload('{"Temperature_SETPOINT":"71"}').ok, false);
});

test('GET ALL is allowed as a read, unknown keys and multi-key objects are rejected', () => {
  assert.equal(validateCommandPayload('{"GET":"ALL"}').ok, true);
  assert.equal(validateCommandPayload('{"Nonsense_MODE":"1"}').ok, false);
  assert.equal(validateCommandPayload('{"Run_MODE":"1","Purge_MODE":"1"}').ok, false);
  assert.equal(validateCommandPayload('not json').ok, false);
});

test('every SETPOINT is represented as a range entry', () => {
  for (const k of ['Vacuum_SETPOINT','Flow_SETPOINT','Temperature_SETPOINT','TemperatureMAX_SETPOINT',
    'InputPumpSpeed_SETPOINT','FlushPumpSpeed_SETPOINT','DrainPumpSpeed_SETPOINT',
    'ServiceRecirculationPumpSpeed_SETPOINT','HeaterTemperature_SETPOINT','PressureMAX_SETPOINT',
    'BulkSupplyTimeout_SETPOINT']) {
    assert.equal(COMMAND_ALLOWLIST[k]?.kind, 'range', `${k} missing`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/command-allowlist.test.mjs`
Expected: FAIL — cannot find module `../js/command-allowlist.js`.

- [ ] **Step 3: Write the implementation**

```js
// js/command-allowlist.js
/* Canonical allow-list of controller commands the GUI may send, plus a pure
   validator. Keep worker/src/command-allowlist.js identical (guarded by
   test/allowlist-parity.test.mjs). */

// Setpoint ranges — mirror of the SETPOINTS array in ui-operation.js.
const RANGES = {
  Vacuum_SETPOINT: [0, 100], Flow_SETPOINT: [0, 100], Temperature_SETPOINT: [0, 70],
  TemperatureMAX_SETPOINT: [20, 100], InputPumpSpeed_SETPOINT: [0, 100],
  FlushPumpSpeed_SETPOINT: [0, 100], DrainPumpSpeed_SETPOINT: [0, 100],
  ServiceRecirculationPumpSpeed_SETPOINT: [0, 100], HeaterTemperature_SETPOINT: [20, 100],
  PressureMAX_SETPOINT: [0, 100], BulkSupplyTimeout_SETPOINT: [0, 3600],
};
const BINARY = ['Run_MODE', 'Purge_MODE', 'Flush_MODE', 'Drain_MODE', 'WatchdogTrigger_MODE', 'WeirFloatInvert_SETUP'];

export const COMMAND_ALLOWLIST = (() => {
  const map = { GET: { kind: 'read', values: ['ALL'] } };
  for (const k of BINARY) map[k] = { kind: 'binary' };
  for (const [k, [min, max]] of Object.entries(RANGES)) map[k] = { kind: 'range', min, max };
  return map;
})();

export function validateCommandPayload(jsonStr) {
  let obj;
  try { obj = JSON.parse(jsonStr); } catch (_) { return { ok: false, error: 'not JSON' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'not an object' };
  const keys = Object.keys(obj);
  if (keys.length !== 1) return { ok: false, error: 'exactly one key required' };
  const key = keys[0];
  const value = String(obj[key]);
  const def = COMMAND_ALLOWLIST[key];
  if (!def) return { ok: false, error: `key not allowed: ${key}` };
  if (def.kind === 'read') return def.values.includes(value) ? { ok: true, key, value } : { ok: false, error: 'bad read value' };
  if (def.kind === 'binary') return (value === '0' || value === '1') ? { ok: true, key, value } : { ok: false, error: 'binary must be 0/1' };
  const n = Number(value);
  if (!Number.isFinite(n) || n < def.min || n > def.max) return { ok: false, error: `out of range ${def.min}-${def.max}` };
  return { ok: true, key, value: String(n) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/command-allowlist.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add js/command-allowlist.js test/command-allowlist.test.mjs
git commit -m "feat(commands): canonical command allow-list + payload validator"
```

### Task A2: Worker copy of the allow-list + parity guard

**Files:**
- Create: `worker/src/command-allowlist.js`
- Test: `test/allowlist-parity.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/allowlist-parity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_ALLOWLIST as app } from '../js/command-allowlist.js';
import { COMMAND_ALLOWLIST as worker } from '../worker/src/command-allowlist.js';

test('app and worker command allow-lists are identical', () => {
  assert.deepEqual(worker, app);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/allowlist-parity.test.mjs`
Expected: FAIL — cannot find `../worker/src/command-allowlist.js`.

- [ ] **Step 3: Write the implementation**

Copy `js/command-allowlist.js` verbatim to `worker/src/command-allowlist.js` (same exports; the file has no browser dependencies, so it runs unchanged under the Worker/node).

```bash
cp js/command-allowlist.js worker/src/command-allowlist.js
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/allowlist-parity.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/command-allowlist.js test/allowlist-parity.test.mjs
git commit -m "feat(worker): mirror command allow-list with parity guard"
```

### Task A3: Migrations — command payload column + pairing tables

**Files:**
- Create: `worker/migrations/0004_command_payload.sql`
- Create: `worker/migrations/0005_pair_codes.sql`

- [ ] **Step 1: Write `0004_command_payload.sql`**

```sql
-- 0004_command_payload.sql — carry the raw single-key command JSON alongside the numeric value.
ALTER TABLE remote_commands ADD COLUMN command_payload TEXT;
```

- [ ] **Step 2: Write `0005_pair_codes.sql`**

```sql
-- 0005_pair_codes.sql — short-lived pairing codes + brute-force lockout.
CREATE TABLE IF NOT EXISTS pair_codes (
  code TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pair_codes_device ON pair_codes(device_id);

CREATE TABLE IF NOT EXISTS pair_attempts (
  source_ip TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
```

- [ ] **Step 3: Apply locally to verify SQL is valid**

Run: `wrangler d1 migrations apply DB --local --config worker/wrangler.jsonc`
Expected: applies `0004` and `0005` with no error.

- [ ] **Step 4: Commit**

```bash
git add worker/migrations/0004_command_payload.sql worker/migrations/0005_pair_codes.sql
git commit -m "feat(worker): migrations for command payload + pairing tables"
```

### Task A4: Worker accepts payload commands

**Files:**
- Modify: `worker/src/index.js` — `createRemoteCommand` (around line 268), import the allow-list at top.

- [ ] **Step 1: Add the import at the top of `worker/src/index.js`**

```js
import { validateCommandPayload } from './command-allowlist.js';
```

- [ ] **Step 2: Replace the body of `createRemoteCommand` to branch on `type:'payload'`**

Replace the current numeric-only validation with support for a `payload` command that carries a single-key JSON string, keeping the legacy typed path intact:

```js
async function createRemoteCommand(request, env) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'Expected JSON body' }, 400, request, env); }
  const deviceId = clean(body.deviceId, 80);
  const commandType = clean(body.type, 40);
  const idempotencyKey = clean(request.headers.get('Idempotency-Key') || body.idempotencyKey, 120);
  if (!deviceId || !commandType || !idempotencyKey) {
    return json({ error: 'Valid deviceId, type, and Idempotency-Key are required' }, 400, request, env);
  }

  let value = null;
  let payload = null;
  if (commandType === 'payload') {
    payload = clean(body.payload, 200);
    const check = validateCommandPayload(payload || '');
    if (!check.ok) return json({ error: `Rejected command payload: ${check.error}` }, 400, request, env);
  } else {
    const definition = REMOTE_COMMANDS[commandType];
    if (!definition) return json({ error: 'Unsupported command type' }, 400, request, env);
    if (definition.min !== null) {
      value = Number(body.value);
      if (!Number.isFinite(value) || value < definition.min || value > definition.max) {
        return json({ error: `${commandType} value must be ${definition.min}-${definition.max}` }, 400, request, env);
      }
    }
  }

  const duplicate = await env.DB.prepare('SELECT * FROM remote_commands WHERE idempotency_key = ?')
    .bind(idempotencyKey).first();
  if (duplicate) return json({ command: duplicate, duplicate: true }, 200, request, env);
  const now = new Date();
  const expires = new Date(now.getTime() + 15_000);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO remote_commands
    (id, idempotency_key, device_id, command_type, command_value, command_payload, requested_by,
     created_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`)
    .bind(id, idempotencyKey, deviceId, commandType, value, payload,
      clean(body.requestedBy, 80, true), now.toISOString(), expires.toISOString()).run();
  const command = await env.DB.prepare('SELECT * FROM remote_commands WHERE id = ?').bind(id).first();
  return json({ command }, 201, request, env);
}
```

- [ ] **Step 3: Verify the app/worker still parse (lint via audit)**

Run: `node scripts/audit-ui.mjs`
Expected: `UI audit passed` (audit parses worker? if not, this step just confirms no app breakage — worker parse is checked by the integration test in Task A6).

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.js
git commit -m "feat(worker): accept validated single-key payload commands"
```

### Task A5: Worker pairing endpoints

**Files:**
- Modify: `worker/src/index.js` — add routes in `route()` (after the `/api/v1/status` route, ~line 134) and two handler functions; add a `clientIp(request)` helper.

- [ ] **Step 1: Add routes inside `route()`**

```js
  if (request.method === 'POST' && url.pathname === '/api/v1/pair') {
    if (!(await authorized(request, env.DEVICE_TOKEN))) return unauthorized(request, env);
    return createPairCode(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/pair/redeem') {
    return redeemPairCode(request, env);
  }
```

- [ ] **Step 2: Add the handlers (place near `createRemoteCommand`)**

```js
function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
}

async function createPairCode(request, env) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'Expected JSON body' }, 400, request, env); }
  const deviceId = clean(body.deviceId, 80);
  if (!deviceId) return json({ error: 'deviceId is required' }, 400, request, env);
  // One active code per device: clear any previous unredeemed codes.
  await env.DB.prepare('DELETE FROM pair_codes WHERE device_id = ?').bind(deviceId).run();
  const code = String(Math.floor(1000 + Math.random() * 9000)); // 4 digits, 1000-9999
  const now = new Date();
  const expires = new Date(now.getTime() + 5 * 60_000);
  await env.DB.prepare(`INSERT INTO pair_codes (code, device_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)`).bind(code, deviceId, now.toISOString(), expires.toISOString()).run();
  return json({ code, expiresAt: expires.toISOString() }, 201, request, env);
}

async function redeemPairCode(request, env) {
  const ip = clientIp(request);
  const now = new Date();
  const windowMs = 10 * 60_000;
  const attempt = await env.DB.prepare('SELECT * FROM pair_attempts WHERE source_ip = ?').bind(ip).first();
  if (attempt) {
    const fresh = now.getTime() - new Date(attempt.window_start).getTime() < windowMs;
    if (fresh && attempt.attempts >= 5) return json({ error: 'Too many attempts, try again later' }, 429, request, env);
    if (!fresh) await env.DB.prepare('UPDATE pair_attempts SET attempts = 0, window_start = ? WHERE source_ip = ?')
      .bind(now.toISOString(), ip).run();
  }
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'Expected JSON body' }, 400, request, env); }
  const code = clean(body.code, 8);
  const row = code ? await env.DB.prepare('SELECT * FROM pair_codes WHERE code = ?').bind(code).first() : null;
  const valid = row && !row.redeemed_at && new Date(row.expires_at).getTime() > now.getTime();
  if (!valid) {
    await env.DB.prepare(`INSERT INTO pair_attempts (source_ip, attempts, window_start)
      VALUES (?, 1, ?) ON CONFLICT(source_ip) DO UPDATE SET attempts = attempts + 1`)
      .bind(ip, now.toISOString()).run();
    return json({ error: 'Invalid or expired code' }, 404, request, env);
  }
  await env.DB.prepare('UPDATE pair_codes SET redeemed_at = ? WHERE code = ?').bind(now.toISOString(), code).run();
  await env.DB.prepare('DELETE FROM pair_attempts WHERE source_ip = ?').bind(ip).run();
  return json({
    deviceId: row.device_id,
    viewerToken: env.VIEWER_TOKEN,
    operatorToken: env.OPERATOR_TOKEN,
    workerUrl: new URL(request.url).origin
  }, 200, request, env);
}
```

- [ ] **Step 3: Commit**

```bash
git add worker/src/index.js
git commit -m "feat(worker): 4-digit pairing endpoints with lockout"
```

### Task A6: Worker integration coverage (pairing + payload command)

**Files:**
- Modify: `worker/test/integration.mjs` — add a pairing round-trip and a payload-command round-trip using the existing local-D1 harness.

- [ ] **Step 1: Add tests** following the file's existing pattern (spawn wrangler dev, POST with `Authorization: Bearer <token>`):

```js
// Pair round-trip: device mints a code, an unauthenticated client redeems it.
const pair = await api('POST', '/api/v1/pair', { deviceId: runId }, DEVICE_TOKEN);
assert.equal(pair.status, 201);
assert.match(pair.body.code, /^\d{4}$/);
const redeem = await api('POST', '/api/v1/pair/redeem', { code: pair.body.code });
assert.equal(redeem.status, 200);
assert.equal(redeem.body.deviceId, runId);
assert.ok(redeem.body.operatorToken && redeem.body.viewerToken);
// Single-use: second redeem fails.
assert.equal((await api('POST', '/api/v1/pair/redeem', { code: pair.body.code })).status, 404);

// Payload command round-trip: operator enqueues, device sees it queued.
const cmd = await api('POST', '/api/v1/commands',
  { deviceId: runId, type: 'payload', payload: '{"Purge_MODE":"1"}' }, OPERATOR_TOKEN,
  { 'Idempotency-Key': `pl-${runId}` });
assert.equal(cmd.status, 201);
assert.equal(cmd.body.command.command_payload, '{"Purge_MODE":"1"}');
const pending = await api('GET', `/api/v1/commands?deviceId=${runId}`, null, DEVICE_TOKEN);
assert.ok(pending.body.commands.some(c => c.id === cmd.body.command.id));

// Rejected payload: unknown key.
const bad = await api('POST', '/api/v1/commands',
  { deviceId: runId, type: 'payload', payload: '{"Nope_MODE":"1"}' }, OPERATOR_TOKEN,
  { 'Idempotency-Key': `bad-${runId}` });
assert.equal(bad.status, 400);
```

(If `integration.mjs` lacks a generic `api(method, path, body, token, headers)` helper, add one that wraps `fetch(relayUrl+path, ...)` with the bearer header and JSON body; follow the file's existing request style.)

- [ ] **Step 2: Run the worker integration test**

Run: `cd worker && npm test` (or the repo's worker-test command; check `worker/README.md`).
Expected: PASS including the new assertions.

- [ ] **Step 3: Commit**

```bash
git add worker/test/integration.mjs
git commit -m "test(worker): cover pairing round-trip and payload commands"
```

---

## Phase B — App transport abstraction

### Task B1: `SerialTransport` wrapper

**Files:**
- Modify: `js/serial.js` — append a `SerialTransport` object exporting the existing functions.

- [ ] **Step 1: Append to `js/serial.js`**

```js
export const SerialTransport = {
  id: 'serial',
  connect, disconnect, send,
  isSupported: isSerialSupported,
  getPollIntervalMs, getNominalPollIntervalMs, setPollIntervalMs,
};
```

- [ ] **Step 2: Verify parse**

Run: `node -e "import('./js/serial.js').then(m=>{if(!m.SerialTransport)throw new Error('missing');console.log('ok')})"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add js/serial.js
git commit -m "refactor(serial): expose SerialTransport object"
```

### Task B2: `CloudTransport` (telemetry in, commands out)

**Files:**
- Create: `js/cloud-transport.js`
- Test: `test/cloud-transport.test.mjs`

- [ ] **Step 1: Write the failing test** (pure parts: command body building + status→frame mapping; inject a fake `fetch` and a fake `store`)

```js
// test/cloud-transport.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommandBody, frameFromStatus } from '../js/cloud-transport.js';

test('buildCommandBody wraps a payload with device + idempotency key', () => {
  const b = buildCommandBody('dev-1', '{"Run_MODE":"1"}', 'idem-1');
  assert.deepEqual(b.body, { deviceId: 'dev-1', type: 'payload', payload: '{"Run_MODE":"1"}', requestedBy: 'mirror', idempotencyKey: 'idem-1' });
  assert.equal(b.headers['Idempotency-Key'], 'idem-1');
});

test('frameFromStatus extracts the matching device telemetry + connection', () => {
  const status = { devices: [
    { device_id: 'dev-1', connection: 'CONNECTED', telemetry: { FluidTemperature_STATE: '24.5' } },
    { device_id: 'other', connection: 'DISCONNECTED', telemetry: {} }
  ] };
  assert.deepEqual(frameFromStatus(status, 'dev-1'), { connection: 'CONNECTED', telemetry: { FluidTemperature_STATE: '24.5' } });
  assert.equal(frameFromStatus(status, 'missing'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cloud-transport.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// js/cloud-transport.js
/* CloudTransport — runs the app against the relay instead of Web Serial.
   Telemetry: poll GET /api/v1/status and feed the matching device's frame into
   store.setData. Commands: POST validated single-key payloads to /api/v1/commands. */

import store from './state.js';
import { validateCommandPayload } from './command-allowlist.js';

const NOMINAL_POLL_INTERVAL_MS = 1000;
let pollIntervalMs = NOMINAL_POLL_INTERVAL_MS;
let session = null;      // { workerUrl, deviceId, viewerToken, operatorToken }
let pollTimer = null;
let seq = 0;

export function buildCommandBody(deviceId, payload, idempotencyKey) {
  return {
    body: { deviceId, type: 'payload', payload, requestedBy: 'mirror', idempotencyKey },
    headers: { 'Idempotency-Key': idempotencyKey, 'Content-Type': 'application/json' },
  };
}

export function frameFromStatus(status, deviceId) {
  const dev = (status?.devices || []).find(d => d.device_id === deviceId);
  if (!dev) return null;
  return { connection: dev.connection || 'DISCONNECTED', telemetry: dev.telemetry || {} };
}

export function createCloudTransport(activeSession) {
  session = activeSession;
  return {
    id: 'cloud',
    isSupported: () => true,
    getPollIntervalMs: () => pollIntervalMs,
    getNominalPollIntervalMs: () => NOMINAL_POLL_INTERVAL_MS,
    setPollIntervalMs: ms => { pollIntervalMs = Math.min(5000, Math.max(500, Number(ms) || NOMINAL_POLL_INTERVAL_MS)); },
    async connect() {
      store.setConnection('CONNECTING');
      const ok = await pollOnce();
      store.setConnection(ok ? 'CONNECTED' : 'DISCONNECTED');
      if (!pollTimer) pollTimer = setInterval(pollOnce, pollIntervalMs);
    },
    async disconnect() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      store.setConnection('DISCONNECTED');
    },
    async send(jsonStr) {
      const trimmed = String(jsonStr).trim();
      if (trimmed.includes('"GET"')) { await pollOnce(); return true; } // read poll — no command queued
      const check = validateCommandPayload(trimmed);
      if (!check.ok) { store.log('error', `Remote command blocked locally: ${check.error}`); return false; }
      const { body, headers } = buildCommandBody(session.deviceId, trimmed, `mirror-${Date.now()}-${seq++}`);
      try {
        const res = await fetch(`${session.workerUrl}/api/v1/commands`, {
          method: 'POST',
          headers: { ...headers, Authorization: `Bearer ${session.operatorToken}` },
          body: JSON.stringify(body),
        });
        if (!res.ok) { store.log('error', `Relay rejected command (${res.status})`); return false; }
        store.emit('command-sent', trimmed);
        return true;
      } catch (err) { store.log('error', `Relay unreachable: ${err.message}`); return false; }
    },
  };
}

async function pollOnce() {
  if (!session) return false;
  try {
    const res = await fetch(`${session.workerUrl}/api/v1/status`, {
      headers: { Authorization: `Bearer ${session.viewerToken}` },
    });
    if (!res.ok) return false;
    const frame = frameFromStatus(await res.json(), session.deviceId);
    if (!frame) return false;
    store.setConnection(frame.connection === 'CONNECTED' ? 'CONNECTED' : 'DISCONNECTED');
    store.setData(frame.telemetry);
    return frame.connection === 'CONNECTED';
  } catch (_) { return false; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cloud-transport.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/cloud-transport.js test/cloud-transport.test.mjs
git commit -m "feat(transport): CloudTransport polling telemetry + posting commands"
```

### Task B3: Mirror session store + redeem

**Files:**
- Create: `js/mirror-session.js`

- [ ] **Step 1: Write the implementation** (thin; browser-only, verified in-browser)

```js
// js/mirror-session.js
const KEY = 'ids-mirror-session-v1';
const DEFAULT_WORKER_URL = 'https://ids-alert-relay.mattlmccoy.workers.dev';

export function getMirrorSession() {
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); return s && s.deviceId && s.operatorToken ? s : null; }
  catch (_) { return null; }
}
export function clearMirrorSession() { localStorage.removeItem(KEY); }

export async function redeemPairCode(code, workerUrl = DEFAULT_WORKER_URL) {
  const res = await fetch(`${workerUrl}/api/v1/pair/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Pairing failed (${res.status})`);
  const session = { workerUrl: data.workerUrl || workerUrl, deviceId: data.deviceId, viewerToken: data.viewerToken, operatorToken: data.operatorToken };
  localStorage.setItem(KEY, JSON.stringify(session));
  return session;
}
```

- [ ] **Step 2: Verify parse**

Run: `node -e "import('./js/mirror-session.js').then(()=>console.log('ok'))"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add js/mirror-session.js
git commit -m "feat(transport): mirror session store + pair-code redeem"
```

### Task B4: `transport.js` facade + selection

**Files:**
- Create: `js/transport.js`
- Test: `test/transport.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/transport.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { setActiveTransport, send, getPollIntervalMs } from '../js/transport.js';

test('facade delegates to the active transport', async () => {
  const calls = [];
  setActiveTransport({ id: 'fake', send: async s => { calls.push(s); return true; }, getPollIntervalMs: () => 1234 });
  assert.equal(await send('{"Run_MODE":"1"}'), true);
  assert.deepEqual(calls, ['{"Run_MODE":"1"}']);
  assert.equal(getPollIntervalMs(), 1234);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/transport.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// js/transport.js
/* Single I/O entry point. Holds the active transport (serial or cloud) and
   delegates. Feature modules import send/connect/... from here, not serial.js. */
import { SerialTransport } from './serial.js';

let active = SerialTransport;

export function setActiveTransport(t) { active = t; }
export function getActiveTransport() { return active; }

export function connect() { return active.connect(); }
export function disconnect(reason) { return active.disconnect(reason); }
export function send(json) { return active.send(json); }
export function isSerialSupported() { return SerialTransport.isSupported(); }
export function isMirror() { return active.id === 'cloud'; }
export function getPollIntervalMs() { return active.getPollIntervalMs(); }
export function getNominalPollIntervalMs() { return active.getNominalPollIntervalMs(); }
export function setPollIntervalMs(ms) { return active.setPollIntervalMs(ms); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/transport.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/transport.js test/transport.test.mjs
git commit -m "feat(transport): active-transport facade with delegation"
```

### Task B5: Point feature modules at the facade

**Files (import swap `from './serial.js'` → `from './transport.js'` for `send`, `getPollIntervalMs`, `getNominalPollIntervalMs`, `setPollIntervalMs`):**
- Modify: `js/ui-operation.js`, `js/ui-validation.js`, `js/ui-debug.js`, `js/ui-settings.js` (Edit tool — LF files)
- Modify: `js/ui-charts.js` (**CRLF — byte-preserving node replace**)
- Leave `connect`/`disconnect`/`isSerialSupported` imports in `app.js` for now (handled in B7).

- [ ] **Step 1: For each LF file**, change the serial import to pull those names from `./transport.js`. Example (`ui-debug.js`): it imports `send, getPollIntervalMs` from `./serial.js` → change to `./transport.js`. Keep any serial-only imports (there are none in these beyond the swapped names — verify with `grep -n "from './serial.js'"`).

- [ ] **Step 2: For `ui-charts.js` (CRLF)**, do the one-line swap with a node script that preserves `\r\n`:

```bash
node -e "const f='js/ui-charts.js';const fs=require('fs');let s=fs.readFileSync(f,'utf8');s=s.replace(\"from './serial.js'\",\"from './transport.js'\");fs.writeFileSync(f,s);console.log('CRLF kept:',fs.readFileSync(f,'utf8').includes('\r\n'))"
```

Expected: `CRLF kept: true`.

- [ ] **Step 3: Run the suite + audit**

Run: `npm test`
Expected: UI audit passes; all unit tests green (no behavior change — same functions, new import path).

- [ ] **Step 4: Commit**

```bash
git add js/ui-operation.js js/ui-validation.js js/ui-debug.js js/ui-settings.js js/ui-charts.js
git commit -m "refactor: import I/O from transport facade, not serial directly"
```

### Task B6: Host executes full payload command set

**Files:**
- Modify: `js/remote-control.js` — replace `COMMAND_MAP` handling in `processCommand` with payload validation via the shared allow-list; keep claim → send → readback → ack.

- [ ] **Step 1: Add import**

```js
import { validateCommandPayload } from './command-allowlist.js';
```

- [ ] **Step 2: Replace `processCommand` to handle `command_type === 'payload'`** (keep the legacy typed branch for backward compatibility with the existing 5 commands):

```js
async function processCommand(config, command) {
  if (!getRemoteControlState().active) return;

  let payload = null;
  let key = null;
  let value = null;
  if (command.command_type === 'payload') {
    const check = validateCommandPayload(command.command_payload || '');
    if (!check.ok) return rejectWithoutClaim(config, command.id, `Payload rejected: ${check.error}`);
    payload = command.command_payload;
    key = check.key; value = check.value;
  } else {
    const definition = COMMAND_MAP[command.command_type];
    if (!definition) return rejectWithoutClaim(config, command.id, 'Command type is not allowed by this desktop');
    value = definition.min === undefined ? definition.value : Number(command.command_value);
    if (definition.min !== undefined && (!Number.isFinite(value) || value < definition.min || value > definition.max)) {
      return rejectWithoutClaim(config, command.id, 'Command value is outside the desktop safety range');
    }
    payload = definition.payload(value); key = definition.key;
  }

  try {
    await deviceApi(config, `/api/v1/commands/${encodeURIComponent(command.id)}/claim`, { method: 'POST', body: '{}' });
  } catch (error) {
    if (!String(error.message).includes('409')) store.log('warning', `Could not claim remote command: ${error.message}`);
    return;
  }
  if (!getRemoteControlState().active || store.connection !== 'CONNECTED') {
    return acknowledge(config, command.id, 'rejected', 'Local remote-control window closed before execution');
  }
  const written = await send(payload);
  if (!written) return acknowledge(config, command.id, 'rejected', 'Serial write failed');
  // Reads (GET) and setups have no single readback key to confirm.
  if (key === 'GET') return acknowledge(config, command.id, 'executed', 'Read command sent');
  const confirmed = await waitForReadback(key, value, 4000);
  const message = confirmed ? `${key} readback confirmed at ${value}` : `${key} command written, readback not confirmed within 4 s`;
  store.log(confirmed ? 'command' : 'warning', `Remote: ${message}`);
  await acknowledge(config, command.id, 'executed', message);
}
```

Note: `send` here must be the **serial** send (the host writes to hardware), which `remote-control.js` already imports from `./serial.js`. Leave that import as `./serial.js` (host always uses serial), NOT the transport facade.

- [ ] **Step 3: Run the suite**

Run: `npm test`
Expected: green (no unit test targets `processCommand` directly; the audit + existing tests still pass). Behavior verified in-browser in Phase C.

- [ ] **Step 4: Commit**

```bash
git add js/remote-control.js
git commit -m "feat(remote): execute full validated payload command set on the host"
```

### Task B7: Boot selects transport (mirror vs serial)

**Files:**
- Modify: `js/app.js` — import mirror session + cloud transport + `setActiveTransport`; branch the boot.

- [ ] **Step 1: Add imports near the top of `app.js`**

```js
import { setActiveTransport } from './transport.js';
import { createCloudTransport } from './cloud-transport.js';
import { getMirrorSession } from './mirror-session.js';
```

- [ ] **Step 2: At the start of `boot()`, before the Web-Serial gate, branch on a mirror session**

```js
  const mirror = getMirrorSession();
  if (mirror) {
    setActiveTransport(createCloudTransport(mirror));
  } else if (!isSerialSupported()) {
    document.querySelector('.container-fluid.mt-2').innerHTML = `<div class="alert alert-danger mt-4" role="alert">
      <h4 class="alert-heading"><i class="bi bi-exclamation-triangle-fill me-2"></i>Web Serial Not Supported</h4>
      <p class="mb-0">Use <strong>Chrome</strong> or <strong>Edge</strong> 89+, or pair this laptop to a connected desktop.</p></div>`;
    return;
  }
```

Remove the old standalone `if (!isSerialSupported())` block (now folded into the branch above). Keep `initRemoteControl()` for the host path (harmless in mirror mode: it stays inactive without a device token). After the modules init, if `mirror`, call the cloud transport's `connect()` to start telemetry polling:

```js
  if (mirror) getActiveTransport().connect();
```

(import `getActiveTransport` too.)

- [ ] **Step 3: In-browser smoke — serial path unaffected**

Run: `npm test` then serve (`python3 -m http.server 8091`) and load Debug/Operation; confirm no console errors and the app boots normally (serial default).
Expected: identical to today when no mirror session is set.

- [ ] **Step 4: Commit**

```bash
git add js/app.js
git commit -m "feat(app): boot into mirror transport when a paired session exists"
```

---

## Phase C — Pairing UI

### Task C1: Desktop "Pair a laptop" button

**Files:**
- Modify: `js/ui-settings.js` — add a "Pair a laptop" control in the Remote section that calls `POST /api/v1/pair` with the device token and shows the 4-digit code + countdown.

- [ ] **Step 1: Add the button + a code display** in the Remote settings card (near the existing remote-worker-url field). Wire a click handler:

```js
document.getElementById('btn-pair-laptop')?.addEventListener('click', async () => {
  const cfg = getRemoteAlertConfig();
  const out = document.getElementById('pair-code-output');
  if (store.connection !== 'CONNECTED') { out.textContent = 'Connect the controller first.'; return; }
  try {
    const res = await fetch(`${cfg.workerUrl}/api/v1/pair`, {
      method: 'POST', headers: { Authorization: `Bearer ${cfg.deviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: cfg.deviceId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Pairing failed (${res.status})`);
    out.innerHTML = `<span class="display-6 font-monospace">${data.code}</span> <small class="text-muted">expires in 5 min</small>`;
  } catch (err) { out.textContent = `Could not create code: ${err.message}`; }
});
```

Requires the button to be enabled only when connected — reuse the existing connection-gated enable pattern in `ui-settings.js`.

- [ ] **Step 2: In-browser** — with the controller connected (or simulator running for a device token path), click "Pair a laptop"; a 4-digit code appears. (Test against the live worker.)

- [ ] **Step 3: Commit**

```bash
git add js/ui-settings.js
git commit -m "feat(ui): desktop Pair a laptop button issues a 4-digit code"
```

### Task C2: Laptop "Connect to a machine remotely" flow

**Files:**
- Modify: `js/ui-settings.js` (or a small dedicated entry) — a "Connect to a machine remotely" input that redeems a code and reloads into mirror mode.

- [ ] **Step 1: Add a code input + button** and wire it to `redeemPairCode`:

```js
import { redeemPairCode } from './mirror-session.js';
document.getElementById('btn-mirror-connect')?.addEventListener('click', async () => {
  const code = document.getElementById('mirror-pair-code')?.value.trim();
  const status = document.getElementById('mirror-connect-status');
  if (!/^\d{4}$/.test(code)) { status.textContent = 'Enter the 4-digit code shown on the desktop.'; return; }
  try {
    await redeemPairCode(code);
    status.textContent = 'Paired. Loading mirror…';
    location.reload();
  } catch (err) { status.textContent = err.message; }
});
```

- [ ] **Step 2: Add a "Leave remote session" affordance** shown when `isMirror()` — clears the session and reloads:

```js
import { isMirror } from './transport.js';
import { clearMirrorSession } from './mirror-session.js';
if (isMirror()) {
  // render a persistent banner + a Leave button
  document.getElementById('btn-mirror-leave')?.addEventListener('click', () => { clearMirrorSession(); location.reload(); });
}
```

- [ ] **Step 3: Mirror banner** — add a persistent "🔗 Mirroring `<deviceId>` — remote" indicator (reuse the simulation-badge styling) when `isMirror()`.

- [ ] **Step 4: End-to-end in-browser** (two browser profiles or two machines against the live worker):
  1. Desktop connected → "Pair a laptop" → code.
  2. Laptop → enter code → reloads into mirror mode, banner shows, telemetry streams.
  3. Enable remote control on the desktop (existing 30-min window), drive a Purge/setpoint from the laptop, confirm the desktop executes and both reflect the readback.
  4. Disable remote control on the desktop → laptop commands are rejected (read-only), telemetry still streams.

- [ ] **Step 5: Commit**

```bash
git add js/ui-settings.js
git commit -m "feat(ui): laptop pair-code connect + mirror banner + leave session"
```

### Task C3: Final verification + docs

- [ ] **Step 1:** Run full suite: `npm test` (app) and the worker test — all green.
- [ ] **Step 2:** Update `README.md` / `GITHUB_PAGES.md` with a short "Mirror a laptop" section (pair button → code → connect).
- [ ] **Step 3:** Confirm `scripts/audit-ui.mjs` markers still pass and CRLF files stayed CRLF (`git diff --stat` shows small diffs for `ui-charts.js`).
- [ ] **Step 4: Commit**

```bash
git add README.md GITHUB_PAGES.md
git commit -m "docs: how to mirror a laptop to a connected desktop"
```

---

## Self-review notes (addressed)

- **Spec coverage:** transport seam (B1–B5, B7), CloudTransport + full command execution (B2, B6, A4), pairing worker + UI (A5, C1–C2), migrations/tests (A3, A6), safety (host-side gating retained in B6; mirror read-only when host disables), error handling (CloudTransport catch → read-only), non-goals respected (single laptop, reused tokens).
- **`/status` returns full telemetry** — verified in code (`getStatus` returns `devices[].telemetry`), resolving spec §10.
- **Two allow-lists (app + worker)** are kept in sync by `test/allowlist-parity.test.mjs` (A2).
- **Host `send` stays serial** in `remote-control.js` (B6 note) — only feature UIs use the transport facade.
- **Idempotency-Key** is required by the worker; CloudTransport generates one per send (B2).
