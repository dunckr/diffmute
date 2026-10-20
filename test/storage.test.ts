import assert from 'node:assert/strict';
import { test } from 'vitest';

import { defaultConfig, normalizeConfig } from '../src/rules.ts';
import { fromStored, toStored } from '../src/storage.ts';

test('each category gets its own sync key and round-trips', () => {
  const config = defaultConfig();
  const stored = toStored(config);
  assert.deepEqual(
    stored.categoryOrder,
    config.categories.map((c) => c.id)
  );
  assert.deepEqual(
    stored['category:tests'],
    config.categories.find((c) => c.id === 'tests')
  );
  assert.equal(stored.categories, undefined, 'no single big key');
  assert.deepEqual(fromStored(stored), config);
});

test('configs saved under the old single key still load', () => {
  const legacy = {
    categories: [{ id: 'tests', patterns: ['**/*.test.*'] }],
    repos: { 'A/B': { off: true } },
  };
  const config = fromStored(legacy);
  assert.deepEqual(config, normalizeConfig(legacy));
  assert.equal(config.repos['a/b'].off, true);
});

test('categoryOrder decides order and drops missing categories', () => {
  const stored = toStored(defaultConfig());
  stored.categoryOrder = ['tests', 'gone', 'lockfiles'];
  const ids = fromStored(stored).categories.map((c) => c.id);
  assert.deepEqual(ids, [
    'deleted',
    'renamed',
    'whitespace',
    'tests',
    'lockfiles',
  ]);
});
