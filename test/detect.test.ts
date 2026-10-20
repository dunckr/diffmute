import assert from 'node:assert/strict';
import { test } from 'vitest';

import { parseCounts, whitespaceOnly } from '../src/detect.ts';

test('parseCounts reads GitHub header text', () => {
  assert.deepEqual(parseCounts('4 changes: 2 additions & 2 deletions'), {
    additions: 2,
    changes: 4,
    deletions: 2,
  });
  assert.deepEqual(parseCounts('2 changes: 1 addition & 1 deletion'), {
    additions: 1,
    changes: 2,
    deletions: 1,
  });
  assert.deepEqual(
    parseCounts(
      '3,720 changes: 1,594 additions & 2,126 deletions 3,720 pnpm-lock.yaml'
    ),
    {
      additions: 1594,
      changes: 3720,
      deletions: 2126,
    }
  );
  assert.equal(parseCounts('pnpm-lock.yaml'), null);
});

test('whitespaceOnly', () => {
  assert.equal(
    whitespaceOnly(['  foo(a, b)'], ['    foo(a, b)']),
    true,
    'reindent'
  );
  assert.equal(
    whitespaceOnly(['foo(a, b)'], ['foo(', '  a,', '  b)']),
    true,
    'rewrap'
  );
  assert.equal(whitespaceOnly([], ['']), true, 'blank line added');
  assert.equal(whitespaceOnly(['foo(a)'], ['foo(b)']), false, 'real change');
  assert.equal(
    whitespaceOnly(['a', 'b'], ['b', 'a']),
    false,
    'reordered lines'
  );
  assert.equal(whitespaceOnly([], []), false, 'no lines');
});
