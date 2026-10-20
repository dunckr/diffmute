import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCounts, whitespaceOnly } from "../src/detect.ts";

test("parseCounts reads GitHub header text", () => {
  assert.deepEqual(parseCounts("4 changes: 2 additions & 2 deletions"), { changes: 4, additions: 2, deletions: 2 });
  assert.deepEqual(parseCounts("2 changes: 1 addition & 1 deletion"), { changes: 2, additions: 1, deletions: 1 });
  assert.deepEqual(parseCounts("3,720 changes: 1,594 additions & 2,126 deletions 3,720 pnpm-lock.yaml"), {
    changes: 3720,
    additions: 1594,
    deletions: 2126,
  });
  assert.equal(parseCounts("pnpm-lock.yaml"), null);
});

test("whitespaceOnly", () => {
  assert.equal(whitespaceOnly(["  foo(a, b)"], ["    foo(a, b)"]), true, "reindent");
  assert.equal(whitespaceOnly(["foo(a, b)"], ["foo(", "  a,", "  b)"]), true, "rewrap");
  assert.equal(whitespaceOnly([], [""]), true, "blank line added");
  assert.equal(whitespaceOnly(["foo(a)"], ["foo(b)"]), false, "real change");
  assert.equal(whitespaceOnly(["a", "b"], ["b", "a"]), false, "reordered lines");
  assert.equal(whitespaceOnly([], []), false, "no lines");
});
