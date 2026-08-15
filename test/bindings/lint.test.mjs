import assert from "node:assert/strict";
import test from "node:test";

import { loadBindings } from "../../src/bindings/load.mjs";
import { lintBindings } from "../../src/bindings/lint.mjs";

const FIXTURE_DIR = "test/fixtures/bindings";
const CANONICAL_REFS = Object.freeze([
  "screen:catalog",
  "screen:checkout",
  "field:email",
  "item:first_product",
  "badge:cart_count",
  "button:place_order",
  "state:order_confirmed"
]);

test("complete shopdemo bindings have full coverage on web and android", async () => {
  const web = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" });
  const android = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "android" });
  const result = lintBindings({
    refsUsed: CANONICAL_REFS.filter((ref) => ref !== "state:order_confirmed"),
    bindingsBySurface: { web, android },
    surfaces: ["web", "android"]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.coverage.web.unbound, []);
  assert.deepEqual(result.coverage.android.unbound, []);
  assert.equal(result.coverage.web.bound, 6);
  assert.equal(result.coverage.android.bound, 6);
});

test("incomplete bindings fail with ref surface and file named", async () => {
  const incomplete = await loadBindings({ dir: FIXTURE_DIR, app: "incomplete", surface: "web" });
  const result = lintBindings({
    refsUsed: ["field:email", "button:place_order"],
    bindingsBySurface: { web: incomplete },
    surfaces: ["web"]
  });
  const diagnostic = result.diagnostics.errors[0];

  assert.equal(result.ok, false);
  assert.equal(diagnostic.code, "E_UNBOUND_REF");
  assert(diagnostic.reason.includes("button:place_order"));
  assert(diagnostic.reason.includes("web"));
  assert(diagnostic.reason.includes("web.yaml"));
  assert.deepEqual(result.coverage.web.unbound, ["button:place_order"]);
});

test("coverage output is deterministic and sorted", async () => {
  const web = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" });
  const result = lintBindings({
    refsUsed: ["button:missing_z", "button:missing_a", "field:email"],
    bindingsBySurface: { web },
    surfaces: ["web"]
  });

  assert.deepEqual(result.coverage.web.unbound, ["button:missing_a", "button:missing_z"]);
  assert.equal(result.coverage.web.bound, 1);
});

test("unused bindings are warnings, not errors", async () => {
  const web = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" });
  const result = lintBindings({
    refsUsed: ["field:email"],
    bindingsBySurface: { web },
    surfaces: ["web"]
  });
  const warnings = result.diagnostics.all.filter((diagnostic) => diagnostic.severity === "warning");

  assert.equal(result.ok, true);
  assert(warnings.some((diagnostic) => diagnostic.code === "E_BINDING_UNUSED"));
  assert.equal(result.diagnostics.errors.length, 0);
});

test("raw selector use is counted and warned as abstraction health", () => {
  const bindings = Object.freeze({
    surface: "web",
    file: "raw.yaml",
    elements: Object.freeze({
      "button:place_order": Object.freeze({ css: "[data-legacy-submit]" }),
      "field:email": Object.freeze({ testId: "email-input" })
    }),
    screens: Object.freeze({}),
    states: Object.freeze({})
  });
  const result = lintBindings({
    refsUsed: ["button:place_order", "field:email"],
    bindingsBySurface: { web: bindings },
    surfaces: ["web"]
  });

  assert.equal(result.ok, true);
  assert.equal(result.coverage.web.rawCount, 1);
  assert(result.diagnostics.all.some((diagnostic) => diagnostic.code === "E_RAW_SELECTOR"));
});
