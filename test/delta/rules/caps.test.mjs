import assert from "node:assert/strict";
import test from "node:test";

import { CAP_DEFAULT, enforceCaps } from "../../../src/delta/rules/caps.mjs";

function stat(overrides = {}) {
  return {
    id: "derived_audit",
    kind: "derived",
    entity: "public.audit_log",
    suppressed: 0,
    overBudget: 0,
    cap: 50,
    ...overrides
  };
}

test("derived rule within observed source cardinality and cap passes", () => {
  assert.deepEqual(enforceCaps([stat({ suppressed: 2, cap: 2 })]), []);
});

test("a rule beyond absolute cap is reported as rule_too_broad", () => {
  const violations = enforceCaps([stat({ suppressed: 3, cap: 2 })]);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, "rule_too_broad");
  assert.equal(violations[0].reason, "absolute_cap");
  assert.equal(violations[0].ruleId, "derived_audit");
  assert.equal(violations[0].count, 3);
  assert.equal(violations[0].cap, 2);
});

test("default cap is fifty when a rule declares none", () => {
  const violations = enforceCaps([stat({ suppressed: CAP_DEFAULT + 1, cap: undefined })]);

  assert.equal(CAP_DEFAULT, 50);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].cap, 50);
});

test("ignore rules are capped like every other suppressing rule", () => {
  const violations = enforceCaps([
    stat({
      id: "temporary_ignore",
      kind: "ignore",
      suppressed: 4,
      cap: 3
    })
  ]);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].ruleId, "temporary_ignore");
});

test("volatile rules are never flagged because they suppress no whole event", () => {
  const violations = enforceCaps([
    stat({
      id: "volatile_dates",
      kind: "volatile_columns",
      suppressed: 999,
      cap: 1
    })
  ]);

  assert.deepEqual(violations, []);
});

test("cardinality and absolute cap violations accumulate", () => {
  const violations = enforceCaps([
    stat({ id: "too_many_audit", overBudget: 1, suppressed: 2, cap: 50 }),
    stat({ id: "too_many_jobs", kind: "external_writer", suppressed: 4, cap: 2 })
  ]);

  assert.deepEqual(
    violations.map((violation) => [violation.ruleId, violation.reason]),
    [
      ["too_many_audit", "declared_cardinality"],
      ["too_many_jobs", "absolute_cap"]
    ]
  );
});

test("zero rules produce zero violations", () => {
  assert.deepEqual(enforceCaps([]), []);
});
