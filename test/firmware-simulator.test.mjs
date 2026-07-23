import test from 'node:test';
import assert from 'node:assert/strict';
import store from '../js/state.js';
import { handleSimulatedCommand, simulatorFrame } from '../js/firmware-simulator.js';

test('firmware simulator scenarios provide safe diagnostic evidence', () => {
  const normal = simulatorFrame('normal', 10);
  assert.equal(normal.SystemID, 'SIMULATOR');
  assert.equal(normal.Run_MODE, '1');
  assert.ok(Number(normal.Vacuum_STATE) > 0);
  const failed = simulatorFrame('no-response', 10);
  assert.equal(failed.Vacuum_STATE, '0.0');
  assert.equal(failed.Pressure_STATE, '0.0');
  const decay = simulatorFrame('vacuum-decay', 12);
  assert.equal(decay.VacuumPump_STATE, '0');
});

test('simulated commands update mode and output readbacks only during simulation', () => {
  assert.equal(handleSimulatedCommand('{"Drain_MODE":"1"}'), false);
  store.setSimulationActive(true, 'test');
  assert.equal(handleSimulatedCommand('{"Drain_MODE":"1"}'), true);
  assert.equal(store.data.Drain_MODE, '1');
  assert.equal(store.data.DrainPump_STATE, '1');
  assert.equal(store.data.ManifoldValve1_STATE, '1');
  store.setSimulationActive(false, '');
  store.replaceData({});
});
