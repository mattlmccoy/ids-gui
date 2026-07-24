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
