import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANGELOG, unseenCount, latestVersion } from '../js/changelog.js';

test('CHANGELOG is a non-empty newest-first list with the required shape', () => {
  assert.ok(Array.isArray(CHANGELOG) && CHANGELOG.length > 0);
  for (const entry of CHANGELOG) {
    assert.equal(typeof entry.version, 'string');
    assert.equal(typeof entry.title, 'string');
    assert.ok(Array.isArray(entry.items) && entry.items.length > 0);
  }
  // newest first: first entry's version sorts >= the second's (string date compare is fine here)
  if (CHANGELOG.length > 1) assert.ok(CHANGELOG[0].version >= CHANGELOG[1].version);
});

test('latestVersion returns the first entry version', () => {
  assert.equal(latestVersion(CHANGELOG), CHANGELOG[0].version);
  assert.equal(latestVersion([]), null);
});

test('unseenCount counts entries newer than the last-seen version', () => {
  const entries = [{ version: 'c' }, { version: 'b' }, { version: 'a' }];
  assert.equal(unseenCount(entries, null), 3);        // never seen → all new
  assert.equal(unseenCount(entries, 'c'), 0);          // seen the latest → none new
  assert.equal(unseenCount(entries, 'b'), 1);          // one newer than 'b'
  assert.equal(unseenCount(entries, 'a'), 2);
  assert.equal(unseenCount(entries, 'zzz-unknown'), 3); // unknown/older → treat all as new
  assert.equal(unseenCount(null, 'a'), 0);
});
