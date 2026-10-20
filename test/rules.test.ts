import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, defaultConfig, normalizeConfig, resolveRules, type Config } from "../src/rules.ts";

const idFor = (path: string, config: Config = defaultConfig(), repo = "o/r") =>
  classify(path, resolveRules(config, repo))?.id ?? null;

test("default categories", () => {
  assert.equal(idFor("package-lock.json"), "lockfiles");
  assert.equal(idFor("services/api/go.sum"), "lockfiles");
  assert.equal(idFor("src/app.test.ts"), "tests");
  assert.equal(idFor("pkg/server_test.go"), "tests");
  assert.equal(idFor("src/__tests__/__snapshots__/app.test.ts.snap"), "snapshots");
  assert.equal(idFor("api/v1/service.pb.go"), "generated");
  assert.equal(idFor("src/app.ts"), null);
  assert.equal(idFor("go.mod"), null);
});

test("repo override can turn a category off or change its mode", () => {
  const config = normalizeConfig({
    ...defaultConfig(),
    repos: { "Acme/Tool": { categories: { tests: { enabled: false }, lockfiles: { mode: "hide" } } } },
  });
  assert.equal(idFor("src/app.test.ts", config, "acme/tool"), null);
  assert.equal(idFor("src/app.test.ts", config, "other/repo"), "tests");
  assert.equal(classify("yarn.lock", resolveRules(config, "acme/tool"))?.mode, "hide");
});

test("repo ignore globs and off switch", () => {
  const config = normalizeConfig({
    ...defaultConfig(),
    repos: { "a/b": { ignore: ["/test/**"] }, "c/d": { off: true } },
  });
  assert.equal(idFor("test/runner.js", config, "a/b"), null);
  assert.equal(idFor("lib/test/runner.js", config, "a/b"), "tests");
  assert.equal(idFor("yarn.lock", config, "c/d"), null);
});

test("normalizeConfig falls back to defaults and cleans input", () => {
  assert.deepEqual(normalizeConfig(null), defaultConfig());
  const c = normalizeConfig({ categories: [{ id: "x", mode: "bogus", patterns: ["a", " "] }] });
  assert.deepEqual(c.categories, [{ id: "x", name: "x", mode: "collapse", enabled: true, patterns: ["a"] }]);
});
