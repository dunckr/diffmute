import assert from 'node:assert/strict';
import { test } from 'vitest';

import { lineAnchor, nextFile } from '../src/nav.ts';

test('nextFile skips files that need no attention', () => {
  const done = [false, true, true, false, false];
  const skip = (index: number) => done[index];
  assert.equal(nextFile(-1, 5, skip), 0, 'from before the first file');
  assert.equal(nextFile(0, 5, skip), 3);
  assert.equal(nextFile(3, 5, skip), 4);
  assert.equal(nextFile(4, 5, skip), -1, 'no wraparound at the end');
  assert.equal(nextFile(3, 5, skip, -1), 0, 'backwards');
  assert.equal(nextFile(0, 5, skip, -1), -1);
  assert.equal(
    nextFile(-1, 5, () => true),
    -1,
    'everything done'
  );
});

test('lineAnchor reads file and line from a diff link', () => {
  const sha = 'a'.repeat(64);
  assert.deepEqual(lineAnchor(`#diff-${sha}R12`), {
    file: sha,
    line: `diff-${sha}R12`,
  });
  assert.deepEqual(lineAnchor(`#diff-${sha}L3-L9`), {
    file: sha,
    line: `diff-${sha}L3`,
  });
  assert.equal(lineAnchor(`#diff-${sha}`), null, 'file only');
  assert.equal(lineAnchor('#discussion_r1'), null);
  assert.equal(lineAnchor(''), null);
});
