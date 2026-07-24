# Remote laptop mirror of the IDS GUI — Design Spec

**Date:** 2026-07-24
**Status:** Approved (brainstorming) → ready for implementation planning
**Author:** Matt McCoy + Claude

## 1. Goal

Let a **laptop** load the same website and fully control the RF-AM Ink Delivery
System while a **desktop** remains the machine that is physically connected to the
controller over Web Serial. The laptop must mimic **every** desktop feature (all
tabs, modes, setpoints, map, debug, commissioning), not a reduced dashboard. Pairing
is a simple flow: a **"Pair a laptop"** button on the connected desktop produces a
short numeric code; the laptop enters the code and enters mirror mode.

The desktop remains the **safety authority**: full parity is "guarded" — the existing
30-minute remote-enable window, must-be-connected requirement, and per-command
validation/confirmation all stay on the host.

## 2. What already exists (build on, do not rebuild)

- **Cloudflare Worker relay** (`worker/src/index.js`, D1-backed) with a role-based token
  model (env secrets):
  - `DEVICE_TOKEN` — host publishes telemetry (`POST /api/v1/telemetry`) and pulls
    commands (`GET /api/v1/commands`, `/claim`, `/ack`).
  - `OPERATOR_TOKEN` — enqueue commands (`POST /api/v1/commands`).
  - `VIEWER_TOKEN` — read state (`GET /api/v1/status`, `/events`).
  - Relay is **deployed and working** at `https://ids-alert-relay.mattlmccoy.workers.dev`
    (baked into the app as the default worker URL in `js/notifications.js` and
    `js/remote-dashboard.js`).
- **Host command consumer** `js/remote-control.js` — polls the relay every 1 s, claims a
  command, executes it on serial, confirms readback, acknowledges. Today it allow-lists
  **5 command types** (`run`, `stop`, `set_vacuum`, `set_flow`, `set_temperature`), with a
  30-min local enable window and a must-be-CONNECTED latch.
- **Telemetry publish** `js/notifications.js` posts frames to `/api/v1/telemetry`.
- **Viewer** `js/remote-dashboard.js` — an existing read-only-ish mobile dashboard.
- **Serial layer** `js/serial.js` — public surface: `connect()`, `disconnect()`,
  `send(json)`, `isSerialSupported()`, `getPollIntervalMs()`, `getNominalPollIntervalMs()`,
  `setPollIntervalMs()`. Imported by `remote-control`, `ui-settings`, `ui-operation`,
  `ui-validation`, `ui-debug`, `ui-charts`, `app`.

## 3. Architecture — the transport seam (Approach A)

Introduce `js/transport.js` as the single I/O entry point the app imports. It owns the
**active transport** and delegates to one of two implementations behind a shared
interface:

```
Transport {
  connect(): Promise<void>        // Serial: open port. Cloud: join/verify session.
  disconnect(reason): Promise<void>
  send(jsonStr): Promise<boolean> // Serial: serial write. Cloud: POST /commands.
  isSupported(): boolean
  getPollIntervalMs(): number
  getNominalPollIntervalMs(): number
  setPollIntervalMs(ms): void
}
```

- `SerialTransport` — thin wrapper over the existing `serial.js` (internals unchanged).
- `CloudTransport` — new (Section 4).

`transport.js` selects the active transport at boot (Section 6) and re-exports the
delegating `send`/`connect`/`disconnect`/poll helpers. The ~6 importers change
`from './serial.js'` → `from './transport.js'`. Feature code is untouched: everything
already flows through `store` (telemetry) and `send()` (commands), so all tabs work in
both modes with zero per-feature edits.

### Files
- New: `js/transport.js`, `js/cloud-transport.js`.
- Edited (import swap only): `ui-settings.js`, `ui-operation.js`, `ui-validation.js`,
  `ui-debug.js`, `ui-charts.js`, `remote-control.js`, `app.js`.
- `serial.js` stays; may gain a tiny `SerialTransport` object wrapper (or transport.js
  wraps it directly).

## 4. CloudTransport + full-parity host execution

### 4.1 Laptop side (`cloud-transport.js`)
- **Telemetry in:** poll `GET /api/v1/status?deviceId=<id>` (viewer token) on the poll
  interval; feed each returned frame into `store.setData(frame)` — identical to a serial
  frame, so live readouts / trends / map / debug all work. Missing/stale updates use the
  app's existing stale-data treatment.
- **Commands out:** `send(json)` POSTs `{ deviceId, command_type, command_value }` (or the
  raw payload form, see 4.2) to `/api/v1/commands` with the operator token. Returns
  `true` on 2xx enqueue. The host does the real execution + readback; the laptop reflects
  the resulting telemetry like any other frame.
- `connect()` verifies the session (a `/status` round-trip succeeds); `disconnect()` clears
  the session and returns the app to the serial-capable default.

### 4.2 Full command set + host validation
`remote-control.js`'s `COMMAND_MAP` expands from 5 entries to the **full validated set**:
- All operating modes on/off: `Run/Purge/Flush/Drain_MODE` (Bypass already removed).
- All setpoints with existing min/max ranges: `Vacuum_SETPOINT` (0–100), `Flow_SETPOINT`
  (0–100), `Temperature_SETPOINT` (0–70), plus any other setpoints the desktop sends
  (mirror the ranges already enforced in `ui-operation`/`ui-validation`).
