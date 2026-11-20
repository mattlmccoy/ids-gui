import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPriorSession, trimIncidents } from '../js/incident-log.js';

test('unclean session detection requires an active stale heartbeat', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const stale = {
    id: 'prior-session', active: true, cleanExit: false,
    startedAt: '2026-11-19T02:00:00Z', heartbeatAt: '2026-11-19T02:05:00Z',
    lastTelemetryAt: '2026-11-19T02:04:58Z', connection: 'CONNECTED', visibility: 'visible'
  };
  assert.deepEqual(classifyPriorSession(stale, now, 45_000), {
    previousSessionId: 'prior-session',
    previousStartedAt: '2026-11-19T02:00:00Z',
    lastHeartbeatAt: '2026-11-19T02:05:00Z',
    lastTelemetryAt: '2026-11-19T02:04:58Z',
    lastConnection: 'CONNECTED',
    lastVisibility: 'visible',
    detectedAfterMs: now - Date.parse('2026-11-19T02:05:00Z')
  });
  assert.equal(classifyPriorSession({ ...stale, active: false }, now, 45_000), null);
  assert.equal(classifyPriorSession({ ...stale, cleanExit: true }, now, 45_000), null);
  assert.equal(classifyPriorSession({ ...stale, heartbeatAt: '2026-11-19T11:59:50Z' }, now, 45_000), null);
});

test('incident retention keeps only valid newest entries', () => {
  const entry = index => ({ at: new Date(index * 1000).toISOString(), type: `event-${index}` });
  assert.deepEqual(trimIncidents([entry(1), null, entry(2), entry(3)], 2).map(item => item.type), ['event-2', 'event-3']);
  assert.deepEqual(trimIncidents(null, 2), []);
});
