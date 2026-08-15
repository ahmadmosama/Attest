import assert from "node:assert/strict";
import test from "node:test";

import { AttestError } from "../../src/errors.mjs";
import { hashBindings, loadBindings } from "../../src/bindings/load.mjs";
import { BindingsSchema, ElementBindingSchema } from "../../src/bindings/schema.mjs";

const FIXTURE_DIR = "test/fixtures/bindings";

test("architecture shopdemo web and android fixtures validate unchanged", async () => {
  const web = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" });
  const android = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "android" });

  assert.equal(web.surface, "web");
  assert.equal(android.surface, "android");
  assert.equal(web.elements["field:email"].testId, "email-input");
  assert.equal(android.elements["field:email"].accessibilityId, "email-input");
});

test("ios fixture validates with mobile deeplinks and accessibility identifiers", async () => {
  const ios = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "ios" });

  assert.equal(ios.surface, "ios");
  assert.equal(ios.screens["screen:checkout"].deeplink, "shopdemo://checkout");
  assert.equal(ios.states["state:order_confirmed"].accessibilityId, "order-confirmation");
});

test("coordinate binding fields are rejected with the named code", () => {
  for (const binding of [{ point: [100, 200] }, { x: 100, y: 200 }, { tapPoint: [1, 2] }]) {
    const parsed = ElementBindingSchema.safeParse(binding);

    assert.equal(parsed.success, false);
    assert(parsed.error.issues.some((issue) => issue.message.includes("E_COORDINATE_BINDING")));
    assert(parsed.error.issues.some((issue) => issue.message.includes("Anti Pattern 7")));
  }
});

test("element binding keys must be SemanticRefs", () => {
  const parsed = BindingsSchema.safeParse({
    surface: "web",
    elements: {
      emailInput: { testId: "email-input" }
    }
  });

  assert.equal(parsed.success, false);
  assert(parsed.error.issues.some((issue) => issue.message.includes('"emailInput"')));
});

test("surface must be web android or ios", () => {
  const parsed = BindingsSchema.safeParse({
    surface: "desktop",
    elements: {}
  });

  assert.equal(parsed.success, false);
});

test("screen bindings require the surface specific navigation target and ready condition", () => {
  assert.equal(
    BindingsSchema.safeParse({
      surface: "web",
      screens: {
        "screen:catalog": { path: "/", ready: { testId: "catalog-root" } }
      }
    }).success,
    true
  );
  assert.equal(
    BindingsSchema.safeParse({
      surface: "android",
      screens: {
        "screen:catalog": { deeplink: "shopdemo://catalog", ready: { accessibilityId: "catalog-root" } }
      }
    }).success,
    true
  );
  assert.equal(
    BindingsSchema.safeParse({
      surface: "ios",
      screens: {
        "screen:catalog": { deeplink: "shopdemo://catalog" }
      }
    }).success,
    false
  );
});

test("nth and within cannot be used without a primary locator", () => {
  const parsed = ElementBindingSchema.safeParse({ nth: 0, within: "testId:grid" });

  assert.equal(parsed.success, false);
  assert(parsed.error.issues.some((issue) => issue.message.includes("disambiguators")));
});

test("hashBindings is stable and independent of insertion order", async () => {
  const first = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" });
  const second = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" });
  const reordered = {
    states: first.states,
    screens: first.screens,
    elements: first.elements,
    surface: first.surface
  };

  assert.equal(first.hash, second.hash);
  assert.equal(hashBindings(first), first.hash);
  assert.equal(hashBindings(reordered), first.hash);
  assert.notEqual(
    hashBindings({
      surface: first.surface,
      elements: {
        ...first.elements,
        "field:email": { ...first.elements["field:email"], testId: "changed" }
      },
      screens: first.screens,
      states: first.states
    }),
    first.hash
  );
});

test("loadBindings freezes returned bindings", async () => {
  const bindings = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" });

  assert.throws(() => {
    bindings.elements["field:email"].testId = "changed";
  });
});

test("loadBindings on a missing file throws E_BINDINGS_NOT_FOUND with the expected path", async () => {
  await assert.rejects(
    () => loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "missing" }),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_BINDINGS_NOT_FOUND" &&
      error.message.includes("test") &&
      error.message.includes("missing.yaml")
  );
});
