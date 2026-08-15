import assert from "node:assert/strict";
import test from "node:test";

import { parseScenarioFile } from "../../src/ir/parse.mjs";
import { validateScenario } from "../../src/ir/validate.mjs";

const CANONICAL_FIXTURE = "test/fixtures/scenarios/checkout_guest_purchase.attest.yaml";

async function validateFixture(path) {
  const parsed = await parseScenarioFile(path);
  return validateScenario(parsed.ast);
}

test("canonical fixture validates into source ordered Scenario IR", async () => {
  const { ast } = await parseScenarioFile(CANONICAL_FIXTURE);
  const result = validateScenario(ast);

  assert.equal(result.diagnostics.ok, true);
  assert.equal(result.ir.irVersion, 1);
  assert.equal(result.ir.steps.length, ast.value.steps.length);
  assert.deepEqual(
    result.ir.steps.map((step) => step.index),
    ast.value.steps.map((_step, index) => index)
  );
  assert.deepEqual(result.ir.requirements, ast.value.requirement);
});

test("canonical fixture refs are sorted, deduped, and derived from SemanticRefs", async () => {
  const result = await validateFixture(CANONICAL_FIXTURE);

  assert.deepEqual(result.ir.refs, [
    "badge:cart_count",
    "button:add_to_cart",
    "button:place_order",
    "field:card_number",
    "field:email",
    "item:first_product",
    "screen:catalog",
    "screen:checkout",
    "screen:product_detail",
    "state:order_confirmed"
  ]);
});

test("canonical fixture capabilities include scenario and per step demands", async () => {
  const result = await validateFixture(CANONICAL_FIXTURE);

  assert.deepEqual(result.ir.capabilities, [
    "db.bounded_polling",
    "db.delta_assertion",
    "file_upload"
  ]);
});

test("raw uses carry step index, reason, and declared surfaces", async () => {
  const result = await validateFixture("test/fixtures/scenarios/raw_escape_hatch.attest.yaml");

  assert.equal(result.diagnostics.ok, true);
  assert.deepEqual(result.ir.rawUses, [
    {
      stepIndex: 0,
      reason: "captcha has no accessible handle",
      surfaces: ["android", "web"]
    }
  ]);
});

test("deepFreeze prevents mutation of nested arrays and objects", async () => {
  const result = await validateFixture(CANONICAL_FIXTURE);

  assert.throws(() => {
    result.ir.steps[0].op = "tap";
  });
  assert.throws(() => {
    result.ir.steps.push({});
  });
});

test("ban diagnostics suppress IR construction", async () => {
  const result = await validateFixture("test/fixtures/scenarios/invalid/sleep_step.attest.yaml");

  assert.equal(result.ir, null);
  assert.equal(result.diagnostics.errors[0].code, "E_BANNED_SLEEP");
});

test("two validations of the same file are structurally identical", async () => {
  const first = await validateFixture(CANONICAL_FIXTURE);
  const second = await validateFixture(CANONICAL_FIXTURE);

  assert.deepEqual(first.ir, second.ir);
});

test("cross step diagnostics catch whole scenario errors", async () => {
  const parsed = await parseScenarioFile(CANONICAL_FIXTURE);
  const ast = {
    ...parsed.ast,
    value: {
      ...parsed.ast.value,
      steps: [
        { delta_window: "close" },
        { checkpoint: "again" },
        { checkpoint: "again" },
        { run_flow: parsed.ast.value.id }
      ]
    },
    positionOf: parsed.ast.positionOf
  };
  const result = validateScenario(ast);
  const codes = result.diagnostics.errors.map((diagnostic) => diagnostic.code);

  assert.equal(result.ir, null);
  assert(codes.includes("E_UNBALANCED_DELTA_WINDOW"));
  assert(codes.includes("E_DUPLICATE_CHECKPOINT"));
  assert(codes.includes("E_FLOW_SELF_REFERENCE"));
});
