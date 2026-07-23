import test from 'node:test';
import assert from 'node:assert/strict';
import { orderDevicesByFreshness } from '../js/remote-devices.js';

test('orders devices freshest-first without mutating the input', () => {
  const input = [
    { device_id: 'a', updated_at: '2026-07-23T11:52:07Z' },
    { device_id: 'b', updated_at: '2026-07-23T13:51:31Z' },
    { device_id: 'c', updated_at: '2026-07-23T09:00:00Z' }
  ];
  const out = orderDevicesByFreshness(input);
  assert.deepEqual(out.map(d => d.device_id), ['b', 'a', 'c']);
  assert.equal(input[0].device_id, 'a'); // original array not mutated
});

test('handles empty / invalid input and missing timestamps', () => {
  assert.deepEqual(orderDevicesByFreshness([]), []);
  assert.deepEqual(orderDevicesByFreshness(null), []);
  const out = orderDevicesByFreshness([{ device_id: 'x' }, { device_id: 'y', updated_at: '2026-07-23T13:00:00Z' }]);
  assert.equal(out[0].device_id, 'y'); // the one with a valid, recent timestamp comes first
});
