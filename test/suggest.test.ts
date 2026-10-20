import assert from 'node:assert/strict';
import { test } from 'vitest';

import { suggestPatterns } from '../src/suggest.ts';

test('suggestPatterns goes from narrow to broad', () => {
  assert.deepEqual(
    suggestPatterns('src/api/__mocks__/client.test.ts').map((s) => s.pattern),
    [
      'client.test.ts',
      '**/*.test.ts',
      '**/*.ts',
      '**/__mocks__/**',
      '/src/api/__mocks__/**',
    ]
  );
  assert.deepEqual(
    suggestPatterns('src/data.json').map((s) => s.pattern),
    ['data.json', '**/*.json', '/src/**'],
    'generic folders are skipped'
  );
  assert.deepEqual(
    suggestPatterns('Makefile').map((s) => s.pattern),
    ['Makefile']
  );
});
