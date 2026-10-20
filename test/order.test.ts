import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  isReviewOrderHeading,
  matchesPin,
  orderFiles,
  pinFromItem,
} from '../src/order.ts';
import { defaultConfig } from '../src/rules.ts';

const tiers = defaultConfig().tiers;

test('orderFiles groups by tier and keeps GitHub order within a tier', () => {
  const paths = [
    'package.json',
    'src/components/Button.tsx',
    'src/api/client.ts',
    'src/types.ts',
    'src/components/Button.test.tsx',
    'src/api/retry.ts',
    '.gitignore',
  ];
  assert.deepEqual(
    orderFiles(paths, tiers).map((f) => `${f.tier} ${f.path}`),
    [
      'contracts src/types.ts',
      'core src/api/client.ts',
      'core src/api/retry.ts',
      'ui src/components/Button.tsx',
      'tests src/components/Button.test.tsx',
      'config package.json',
      'config .gitignore',
    ]
  );
});

test('pinned files come first in pin order', () => {
  const paths = ['src/a.ts', 'src/b.ts', 'src/types.ts', 'docs/x.md'];
  assert.deepEqual(
    orderFiles(paths, tiers, ['src/b.ts', 'docs/']).map(
      (f) => `${f.tier} ${f.path}`
    ),
    [
      'start src/b.ts',
      'start docs/x.md',
      'contracts src/types.ts',
      'core src/a.ts',
    ]
  );
});

test('matchesPin', () => {
  assert.ok(matchesPin('src/api/client.ts', 'src/api/client.ts'));
  assert.ok(matchesPin('src/api/client.ts', 'src/api'));
  assert.ok(matchesPin('src/api/client.ts', './src/api/'));
  assert.ok(matchesPin('src/api/client.ts', 'client.ts'), 'basename');
  assert.ok(matchesPin('src/api/client.ts', 'src/**/*.ts'), 'glob');
  assert.ok(!matchesPin('src/apiv2/client.ts', 'src/api'));
  assert.ok(!matchesPin('src/a.ts', ''));
});

test('pinFromItem prefers code spans, then a path-like token', () => {
  assert.equal(
    pinFromItem('src/types.ts', 'src/types.ts - the new shape'),
    'src/types.ts'
  );
  assert.equal(
    pinFromItem(null, 'Start with src/types.ts, then the rest'),
    'src/types.ts'
  );
  assert.equal(
    pinFromItem(null, 'the migration (db/migrate/001.sql)'),
    'db/migrate/001.sql'
  );
  assert.equal(
    pinFromItem(null, 'see https://example.com/x for context'),
    null
  );
  assert.equal(pinFromItem(null, 'everything else'), null);
});

test('isReviewOrderHeading', () => {
  assert.ok(isReviewOrderHeading('Review order'));
  assert.ok(isReviewOrderHeading('## Review order:'));
  assert.ok(isReviewOrderHeading('review-order'));
  assert.ok(!isReviewOrderHeading('How to review'));
});
