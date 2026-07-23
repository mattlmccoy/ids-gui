import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUI_AUTO_OFF_DEFAULTS, activeMaintenanceMode, allModesOffCommands,
  formatCountdown, modeReadbackMatches, normalizeAutoOffSeconds
} from '../js/mode-control.js';

test('all modes off commands include Run and every maintenance mode', () => {
  assert.deepEqual(allModesOffCommands().map(JSON.parse), [
    { Run_MODE: '0' }, { Purge_MODE: '0' }, { Flush_MODE: '0' },
    { Drain_MODE: '0' }, { Bypass_MODE: '0' }
  ]);
});

test('GUI auto-off accepts only explicit supported durations', () => {
  assert.deepEqual(GUI_AUTO_OFF_DEFAULTS, { Purge_MODE: 30, Drain_MODE: 60, Bypass_MODE: 120 });
  assert.equal(normalizeAutoOffSeconds('30', 0), 30);
  assert.equal(normalizeAutoOffSeconds(null, 60), 60);
  assert.equal(normalizeAutoOffSeconds('45', 60), 60);
});

test('maintenance interlock ignores bypass and the requested mode', () => {
  assert.equal(activeMaintenanceMode({ Purge_MODE: '1', Bypass_MODE: '1' }, 'Drain_MODE'), 'Purge_MODE');
  assert.equal(activeMaintenanceMode({ Drain_MODE: 1 }, 'Drain_MODE'), null);
});

test('readback and compact countdown formatting are deterministic', () => {
  assert.equal(modeReadbackMatches({ Run_MODE: '1' }, 'Run_MODE', 1), true);
  assert.equal(modeReadbackMatches({}, 'Run_MODE', 0), false);
  assert.equal(formatCountdown(61000), '1:01');
  assert.equal(formatCountdown(-1), '0:00');
});
