import assert from 'node:assert/strict';
import { test } from 'vitest';

import { summaryText } from '../src/summary.ts';

const cats = [
  { id: 'lockfiles', mode: 'collapse' as const, name: 'lockfiles' },
  { id: 'tests', mode: 'collapse' as const, name: 'tests' },
  { id: 'snapshots', mode: 'hide' as const, name: 'snapshots' },
];

test('summaryText', () => {
  const counts = new Map([
    ['lockfiles', 1],
    ['snapshots', 2],
    ['tests', 12],
  ]);
  assert.equal(
    summaryText(cats, counts, new Set(), 20),
    'Collapsed 1 lockfile, 12 tests · Hidden 2 snapshots'
  );
  assert.equal(
    summaryText(cats, counts, new Set(['lockfiles', 'snapshots', 'tests']), 20),
    'Showing all files'
  );
  assert.equal(
    summaryText(cats, new Map(), new Set(), 1),
    'No noise in 1 file'
  );
});
