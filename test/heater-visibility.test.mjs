import test from 'node:test';
import assert from 'node:assert/strict';

const values = new Map([
  ['ids-heater-channels-v1', JSON.stringify({ MainHeater: false, AuxHeater: true })]
]);

globalThis.localStorage = {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { values.set(key, String(value)); }
};

const store = (await import('../js/state.js')).default;
const heaters = await import('../js/heater-visibility.js');

test('saved installed-channel profile is restored', () => {
  assert.deepEqual(heaters.getHeaterVisibility(), {
    MainHeater: false,
    AuxHeater: true
  });
});

test('installed-channel changes persist', () => {
  heaters.setHeaterVisibility('MainHeater', true);
  assert.equal(JSON.parse(values.get('ids-heater-channels-v1')).MainHeater, true);
});

test('generic HTC fault is shown only when an INSTALLED heater is actually faulted', () => {
  heaters.setHeaterVisibility('MainHeater', false); // Main marked not installed
  heaters.setHeaterVisibility('AuxHeater', true);   // Aux installed

  // Disabled Main faulted, installed Aux fine → suppress
  store.data = { MainHeaterTemperature_STATE: 999, AUXHeaterTemperature_STATE: 24 };
  assert.equal(heaters.shouldSuppressHeaterError('HTC_ERROR'), true);

  // Both read normal → no installed channel faulted → suppress (the reported bug: this was showing)
  store.data = { MainHeaterTemperature_STATE: 24, AUXHeaterTemperature_STATE: 24 };
  assert.equal(heaters.shouldSuppressHeaterError('HTC_ERROR'), true);

  // Installed Aux genuinely faulted → MUST show (safety)
  store.data = { MainHeaterTemperature_STATE: 24, AUXHeaterTemperature_STATE: 999 };
  assert.equal(heaters.shouldSuppressHeaterError('HTC_ERROR'), false);

  // Both faulted; installed Aux is faulted → show
  store.data = { MainHeaterTemperature_STATE: 999, AUXHeaterTemperature_STATE: 999 };
  assert.equal(heaters.shouldSuppressHeaterError('HTC_ERROR'), false);
});

test('channel-attributed and both-installed / both-uninstalled rules still hold', () => {
  heaters.setHeaterVisibility('MainHeater', false);
  heaters.setHeaterVisibility('AuxHeater', true);
  store.data = { MainHeaterTemperature_STATE: 999, AUXHeaterTemperature_STATE: 999 };
  // explicitly Main-attributed fault on a disabled Main → suppress regardless of temps
  assert.equal(heaters.shouldSuppressHeaterError('MAIN_HEATER_TC_ERROR'), true);
  // Aux-attributed fault while Aux installed → show
  assert.equal(heaters.shouldSuppressHeaterError('AUX_HEATER_TC_ERROR'), false);

  // both installed → never suppress
  heaters.setHeaterVisibility('MainHeater', true);
  assert.equal(heaters.shouldSuppressHeaterError('HTC_ERROR'), false);

  // both uninstalled → always suppress
  heaters.setHeaterVisibility('MainHeater', false);
  heaters.setHeaterVisibility('AuxHeater', false);
  assert.equal(heaters.shouldSuppressHeaterError('HTC_ERROR'), true);
});
