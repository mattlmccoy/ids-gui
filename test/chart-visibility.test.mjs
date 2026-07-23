import test from 'node:test';
import assert from 'node:assert/strict';
import { CHART_IDS, normalizeVisibleCharts } from '../js/chart-visibility.js';

test('CHART_IDS lists the three Trends charts', () => {
  assert.deepEqual([...CHART_IDS], ['temperature', 'pressure', 'states']);
});

test('normalizeVisibleCharts defaults everything visible for empty/invalid input', () => {
  for (const input of [null, undefined, {}, 'nonsense', 42, []]) {
    assert.deepEqual(normalizeVisibleCharts(input), { temperature: true, pressure: true, states: true });
  }
});

test('normalizeVisibleCharts hides only explicitly false charts', () => {
  assert.deepEqual(normalizeVisibleCharts({ temperature: false }), {
    temperature: false, pressure: true, states: true
  });
  assert.deepEqual(normalizeVisibleCharts({ temperature: false, pressure: false, states: false }), {
    temperature: false, pressure: false, states: false
  });
});

test('normalizeVisibleCharts ignores unknown keys and non-false truthy values', () => {
  const result = normalizeVisibleCharts({ pressure: 'yes', bogus: false, temperature: 0 });
  // only literal false hides a known chart; unknown keys are dropped; 0 is not false-for-a-known-key here → treat non-false as visible
  assert.deepEqual(result, { temperature: true, pressure: true, states: true });
  assert.equal('bogus' in result, false);
});
