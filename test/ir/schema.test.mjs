import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

import { OPS } from "../../src/ir/ops.mjs";
import { ScenarioSchema, StepSchema, toJsonSchema } from "../../src/ir/schema.mjs";

async function readScenarioFixture(name) {
  const text = await readFile(`test/fixtures/scenarios/${name}`, "utf8");
  return parse(text);
}

test("canonical checkout guest purchase fixture validates clean", async () => {
  const scenario = await readScenarioFixture("checkout_guest_purchase.attest.yaml");

  const parsed = ScenarioSchema.safeParse(scenario);

  assert.equal(parsed.success, true);
});

test("minimal and raw escape hatch fixtures validate clean", async () => {
  for (const fixture of ["minimal.attest.yaml", "raw_escape_hatch.attest.yaml"]) {
    const parsed = ScenarioSchema.safeParse(await readScenarioFixture(fixture));
    assert.equal(parsed.success, true, fixture);
  }
});

test("requirement IDs are mandatory and cannot be empty", async () => {
  const scenario = await readScenarioFixture("minimal.attest.yaml");
  delete scenario.requirement;

  const missing = ScenarioSchema.safeParse(scenario);
  assert.equal(missing.success, false);
  assert.deepEqual(missing.error.issues[0].path, ["requirement"]);

  const empty = ScenarioSchema.safeParse({ ...scenario, requirement: [] });
  assert.equal(empty.success, false);
  assert.deepEqual(empty.error.issues[0].path, ["requirement"]);
});

test("closed vocabulary rejects and names an unknown operation", () => {
  const parsed = StepSchema.safeParse({ sleep: 1000 });

  assert.equal(parsed.success, false);
  assert.match(parsed.error.issues[0].message, /sleep/);
  assert.equal(OPS.includes("sleep"), false);
});

test("raw requires a written reason", () => {
  const parsed = StepSchema.safeParse({
    raw: {
      web: {
        script: "document.body.click()"
      }
    }
  });

  assert.equal(parsed.success, false);
});

test("raw accepts per surface escape hatches with a reason", () => {
  const parsed = StepSchema.safeParse({
    raw: {
      reason: "captcha has no accessible handle",
      web: { script: "document.body.click()" },
      android: { uiautomator: "new UiSelector()" }
    }
  });

  assert.equal(parsed.success, true);
});

test("delta_window close preserves declared mutations and unexplained requirement", () => {
  const step = {
    delta_window: "close",
    expect_mutations: [{ entity: "orders", op: "insert", count: 1, where: { status: "paid" } }],
    require_no_unexplained: true
  };

  const parsed = StepSchema.safeParse(step);

  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data, step);
});

test("ignore suppressions require both reason and expires", async () => {
  const scenario = {
    ...(await readScenarioFixture("minimal.attest.yaml")),
    suppressions: [{ kind: "ignore", entity: "legacy_import_log" }]
  };

  const parsed = ScenarioSchema.safeParse(scenario);

  assert.equal(parsed.success, false);
  assert(parsed.error.issues.some((issue) => issue.path.join(".") === "suppressions.0.reason"));
  assert(parsed.error.issues.some((issue) => issue.path.join(".") === "suppressions.0.expires"));
});

test("SemanticRef valued fields reject selector shaped targets", () => {
  const parsed = StepSchema.safeParse({
    tap: "#submit"
  });

  assert.equal(parsed.success, false);
});

test("toJsonSchema emits draft 2020-12 from zod", () => {
  const jsonSchema = toJsonSchema();

  assert.equal(jsonSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(jsonSchema.type, "object");
  assert(jsonSchema.properties.steps);
});
