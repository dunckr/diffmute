import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, sameFingerprint, tagFiles } from "../src/revisit.ts";

const counts = (a: number, d: number) => ({ changes: a + d, additions: a, deletions: d });

test("fingerprint and comparison", () => {
  const full = fingerprint(counts(2, 1), "abc");
  assert.equal(full, "2/1:abc");
  assert.ok(sameFingerprint(full, "2/1:abc"));
  assert.ok(!sameFingerprint(full, "2/1:def"), "same counts, different lines");
  assert.ok(sameFingerprint(full, fingerprint(counts(2, 1), "")), "unrendered side falls back to counts");
  assert.ok(!sameFingerprint(full, fingerprint(counts(3, 1), "")));
  assert.ok(!sameFingerprint("?:", "?:x"), "unknown counts never match by counts");
});

test("tagFiles", () => {
  const now = new Map([
    ["a", "1/0:x"],
    ["b", "1/0:y"],
    ["c", "4/0:z"],
  ]);
  assert.equal(tagFiles({}, now).size, 0, "first visit tags nothing");
  const tags = tagFiles({ a: "1/0:x", b: "1/0:old" }, now);
  assert.deepEqual(Object.fromEntries(tags), { a: "unchanged", b: "changed", c: "new" });
});
