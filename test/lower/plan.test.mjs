import assert from "node:assert/strict";
import test from "node:test";

import { OPS } from "../../src/ir/ops.mjs";
import { CompileError, COMPILE_ERROR_CODES, SkipDecision } from "../../src/lower/errors.mjs";
import {
  PLAN_OP_KINDS,
  PLAN_VERSION,
  createExecutionPlan,
  hashPlan
} from "../../src/lower/plan.mjs";

function basePlan(overrides = {}) {
  return createExecutionPlan({
    scenarioId: "checkout.guest_purchase",
    surface: "web",
    app: "shopdemo",
    bindingsHash: "bindings-a",
    requirements: ["REQ-CHK-004"],
    capabilities: {
      demanded: ["file_upload"],
      satisfiedBy: { surface: ["file_upload"], db: ["db.delta_assertion"] }
    },
    rawOpCount: 0,
    ops: [
      {
        i: 0,
        kind: "navigate",
        target: { path: "/" },
        ready: { strategy: "roleName", role: "heading", name: "Catalog" }
      },
      {
        i: 1,
        kind: "click",
        locator: { strategy: "testId", value: "product-card", nth: 0 }
      }
    ],
    ...overrides
  });
}

test("PLAN_OP_KINDS covers every IR op exactly once", () => {
  assert.equal(PLAN_VERSION, 1);
  assert.deepEqual(Object.keys(PLAN_OP_KINDS).toSorted(), [...OPS].toSorted());
  assert.equal(PLAN_OP_KINDS.open, "navigate");
  assert.equal(PLAN_OP_KINDS.delta_window.open, "db_window_open");
  assert.equal(PLAN_OP_KINDS.delta_window.close, "db_window_close");
  assert.equal(PLAN_OP_KINDS.run_flow, null);
});

test("createExecutionPlan rejects non dense op indices", () => {
  assert.throws(
    () =>
      basePlan({
        ops: [
          { i: 0, kind: "back" },
          { i: 2, kind: "back" }
        ]
      }),
    /dense/
  );
});

test("createExecutionPlan rejects unresolved SemanticRef strings", () => {
  assert.throws(
    () =>
      basePlan({
        ops: [{ i: 0, kind: "click", locator: "button:place_order" }]
      }),
    /unresolved SemanticRef/
  );
});

test("hashPlan is stable under object key insertion order", () => {
  const first = basePlan();
  const second = createExecutionPlan({
    ops: [
      {
        kind: "navigate",
        ready: { name: "Catalog", role: "heading", strategy: "roleName" },
        target: { path: "/" },
        i: 0
      },
      {
        locator: { nth: 0, value: "product-card", strategy: "testId" },
        kind: "click",
        i: 1
      }
    ],
    rawOpCount: 0,
    capabilities: {
      satisfiedBy: { db: ["db.delta_assertion"], surface: ["file_upload"] },
      demanded: ["file_upload"]
    },
    requirements: ["REQ-CHK-004"],
    bindingsHash: "bindings-a",
    app: "shopdemo",
    surface: "web",
    scenarioId: "checkout.guest_purchase"
  });

  assert.equal(first.planHash, second.planHash);
  assert.equal(hashPlan(first), hashPlan(second));
});

test("hashPlan changes when locator, order, or binding hash changes", () => {
  const base = basePlan();
  const locatorChanged = basePlan({
    ops: [
      {
        i: 0,
        kind: "navigate",
        target: { path: "/catalog" },
        ready: { strategy: "roleName", role: "heading", name: "Catalog" }
      },
      { i: 1, kind: "click", locator: { strategy: "testId", value: "product-card", nth: 0 } }
    ]
  });
  const orderChanged = basePlan({
    ops: [
      { i: 0, kind: "click", locator: { strategy: "testId", value: "product-card", nth: 0 } },
      {
        i: 1,
        kind: "navigate",
        target: { path: "/" },
        ready: { strategy: "roleName", role: "heading", name: "Catalog" }
      }
    ]
  });
  const hashChanged = basePlan({ bindingsHash: "bindings-b" });

  assert.notEqual(base.planHash, locatorChanged.planHash);
  assert.notEqual(base.planHash, orderChanged.planHash);
  assert.notEqual(base.planHash, hashChanged.planHash);
});

test("hashPlan excludes planHash itself", () => {
  const plan = basePlan();
  assert.equal(hashPlan({ ...plan, planHash: "tampered" }), plan.planHash);
});

test("ExecutionPlan is frozen serializable data", () => {
  const plan = basePlan();

  assert.equal(Object.isFrozen(plan), true);
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
  assert.throws(() => {
    plan.ops[0].kind = "changed";
  });
});

test("CompileError carries named details and architecture style message", () => {
  assert(COMPILE_ERROR_CODES.includes("E_DELTA_UNSUPPORTED"));
  const error = new CompileError("E_DELTA_UNSUPPORTED", {
    scenarioId: "checkout.guest_purchase",
    surface: "web",
    stepIndex: 11,
    capabilities: ["db.delta_assertion"],
    driver: "bigquery",
    flag: "delta_assertion"
  });

  assert.equal(error.code, "E_DELTA_UNSUPPORTED");
  assert.equal(error.details.scenarioId, "checkout.guest_purchase");
  assert.equal(error.details.surface, "web");
  assert.equal(error.details.stepIndex, 11);
  assert.equal(
    error.message,
    "E_DELTA_UNSUPPORTED: driver 'bigquery' declares delta_assertion=false, scenario 'checkout.guest_purchase' step 11 requires it"
  );
});

test("SkipDecision requires a named missing capability", () => {
  assert.throws(
    () =>
      SkipDecision({
        scenarioId: "checkout.guest_purchase",
        surface: "web",
        reason: "capability_missing",
        capabilities: []
      }),
    /non empty array/
  );

  const skip = SkipDecision({
    scenarioId: "checkout.guest_purchase",
    surface: "web",
    reason: "capability_missing",
    capabilities: ["file_upload"]
  });
  assert.deepEqual(skip.capabilities, ["file_upload"]);
  assert.equal(Object.isFrozen(skip), true);
});
