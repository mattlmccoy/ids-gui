/* Disconnected-only firmware simulator for UI and diagnostic development. */

import store from './state.js';

const SCENARIOS = new Set(['normal', 'no-response', 'vacuum-decay', 'excessive-cycling', 'slow-start']);
let timer = null;
let tickCount = 0;
let scenario = 'normal';
let savedData = null;
let commandOverrides = {};

export function startFirmwareSimulator(requestedScenario = 'normal') {
  if (store.connection !== 'DISCONNECTED') throw new Error('Disconnect the physical controller before starting simulation.');
  stopFirmwareSimulator(false);
  scenario = SCENARIOS.has(requestedScenario) ? requestedScenario : 'normal';
  savedData = { ...store.data };
  tickCount = 0;
  commandOverrides = {};
  store.setReplayActive(true);
  store.setSimulationActive(true, scenario);
  emitFrame();
  timer = setInterval(emitFrame, 1000);
  store.log('info', `Firmware simulator started: ${scenario} (remote alerts and hardware commands suppressed)`);
  return scenario;
}

export function stopFirmwareSimulator(restore = true) {
  if (timer) clearInterval(timer);
  timer = null;
  if (!store.simulationActive) return;
  store.setSimulationActive(false, '');
  store.setReplayActive(false);
  if (restore) store.replaceData(savedData || {});
  savedData = null;
  commandOverrides = {};
  store.log('info', 'Firmware simulator stopped; pre-simulation telemetry restored');
}

export function getFirmwareSimulatorState() {
  return { active: !!store.simulationActive, scenario, tickCount };
}

export function simulatorFrame(name, tick) {
  const phase = Number(tick) || 0;
  const base = {
    SystemID: 'SIMULATOR', SoftwareRev: 'R17-SIM', AlarmStatus: 'RUN-NO_ERROR',
    Run_MODE: '1', Purge_MODE: '0', Flush_MODE: '0', Drain_MODE: '0',
    Vacuum_SETPOINT: '28', Flow_SETPOINT: '50', Temperature_SETPOINT: '25', PressureMAX_SETPOINT: '20',
    FluidTemperature_STATE: (22 + Math.min(3, phase * 0.08)).toFixed(1),
    VacuumPump_STATE: '1', RecirculationPump_STATE: '1', InputPump_STATE: '1',
    ManifoldValve1_STATE: '1', ManifoldValve2_STATE: '1',
    InletPressure_STATE: '1.80', ReturnPressure_STATE: '1.20'
  };
  if (name === 'no-response') return { ...base, Vacuum_STATE: '0.0', Pressure_STATE: '0.0' };
  if (name === 'slow-start') return { ...base, Vacuum_STATE: Math.min(7, phase * 0.35).toFixed(1), Pressure_STATE: Math.min(0.8, phase * 0.04).toFixed(2) };
  if (name === 'excessive-cycling') {
    const on = phase % 2 === 0;
    return { ...base, VacuumPump_STATE: on ? '1' : '0', InputPump_STATE: on ? '1' : '0', Vacuum_STATE: (20 + (on ? 1.2 : -1.2)).toFixed(1), Pressure_STATE: '1.4' };
  }
  if (name === 'vacuum-decay') {
    const pumping = phase < 8;
    const vacuum = pumping ? Math.min(24, phase * 3.2) : Math.max(0, 24 - (phase - 8) * 3.0);
    return { ...base, Run_MODE: pumping ? '1' : '0', VacuumPump_STATE: pumping ? '1' : '0', Vacuum_STATE: vacuum.toFixed(1), Pressure_STATE: '1.2' };
  }
  return { ...base, Vacuum_STATE: Math.min(24, phase * 3).toFixed(1), Pressure_STATE: Math.min(1.6, phase * 0.2).toFixed(2) };
}

export function handleSimulatedCommand(jsonStr) {
  if (!store.simulationActive) return false;
  let command;
  try { command = JSON.parse(jsonStr); } catch { return false; }
  if (!command || Array.isArray(command) || typeof command !== 'object') return false;
  store.emit('command-sent', jsonStr);
  if (command.GET !== undefined) return true;
  if (command.WatchdogTrigger_MODE !== undefined) {
    tickCount = 0;
    commandOverrides = {};
    store.log('info', 'Simulator watchdog reset');
    return true;
  }
  const updates = {};
  for (const [key, raw] of Object.entries(command)) {
    const value = String(raw);
    updates[key] = value;
    applyModeOutputs(key, Number(value), updates);
  }
  commandOverrides = { ...commandOverrides, ...updates };
  store.setData(updates);
  if (Number(command.Flush_MODE) === 1) {
    setTimeout(() => {
      if (!store.simulationActive) return;
      const failedFlush = { Flush_MODE: '0', flushPump_STATE: '0', flushValve_STATE: '0' };
      commandOverrides = { ...commandOverrides, ...failedFlush };
      store.setData(failedFlush);
      store.log('warning', 'Simulator reproduced the R17 Flush timer clearing immediately');
    }, 150);
  }
  return true;
}

function emitFrame() {
  store.setData({ ...simulatorFrame(scenario, tickCount), ...commandOverrides });
  tickCount += 1;
}

function applyModeOutputs(key, value, updates) {
  const on = value === 1 ? '1' : '0';
  const outputMap = {
    Run_MODE: ['VacuumPump_STATE', 'RecirculationPump_STATE', 'InputPump_STATE', 'ManifoldValve1_STATE', 'ManifoldValve2_STATE'],
    Purge_MODE: ['RecirculationPump_STATE', 'InputPump_STATE'],
    Flush_MODE: ['flushPump_STATE', 'flushValve_STATE'],
    Drain_MODE: ['DrainPump_STATE', 'ManifoldValve1_STATE', 'ManifoldValve2_STATE']
  };
  for (const output of outputMap[key] || []) updates[output] = on;
}
