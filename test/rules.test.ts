import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  classify,
  type Config,
  defaultConfig,
  normalizeConfig,
  resolveRules,
} from '../src/rules.ts';

const idFor = (path: string, config: Config = defaultConfig(), repo = 'o/r') =>
  classify(path, resolveRules(config, repo))?.id ?? null;

test('default categories', () => {
  assert.equal(idFor('package-lock.json'), 'lockfiles');
  assert.equal(idFor('services/api/go.sum'), 'lockfiles');
  assert.equal(idFor('src/app.test.ts'), 'tests');
  assert.equal(idFor('pkg/server_test.go'), 'tests');
  assert.equal(
    idFor('src/__tests__/__snapshots__/app.test.ts.snap'),
    'snapshots'
  );
  assert.equal(idFor('api/v1/service.pb.go'), 'generated');
  assert.equal(idFor('src/app.ts'), null);
  assert.equal(idFor('go.mod'), null);
});

test('repo override can turn a category off or change its mode', () => {
  const config = normalizeConfig({
    ...defaultConfig(),
    repos: {
      'Acme/Tool': {
        categories: { lockfiles: { mode: 'hide' }, tests: { enabled: false } },
      },
    },
  });
  assert.equal(idFor('src/app.test.ts', config, 'acme/tool'), null);
  assert.equal(idFor('src/app.test.ts', config, 'other/repo'), 'tests');
  assert.equal(
    classify('yarn.lock', resolveRules(config, 'acme/tool'))?.mode,
    'hide'
  );
});

test('repo ignore globs and off switch', () => {
  const config = normalizeConfig({
    ...defaultConfig(),
    repos: { 'a/b': { ignore: ['/test/**'] }, 'c/d': { off: true } },
  });
  assert.equal(idFor('test/runner.js', config, 'a/b'), null);
  assert.equal(idFor('lib/test/runner.js', config, 'a/b'), 'tests');
  assert.equal(idFor('yarn.lock', config, 'c/d'), null);
});

test('normalizeConfig falls back to defaults and cleans input', () => {
  assert.deepEqual(normalizeConfig(null), defaultConfig());
  const c = normalizeConfig({
    categories: [{ id: 'x', mode: 'bogus', patterns: ['a', ' '] }],
  });
  assert.deepEqual(c.categories.at(-1), {
    enabled: true,
    id: 'x',
    mode: 'collapse',
    name: 'x',
    patterns: ['a'],
  });
});

test('structural categories match on facts, in list order', () => {
  const rules = resolveRules(defaultConfig(), 'o/r');
  assert.equal(classify('src/app.ts', rules, { deleted: true })?.id, 'deleted');
  assert.equal(
    classify('src/app.test.ts', rules, { deleted: true })?.id,
    'deleted',
    'structural first by default'
  );
  assert.equal(classify('src/app.ts', rules, { renamed: true })?.id, 'renamed');
  assert.equal(
    classify('src/app.ts', rules, { whitespace: true })?.id,
    'whitespace'
  );
  assert.equal(
    classify('src/app.ts', rules, { whitespace: null })?.id,
    undefined,
    'unknown never matches'
  );
  assert.equal(
    classify('src/app.test.ts', rules)?.id,
    'tests',
    'no facts, globs only'
  );
});

test('configs saved before structural categories get them added', () => {
  const old = normalizeConfig({
    categories: [{ id: 'tests', patterns: ['**/*.test.*'] }],
  });
  assert.deepEqual(
    old.categories.map((c) => c.id),
    ['deleted', 'renamed', 'whitespace', 'tests']
  );
  const off = normalizeConfig({
    categories: [{ enabled: false, id: 'renamed', patterns: ['x'] }],
  });
  const renamed = off.categories.find((c) => c.id === 'renamed')!;
  assert.equal(renamed.enabled, false);
  assert.deepEqual(
    renamed.patterns,
    [],
    'structural categories never keep patterns'
  );
  assert.equal(renamed.detect, 'renamed');
});

test('repo override can turn a structural category off', () => {
  const config = normalizeConfig({
    ...defaultConfig(),
    repos: { 'a/b': { categories: { whitespace: { enabled: false } } } },
  });
  assert.equal(
    classify('x.ts', resolveRules(config, 'a/b'), { whitespace: true }),
    null
  );
});

test('features and tiers default and survive a round trip', () => {
  const c = normalizeConfig({
    features: { keys: false },
    tiers: { ui: ['**/*.tsx', ' '] },
  });
  assert.deepEqual(c.features, { keys: false, order: true, revisit: true });
  assert.deepEqual(c.tiers.ui, ['**/*.tsx']);
  assert.deepEqual(c.tiers.contracts, defaultConfig().tiers.contracts);
  assert.deepEqual(normalizeConfig(structuredClone(c)), c);
});

test('global never-mute globs apply to every repo and combine with repo ones', () => {
  const config = normalizeConfig({
    ...defaultConfig(),
    ignore: ['/legacy/**'],
    repos: { 'a/b': { ignore: ['!/legacy/test/**'] } },
  });
  assert.equal(idFor('legacy/test/x.test.ts', config, 'o/r'), null);
  assert.equal(idFor('legacy/test/x.test.ts', config, 'a/b'), 'tests');
});

test('new default patterns and off-by-default categories', () => {
  assert.equal(idFor('deno.lock'), 'lockfiles');
  assert.equal(idFor('spec/models/user_spec.rb'), 'tests');
  assert.equal(idFor('cypress/login.cy.ts'), 'tests');
  assert.equal(idFor('pkg/testdata/in.txt'), 'snapshots');
  assert.equal(idFor('src/__generated__/schema.ts'), 'generated');
  assert.equal(idFor('lib/model.g.dart'), 'generated');
  assert.equal(idFor('README.md'), null, 'docs is off by default');
  const docs = normalizeConfig({
    ...defaultConfig(),
    categories: defaultConfig().categories.map((c) =>
      c.id === 'docs' ? { ...c, enabled: true } : c
    ),
  });
  assert.equal(idFor('README.md', docs), 'docs');
});
