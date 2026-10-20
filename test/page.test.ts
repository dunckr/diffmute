import assert from 'node:assert/strict';
import { test } from 'vitest';

import { parsePage, renameCandidates } from '../src/page.ts';

test('pull request pages', () => {
  assert.deepEqual(parsePage('/Acme/Tool/pull/12/files'), {
    number: '12',
    path: '/Acme/Tool/pull/12/files',
    prKey: 'acme/tool#12',
    repo: 'Acme/Tool',
    whole: true,
  });
  assert.equal(parsePage('/a/b/pull/12/changes')?.whole, true);
  assert.equal(
    parsePage('/a/b/pull/12/files/abc..def')?.whole,
    false,
    'commit range'
  );
  assert.equal(parsePage('/a/b/pull/12/commits/abc123')?.whole, false);
  assert.equal(parsePage('/a/b/pull/12'), null, 'conversation tab');
});

test('commit and compare pages', () => {
  assert.equal(parsePage('/a/b/commit/0123abc')?.prKey, 'a/b@0123abc');
  assert.equal(parsePage('/a/b/commit/0123abc')?.number, null);
  assert.equal(
    parsePage('/a/b/compare/main...feat%2Fx')?.prKey,
    'a/b@main...feat/x'
  );
  assert.equal(parsePage('/a/b/tree/main'), null);
});

test('renameCandidates', () => {
  assert.deepEqual(renameCandidates('src/a.ts'), ['src/a.ts']);
  assert.deepEqual(renameCandidates('old/a.ts → new/a.ts'), [
    'old/a.ts → new/a.ts',
    'new/a.ts',
  ]);
  assert.deepEqual(renameCandidates('  '), []);
});
