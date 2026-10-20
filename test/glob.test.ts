import assert from 'node:assert/strict';
import { test } from 'vitest';

import { matches, matchesAny } from '../src/glob.ts';

const cases: [glob: string, path: string, expected: boolean][] = [
  ['yarn.lock', 'yarn.lock', true],
  ['yarn.lock', 'packages/a/yarn.lock', true],
  ['yarn.lock', 'yarn.lock.bak', false],
  ['/yarn.lock', 'packages/a/yarn.lock', false],
  ['**/*.test.*', 'app.test.ts', true],
  ['**/*.test.*', 'src/deep/app.test.tsx', true],
  ['**/*.test.*', 'src/apptest.ts', false],
  ['**/test/**', 'test/a.js', true],
  ['**/test/**', 'pkg/test/sub/a.js', true],
  ['**/test/**', 'pkg/testing/a.js', false],
  ['**/__snapshots__/**', 'src/__snapshots__/a.snap', true],
  ['**/*Test.java', 'src/main/FooTest.java', true],
  ['**/*Test.java', 'src/main/Test.java', true],
  ['**/test_*.py', 'tests/test_app.py', true],
  ['**/test_*.py', 'app/attest_x.py', false],
  ['**/dist/**', 'dist/index.js', true],
  ['**/dist/**', 'distro/index.js', false],
  ['*.min.js', 'public/vendor/jquery.min.js', true],
  ['src/*.js', 'src/a.js', true],
  ['src/*.js', 'src/sub/a.js', false],
  ['src/**/*.js', 'src/a.js', true],
  ['src/**/*.js', 'src/sub/a.js', true],
  ['**/*.{snap,golden}', 'x/y.golden', true],
  ['**/*.{snap,golden}', 'x/y.gold', false],
  ['file?.txt', 'file1.txt', true],
  ['file[!0-9].txt', 'file1.txt', false],
  ['file[!0-9].txt', 'fileA.txt', true],
  ['docs/', 'docs/a/b.md', true],
  ['a+b(c).txt', 'a+b(c).txt', true],
];

for (const [glob, path, expected] of cases) {
  test(`${glob} ${expected ? 'matches' : 'skips'} ${path}`, () => {
    assert.equal(matches(path, glob), expected);
  });
}

test('negation: the last matching line wins', () => {
  const globs = ['**/test/**', '!**/test/helpers/**', '# a comment'];
  assert.equal(matchesAny('pkg/test/a.ts', globs), true);
  assert.equal(matchesAny('pkg/test/helpers/a.ts', globs), false);
  assert.equal(
    matchesAny('pkg/test/helpers/a.ts', [...globs, '**/helpers/a.ts']),
    true
  );
  assert.equal(matchesAny('src/a.ts', ['!src/a.ts']), false);
});
