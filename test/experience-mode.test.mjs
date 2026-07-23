import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExperienceMode } from '../js/experience-mode.js';

test('experience mode defaults safely and accepts only supported views', () => {
  assert.equal(normalizeExperienceMode('simple'), 'simple');
  assert.equal(normalizeExperienceMode('pro'), 'pro');
  assert.equal(normalizeExperienceMode('expert'), 'simple');
  assert.equal(normalizeExperienceMode(null), 'simple');
});
