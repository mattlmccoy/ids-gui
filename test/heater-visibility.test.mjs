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

test('generic HTC fault is suppressed only when telemetry identifies an unused channel', () => {
  heaters.setHeaterVisibility('MainHeater', false);
  store.data = {
    MainHeaterTemperature_STATE: 999,
    AUXHeaterTemperature_STATE: 24
  };
  assert.equal(heaters.shouldSuppressHeaterError('HTC_ERROR'), true);

  store.data = {
    MainHeaterTemperature_STATE: 24,
    AUXHeaterTemperature_STATE: 24
  };
  assert.equal(heaters.shouldSuppressHeaterError('HTC_ERROR'), false);
});