- Maintenance/system: `WatchdogTrigger_MODE`, reboot command, `GET ALL`, all-modes-off.
- **Debug raw command:** relayed as a single-key JSON validated on the host against a
  **known-key allow-list** (the same keys the desktop can legitimately send); anything
  outside the allow-list is rejected + ack'd `rejected`.

Command transport shape: extend the queue item to optionally carry a validated
`payload` (raw JSON string) in addition to the existing `command_type`/`command_value`,
so structured commands and the raw-command tab share one path. The host still:
claim → validate (type/range/key allow-list) → `send()` on serial → `waitForReadback` →
`ack`. **All gating stays host-side** (30-min window, CONNECTED latch, validation).

## 5. Pairing

### 5.1 Worker
- `POST /api/v1/pair` (host, `DEVICE_TOKEN`): mint a **4-digit code** bound to `deviceId`,
  TTL **5 min**, single-use, and **only one active code per device** (minting a new one
  invalidates the previous). Store in new D1 table `pair_codes(code, device_id, expires_at,
  redeemed_at, attempts)`. Return `{ code, expiresAt }`.
- `POST /api/v1/pair/redeem` (no token, **rate-limited with lockout**): body `{ code }`.
  On valid+unexpired+unredeemed: mark redeemed, return
  `{ deviceId, viewerToken, operatorToken, workerUrl }`. On invalid: increment attempts;
  **lock out after 5 failed redeem attempts within 10 minutes** (tracked per source IP).
  A 4-digit code is only 10 000 combinations, so the brute-force defense is entirely the
  short 5-min TTL + single-use + one-active-code-per-device + the strict 5-attempt lockout
  (a guesser gets 5 tries before the code has almost certainly expired or been rotated).
- Migration file under `worker/migrations/` for `pair_codes`.

### 5.2 Desktop UI ("Pair a laptop")
- Button enabled only when the controller is CONNECTED (and remote alerts configured, since
  it needs `DEVICE_TOKEN`). Calls `/pair`, shows the 4-digit code large with a live countdown
  and a "regenerate" affordance. Lives in Settings (Remote) and/or the Operation header.

### 5.3 Laptop UI ("Connect to a machine remotely")
- Entry on the same site (e.g., a button near the serial Connect control, or a
  `#pair` route). Enter 4-digit code → `redeem` → persist session `{deviceId, viewerToken,
  operatorToken, workerUrl}` in localStorage → reload/boot into mirror mode.

## 6. App boot, mode switch, safety UX

- `app.js`: on load, if a valid mirror session exists → select `CloudTransport`; else
  `SerialTransport` (default; unchanged path, including the "Web Serial not supported"
  fallback which no longer blocks mirror mode — a non-serial browser can still mirror).
- **Mirror banner:** persistent "🔗 Mirroring `<deviceId>` — remote" indicator; the serial
  **Connect** button is replaced by **"Leave remote session."**
- Remote commands traverse the host's existing confirm/interlock path; the host surfaces
  what the remote is doing (log entries). If the host's 30-min window lapses or the host
  disconnects from serial, the laptop drops to **read-only** with a clear banner (commands
  are rejected by the host and the UI reflects it).

## 7. Error handling

- Relay unreachable / auth expired → mirror goes **read-only** with a banner, no crash;
  auto-retry `/status`.
- Command enqueue failure or host `rejected`/timeout → surface the host's ack message in the
  same command-status UI the desktop uses.
- Stale telemetry (no `/status` change within the app's existing stale-telemetry window) →
  reuse the same "stale/no frames" treatment the desktop already shows.
- Pair code expired / locked / already redeemed → clear message; desktop can regenerate.

## 8. Testing

Pure units (no DOM/network):
- `transport.js` selection + delegation (serial vs cloud; each method forwards).
- `cloud-transport` frame → `store.setData` mapping; `send()` → correct POST body shape.
- Expanded host command validation: type allow-list, setpoint range checks, raw-command
  single-key allow-list (accept known keys, reject unknown).
- Worker pair-code lifecycle: mint, redeem-once, expire, single-use, lockout after N bad
  attempts (extend `worker/test`).

Glue verified in-browser against the live worker: pair desktop→laptop, drive a mode/setpoint
from the laptop, confirm host executes and both reflect the readback; confirm read-only
fallback when the host disables/disconnects. `scripts/audit-ui.mjs` markers preserved.

## 9. Scope / non-goals (YAGNI)

**In:** one laptop mirroring one desktop; full feature parity; 4-digit pairing code;
host-side safety authority; reuse of existing operator/viewer tokens gated by the code.

**Out (for now):** multiple simultaneous operators; per-session minted JWT tokens;
sub-second real-time streaming; remote emergency stop (physical only); mirroring more than
one machine from one laptop at a time.

## 10. Open implementation notes

- Confirm the exact `/status` response shape returns a full telemetry frame (not just alert
  state) so `store.setData` gets everything the map/tiles need; if it currently returns a
  subset, widen it (host already publishes full frames to `/telemetry`).
- Code entropy: **decided — 4 digits** for an easy type-in, compensated by 5-min TTL +
  single-use + one-active-code-per-device + a strict 5-attempt/10-min lockout.
- CRLF files (`ui-charts.js`, `ui-monitor.js`, `ui-dialogs.js`) edited byte-preserving if
  touched.
