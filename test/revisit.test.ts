import assert from 'node:assert/strict';
import { test } from 'vitest';

import { fingerprint, sameFingerprint, tagFile } from '../src/revisit.ts';

const counts = (a: number, d: number) => ({
  additions: a,
  changes: a + d,
  deletions: d,
});

test('fingerprint and comparison', () => {
  const full = fingerprint(counts(2, 1), 'abc');
  assert.equal(full, '2/1:abc');
  assert.ok(sameFingerprint(full, '2/1:abc'));
  assert.ok(!sameFingerprint(full, '2/1:def'), 'same counts, different lines');
  assert.ok(
    sameFingerprint(full, fingerprint(counts(2, 1), '')),
    'unrendered side falls back to counts'
  );
  assert.ok(!sameFingerprint(full, fingerprint(counts(3, 1), '')));
  assert.ok(
    !sameFingerprint('?:', '?:x'),
    'unknown counts never match by counts'
  );
});

test('tagFile', () => {
  assert.equal(tagFile({}, 'a', '1/0:x'), null, 'first visit tags nothing');
  const baseline = { a: '1/0:x', b: '1/0:old' };
  assert.equal(tagFile(baseline, 'a', '1/0:x'), 'unchanged');
  assert.equal(tagFile(baseline, 'b', '1/0:y'), 'changed');
  assert.equal(tagFile(baseline, 'c', '4/0:z'), 'new');
});
