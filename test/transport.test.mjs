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
