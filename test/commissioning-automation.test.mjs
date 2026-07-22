import test from 'node:test';
import assert from 'node:assert/strict';
import {
  binaryMatches, hasActiveAlarm, modeCommand, numericMatches,
  safeShutdownCommands, selectedCircuitTests, setpointCommand, vacuumResponse
} from '../js/commissioning-automation.js';

test('alarm gate accepts operational NO_ERROR forms only', () => {
  assert.equal(hasActiveAlarm({ AlarmStatus: 'STOP-NO_ERROR' }), false);
  assert.equal(hasActiveAlarm({ AlarmStatus: 'NO_ERROR' }), false);
  assert.equal(hasActiveAlarm({ AlarmStatus: 'RUN-HTC' }), true);
});

test('commands are constrained to known commissioning controls', () => {
  assert.equal(modeCommand('Flush_MODE', true), '{"Flush_MODE":"1"}');
  assert.equal(setpointCommand('Vacuum_SETPOINT', 28), '{"Vacuum_SETPOINT":"28"}');
  assert.throws(() => modeCommand('Heater_MODE', true));
  assert.throws(() => setpointCommand('Vacuum_SETPOINT', 101));
  assert.equal(safeShutdownCommands().length, 5);
  assert.ok(safeShutdownCommands().every(command => command.includes('"0"')));
});

test('readback evaluators require complete evidence', () => {
  assert.equal(binaryMatches({ A: 1, B: '1' }, ['A', 'B'], true), true);
  assert.equal(binaryMatches({ A: 1 }, ['A', 'B'], true), false);
  assert.equal(numericMatches('28', 28), true);
  assert.deepEqual(vacuumResponse(2, -3, 4), { pass: true, delta: 5 });
  assert.equal(vacuumResponse(2, 3, 4).pass, false);
});

test('operator selections control the generated circuit queue', () => {
  assert.deepEqual(selectedCircuitTests({ flush: true, drain: false, bypass: true }).map(item => item.key), ['flush', 'bypass']);
});
