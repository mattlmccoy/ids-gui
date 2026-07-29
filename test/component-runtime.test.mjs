import test from 'node:test';
import assert from 'node:assert/strict';
import { ComponentRuntimeTracker, formatObservedRuntime } from '../js/component-runtime.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

test('pump usage counts only observed ON intervals and OFF-to-ON starts', () => {
  let now = 1_000;
  const tracker = new ComponentRuntimeTracker({ storage: memoryStorage(), now: () => now });
  tracker.observe({ SystemID: 'NANO-1', VacuumPump_STATE: '0' });
  now += 1_000;
  tracker.observe({ SystemID: 'NANO-1', VacuumPump_STATE: '1' });
  now += 1_000;
  tracker.observe({ SystemID: 'NANO-1', VacuumPump_STATE: '1' });
  now += 1_000;
  tracker.observe({ SystemID: 'NANO-1', VacuumPump_STATE: '0' });

  const vacuum = tracker.snapshot('NANO-1').components.find(item => item.key === 'VacuumPump_STATE');
  assert.equal(vacuum.runtimeMs, 2_000);
  assert.equal(vacuum.starts, 1);
});

test('pump usage never bridges telemetry gaps, pauses, simulations, or unidentified systems', () => {
  let now = 1_000;
  const tracker = new ComponentRuntimeTracker({ storage: memoryStorage(), now: () => now, maxGapMs: 5_000 });
  assert.equal(tracker.observe({ VacuumPump_STATE: '1' }), null);
  tracker.observe({ SystemID: 'NANO-1', VacuumPump_STATE: '1' });
  now += 10_000;
  tracker.observe({ SystemID: 'NANO-1', VacuumPump_STATE: '1' });
  tracker.pause();
  now += 1_000;
  tracker.observe({ SystemID: 'NANO-1', VacuumPump_STATE: '1' });

  const vacuum = tracker.snapshot('NANO-1').components.find(item => item.key === 'VacuumPump_STATE');
  assert.equal(vacuum.runtimeMs, 0);
  assert.equal(vacuum.starts, 0);
});

test('pump usage persists independently for each SystemID', () => {
  const storage = memoryStorage();
  let now = 1_000;
  let tracker = new ComponentRuntimeTracker({ storage, now: () => now });
  tracker.observe({ SystemID: 'A', InputPump_STATE: '0' });
  now += 1_000;
  tracker.observe({ SystemID: 'A', InputPump_STATE: '1' });
  now += 1_000;
  tracker.observe({ SystemID: 'A', InputPump_STATE: '1' });
  tracker.observe({ SystemID: 'B', InputPump_STATE: '0' });
  tracker = new ComponentRuntimeTracker({ storage, now: () => now });

  assert.equal(tracker.snapshot('A').components.find(item => item.key === 'InputPump_STATE').runtimeMs, 1_000);
  assert.equal(tracker.snapshot('B').components.find(item => item.key === 'InputPump_STATE').runtimeMs, 0);
});

test('observed runtime formatting stays compact', () => {
  assert.equal(formatObservedRuntime(59_000), '0 min');
  assert.equal(formatObservedRuntime(61_000), '1 min');
  assert.equal(formatObservedRuntime(3_900_000), '1 h 5 min');
});

