import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadBindings } from "../../src/bindings/load.mjs";
import { compileScenarioFile } from "../../src/ir/compile.mjs";
import { defineDbCapabilities } from "../../src/capabilities/db-caps.mjs";
import { defineSurfaceCapabilities } from "../../src/capabilities/surface-caps.mjs";
import { lower } from "../../src/lower/lower.mjs";

const FIXTURE_DIR = "test/fixtures/bindings";
const SCENARIO_FILE = "test/fixtures/scenarios/checkout_guest_purchase.attest.yaml";
const SURFACES = Object.freeze(["web", "android", "ios"]);
const SUPPORTS = Object.freeze([
  "file_upload",
  "network_control",
  "app_lifecycle",
  "permission_control",
  "clipboard_control",
  "raw_escape"
]);

function dbCaps() {
  return defineDbCapabilities({
    driver: "postgres",
    capture: "logical_slot",
    deltaAssertion: true,
    boundedPolling: true,
    beforeImages: "full",
    ordering: true,
    txAttribution: true,
    watermarkFencing: "inline",
    transactionalTeardown: true
  });
}

function completeBindings(bindings) {
  const mobile = bindings.surface === "android" || bindings.surface === "ios";
  const extraElements = mobile
    ? {
        "button:add_to_cart": { accessibilityId: "add-to-cart-btn" },
        "field:card_number": { accessibilityId: "card-number-input" }
      }
    : {
        "button:add_to_cart": { role: "button", name: "Add to cart" },
        "field:card_number": { testId: "card-number-input" }
      };
  const extraScreens = mobile
    ? {
        "screen:product_detail": {
          deeplink: "shopdemo://product-detail",
          ready: { accessibilityId: "product-detail-root" }
        }
      }
    : {
        "screen:product_detail": { path: "/products/first", ready: { testId: "product-detail" } }
      };

  return Object.freeze({
    ...bindings,
    elements: Object.freeze({ ...bindings.elements, ...extraElements }),
    screens: Object.freeze({ ...bindings.screens, ...extraScreens }),
    states: Object.freeze({
      ...bindings.states,
      "state:order_confirmed": bindings.states?.["state:order_confirmed"] ?? {
        accessibilityId: "order-confirmation"
      }
    })
  });
}

async function lowerForSurface(ir, surface) {
  const bindings = completeBindings(await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface }));
  return lower(ir, {
    surface,
    bindings,
    surfaceCaps: defineSurfaceCapabilities({ surface, supports: [...SUPPORTS] }),
    dbCaps: dbCaps(),
    app: "shopdemo"
  });
}

function stripComments(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

test("one unchanged scenario lowers to web, Android, and iOS plans", async () => {
  const source = await readFile(SCENARIO_FILE, "utf8");
  const compiled = await compileScenarioFile(SCENARIO_FILE);
  assert.equal(compiled.diagnostics.ok, true);

  const results = Object.fromEntries(
    await Promise.all(SURFACES.map(async (surface) => [surface, await lowerForSurface(compiled.ir, surface)]))
  );
  for (const surface of SURFACES) {
    assert.equal(results[surface].kind, "plan");
  }

  const web = results.web.plan;
  const android = results.android.plan;
  const ios = results.ios.plan;
  const webKinds = web.ops.map((op) => op.kind);

  assert.deepEqual(android.ops.map((op) => op.kind), webKinds);
  assert.deepEqual(ios.ops.map((op) => op.kind), webKinds);
  assert.deepEqual(android.requirements, web.requirements);
  assert.deepEqual(ios.requirements, web.requirements);

  assert.deepEqual(web.ops[0].target, { path: "/" });
  assert.deepEqual(android.ops[0].target, { deeplink: "shopdemo://catalog" });
  assert.deepEqual(ios.ops[0].target, { deeplink: "shopdemo://catalog" });
  assert.equal(source.includes('path: "/"'), false);
  assert.equal(source.includes("shopdemo://catalog"), false);

  const uncommented = stripComments(source);
  assert.doesNotMatch(uncommented, /\bweb\b|\bandroid\b|\bios\b|http|#|\/\//);

  assert.notEqual(web.planHash, android.planHash);
  assert.notEqual(web.planHash, ios.planHash);
  assert.notEqual(android.planHash, ios.planHash);

  const repeat = await lowerForSurface(compiled.ir, "web");
  assert.equal(repeat.plan.planHash, web.planHash);
});
