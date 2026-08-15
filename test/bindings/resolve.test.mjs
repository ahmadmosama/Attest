import assert from "node:assert/strict";
import test from "node:test";

import { AttestError } from "../../src/errors.mjs";
import { loadBindings } from "../../src/bindings/load.mjs";
import { LOCATOR_STRATEGIES, resolveRef } from "../../src/bindings/resolve.mjs";

const FIXTURE_DIR = "test/fixtures/bindings";

test("locator strategies are frozen in priority order", () => {
  assert.deepEqual(LOCATOR_STRATEGIES, ["testId", "accessibilityId", "roleName", "raw"]);
  assert.throws(() => LOCATOR_STRATEGIES.push("text"));
});

test("portable testId beats role and name on web", async () => {
  const web = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" });
  const resolved = resolveRef(web, "field:email");

  assert.deepEqual(resolved.locator, { strategy: "testId", value: "email-input" });
  assert.equal(resolved.usedRaw, false);
});

test("same SemanticRef resolves on Android and iOS with no scenario edit", async () => {
  const android = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "android" });
  const ios = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "ios" });

  assert.deepEqual(resolveRef(android, "field:email").locator, {
    strategy: "accessibilityId",
    value: "email-input"
  });
  assert.deepEqual(resolveRef(ios, "field:email").locator, {
    strategy: "accessibilityId",
    value: "email-input"
  });
});

test("role plus name is used when no portable identifier exists", async () => {
  const web = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" });

  assert.deepEqual(resolveRef(web, "button:place_order").locator, {
    strategy: "roleName",
    role: "button",
    name: "Place order"
  });
});

test("nth and within ride alongside the winning primary locator", async () => {
  const web = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" });

  assert.deepEqual(resolveRef(web, "item:first_product").locator, {
    strategy: "roleName",
    role: "listitem",
    nth: 0,
    within: "testId:product-grid"
  });
});

test("raw selector only bindings resolve as raw and are flagged", () => {
  const bindings = Object.freeze({
    surface: "web",
    file: "raw.yaml",
    elements: Object.freeze({
      "button:place_order": Object.freeze({ css: "[data-legacy-submit]" })
    }),
    screens: Object.freeze({}),
    states: Object.freeze({})
  });
  const resolved = resolveRef(bindings, "button:place_order");

  assert.deepEqual(resolved.locator, {
    strategy: "raw",
    raw: { kind: "css", value: "[data-legacy-submit]" }
  });
  assert.equal(resolved.usedRaw, true);
});

test("unknown refs throw E_UNBOUND_REF naming ref surface and file", async () => {
  const web = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" });

  assert.throws(
    () => resolveRef(web, "button:missing"),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_UNBOUND_REF" &&
      error.message.includes("button:missing") &&
      error.message.includes("web") &&
      error.message.includes("web.yaml")
  );
});

test("screen refs resolve to navigation targets with ready locators", async () => {
  const web = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" });
  const android = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "android" });

  assert.deepEqual(resolveRef(web, "screen:catalog").locator, {
    strategy: "screen",
    path: "/",
    ready: { strategy: "roleName", role: "heading", name: "Catalog" }
  });
  assert.deepEqual(resolveRef(android, "screen:catalog").locator, {
    strategy: "screen",
    deeplink: "shopdemo://catalog",
    ready: { strategy: "accessibilityId", value: "catalog-root" }
  });
});

test("returned locators are frozen", async () => {
  const web = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" });
  const resolved = resolveRef(web, "field:email");

  assert.throws(() => {
    resolved.locator.value = "changed";
  });
});
