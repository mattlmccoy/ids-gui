import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_ALLOWLIST as app } from '../js/command-allowlist.js';
import { COMMAND_ALLOWLIST as worker } from '../worker/src/command-allowlist.js';

test('app and worker command allow-lists are identical', () => {
  assert.deepEqual(worker, app);
});
