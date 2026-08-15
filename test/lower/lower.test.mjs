import assert from "node:assert/strict";
import test from "node:test";

import { loadBindings } from "../../src/bindings/load.mjs";
import { compileScenarioFile, compileScenarioText } from "../../src/ir/compile.mjs";
import { defineDbCapabilities } from "../../src/capabilities/db-caps.mjs";
import { defineSurfaceCapabilities } from "../../src/capabilities/surface-caps.mjs";
import { lower } from "../../src/lower/lower.mjs";

const FIXTURE_DIR = "test/fixtures/bindings";
const CANONICAL_FIXTURE = "test/fixtures/scenarios/checkout_guest_purchase.attest.yaml";
const SURFACE_SUPPORTS = Object.freeze([
  "file_upload",
  "network_control",
  "app_lifecycle",
  "permission_control",
  "clipboard_control",
  "raw_escape"
]);

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

function surfaceCaps(surface, supports = SURFACE_SUPPORTS) {
  return defineSurfaceCapabilities({ surface, supports: [...supports] });
}

function dbCaps(overrides = {}) {
  return defineDbCapabilities({
    driver: "postgres",
    capture: "logical_slot",
    deltaAssertion: true,
    boundedPolling: true,
    beforeImages: "full",
    ordering: true,
    txAttribution: true,
    watermarkFencing: "inline",
    transactionalTeardown: true,
    ...overrides
  });
}

async function canonicalPlan(surface = "web") {
  const compiled = await compileScenarioFile(CANONICAL_FIXTURE);
  assert.equal(compiled.diagnostics.ok, true);
  const bindings = completeBindings(await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface }));

  return lower(compiled.ir, {
    surface,
    bindings,
    surfaceCaps: surfaceCaps(surface),
    dbCaps: dbCaps(),
    app: "shopdemo"
  });
}

function compileText(text) {
  const result = compileScenarioText(text, { file: "inline.attest.yaml" });
  assert.equal(result.diagnostics.ok, true);
  return result.ir;
}

test("canonical scenario lowers to a fully resolved web plan with expected op shapes", async () => {
  const result = await canonicalPlan("web");

  assert.equal(result.kind, "plan");
  assert.deepEqual(result.plan.ops[0], {
    i: 0,
    kind: "navigate",
    target: { path: "/" },
    ready: { strategy: "roleName", role: "heading", name: "Catalog" }
  });
  assert.equal(result.plan.ops[1].kind, "click");
  assert.deepEqual(result.plan.ops[1].locator, {
    strategy: "roleName",
    role: "listitem",
    nth: 0,
    within: "testId:product-grid"
  });
  assert.deepEqual(result.plan.ops[9], {
    i: 9,
    kind: "db_window_open",
    fence: "attest_watermark",
    scenarioId: "checkout.guest_purchase",
    seq: 1
  });
  assert.equal(result.plan.ops[10].kind, "click");
  assert.deepEqual(result.plan.ops[10].locator, {
    strategy: "roleName",
    role: "button",
    name: "Place order"
  });
  assert.equal(result.plan.ops[12].kind, "db_window_close");
  assert.equal(result.plan.ops[12].expect.length, 3);
  assert.equal(result.plan.ops[12].requireNoUnexplained, true);
  assert.equal(result.plan.rawOpCount, 0);
});

test("screen open resolves to path on web and deeplink on Android", async () => {
  const web = await canonicalPlan("web");
  const android = await canonicalPlan("android");

  assert.deepEqual(web.plan.ops[0].target, { path: "/" });
  assert.deepEqual(android.plan.ops[0].target, { deeplink: "shopdemo://catalog" });
});

test("run_flow inlines referenced flow ops with dense indices", async () => {
  const main = compileText(`
id: checkout.main
requirement: [REQ-CHK-001]
steps:
  - open: screen:catalog
  - run_flow: checkout.child
  - back: true
`);
  const child = compileText(`
id: checkout.child
requirement: [REQ-CHK-002]
steps:
  - tap: button:place_order
  - expect_visible: state:order_confirmed
`);
  const bindings = completeBindings(await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" }));
  const result = lower(main, {
    surface: "web",
    bindings,
    surfaceCaps: surfaceCaps("web"),
    dbCaps: dbCaps(),
    flows: new Map([[child.id, child]]),
    app: "shopdemo"
  });

  assert.equal(result.kind, "plan");
  assert.deepEqual(
    result.plan.ops.map((op) => [op.i, op.kind]),
    [
      [0, "navigate"],
      [1, "click"],
      [2, "expect_visible"],
      [3, "back"]
    ]
  );
});

test("run_flow reports missing, cycle, and depth errors", async () => {
  const bindings = completeBindings(await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" }));
  const ctx = {
    surface: "web",
    bindings,
    surfaceCaps: surfaceCaps("web"),
    dbCaps: dbCaps(),
    app: "shopdemo"
  };
  const missing = compileText(`
id: checkout.main
requirement: [REQ-CHK-001]
steps:
  - run_flow: checkout.missing
`);
  const a = compileText(`
id: checkout.a
requirement: [REQ-CHK-001]
steps:
  - run_flow: checkout.b
`);
  const b = compileText(`
id: checkout.b
requirement: [REQ-CHK-002]
steps:
  - run_flow: checkout.a
`);
  const depthFlows = new Map();
  const chain = ["checkout.f1", "checkout.f2", "checkout.f3", "checkout.f4", "checkout.f5", "checkout.f6"];
  const depthRoot = compileText(`
id: checkout.depth
requirement: [REQ-CHK-001]
steps:
  - run_flow: checkout.f1
`);
  chain.forEach((id, index) => {
    const next = chain[index + 1];
    depthFlows.set(
      id,
      compileText(`
id: ${id}
requirement: [REQ-CHK-001]
steps:
  - ${next === undefined ? "back: true" : `run_flow: ${next}`}
`)
    );
  });

  assert.equal(lower(missing, ctx).error.code, "E_FLOW_NOT_FOUND");
  assert.equal(lower(a, { ...ctx, flows: new Map([[a.id, a], [b.id, b]]) }).error.code, "E_FLOW_CYCLE");
  assert.equal(lower(depthRoot, { ...ctx, flows: depthFlows }).error.code, "E_FLOW_DEPTH");
});

test("raw missing for target surface is an explicit skip", async () => {
  const compiled = await compileScenarioFile("test/fixtures/scenarios/raw_escape_hatch.attest.yaml");
  const bindings = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "ios" });
  const result = lower(compiled.ir, {
    surface: "ios",
    bindings,
    surfaceCaps: surfaceCaps("ios"),
    dbCaps: dbCaps(),
    app: "shopdemo"
  });

  assert.equal(result.kind, "skip");
  assert.equal(result.skip.reason, "raw_missing_for_surface");
  assert.deepEqual(result.skip.capabilities, ["raw_escape"]);
});

test("same lowerer inputs produce the same planHash", async () => {
  const first = await canonicalPlan("web");
  const second = await canonicalPlan("web");

  assert.equal(first.plan.planHash, second.plan.planHash);
});
