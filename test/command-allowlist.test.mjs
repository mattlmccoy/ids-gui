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
