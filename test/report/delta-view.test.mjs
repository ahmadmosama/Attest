import assert from "node:assert/strict";
import test from "node:test";

import { buildDeltaView, formatBucketHeader, formatRuleTable } from "../../src/report/delta-view.mjs";
import { createRunRecord } from "../../src/report/run-record.mjs";

const HASH = "a".repeat(64);
const RULESET_HASH = "d".repeat(64);

function step(index, overrides = {}) {
  return {
    index,
    kind: "tap",
    status: "pass",
    durationMs: 10,
    error: null,
    evidence: [],
    ...overrides
  };
}

function delta(overrides = {}) {
  return {
    capturedEventCount: 4,
    counts: {
      expected: 1,
      explained: 1,
      suppressed_external: 1,
      unexplained: 1
    },
    unexplained: [
      {
        entity: "public.customers",
        op: "update",
        count: 1,
        rows: [
          {
            entity: "public.customers",
            op: "update",
            key: "{\"id\":1}",
            columns: ["email"],
            columnText: "email",
            notes: []
          }
        ],
        omitted: 0
      }
    ],
    shortfalls: [{ index: 0, entity: "public.orders", op: "insert", expected: 2, matched: 1, missing: 1 }],
    convergeMs: [14],
    quiet: { quiet: true, elapsedMs: 3, events: 0, extensions: 0 },
    quietPeriods: [{ quiet: true, elapsedMs: 3, events: 0, extensions: 0 }],
    rulesetHash: RULESET_HASH,
    rules: [
      {
        id: "zero_rule",
        kind: "ignore",
        entity: "public.zero",
        suppressed: 0,
        overBudget: 0,
        cap: 10,
        dead: false,
        expired: false
      },
      {
        id: "noisy_rule",
        kind: "external_writer",
        entity: "public.jobs",
        suppressed: 3,
        overBudget: 1,
        cap: 2,
        dead: false,
        expired: false
      }
    ],
    capViolations: [{ code: "rule_too_broad", ruleId: "noisy_rule", reason: "per_source", count: 3, cap: 2 }],
    health: {
      dead: [{ ruleId: "zero_rule", proposedAction: "delete_rule", consecutiveZeroRuns: 3 }],
      expired: [{ ruleId: "old_ignore", expires: "2026-08-15" }],
      expiringSoon: [{ ruleId: "soon_ignore", expires: "2026-08-20", daysUntilExpiry: 5 }]
    },
    ...overrides
  };
}

function scenario(overrides = {}) {
  return {
    id: "checkout.guest_purchase",
    surface: "web",
    result: "pass",
    durationMs: 20,
    requirements: ["RUN-04"],
    planHash: HASH,
    planPath: "scenarios/checkout.guest_purchase__web/plan.json",
    rawOpUses: 0,
    skipped: null,
    error: null,
    steps: [step(0)],
    ...overrides
  };
}

function record(overrides = {}) {
  return createRunRecord({
    runId: "20260815T044612Z-9f3a1c07",
    startedAt: "2026-08-15T04:46:12.000Z",
    finishedAt: "2026-08-15T04:46:13.000Z",
    durationMs: 1000,
    attestVersion: "0.1.0",
    node: { version: "v24.13.0", platform: "win32" },
    filters: { ids: [], tags: [], surfaces: [], headed: false, dryRun: false },
    artifactDir: "artifacts/20260815T044612Z-9f3a1c07",
    hashes: { bindings: { web: HASH }, ruleset: null },
    telemetry: { timeouts: 0, retries: 0, convergeMs: [] },
    scenarios: [scenario()],
    ...overrides
  });
}

test("formatBucketHeader renders the four buckets in fixed order", () => {
  assert.equal(
    formatBucketHeader({ unexplained: 4, expected: 1, suppressed_external: 3, explained: 2 }),
    "expected 1, explained 2, suppressed external 3, unexplained 4"
  );
  assert.equal(formatBucketHeader(), "expected 0, explained 0, suppressed external 0, unexplained 0");
});

test("buildDeltaView returns an absent frozen view when the record has no delta", () => {
  const view = buildDeltaView(record());

  assert.equal(view.present, false);
  assert.equal(Object.isFrozen(view), true);
  assert.deepEqual(view.scenarios, []);
});

test("buildDeltaView exposes suite counts, scenario groups, health, and ruleset hash", () => {
  const view = buildDeltaView(record({ scenarios: [scenario({ delta: delta() })] }));

  assert.equal(view.present, true);
  assert.equal(view.bucketHeader, "expected 1, explained 1, suppressed external 1, unexplained 1");
  assert.equal(view.rulesetHash, RULESET_HASH);
  assert.equal(view.scenarios[0].unexplained[0].rows[0].key, "{\"id\":1}");
  assert.equal(view.health.dead[0].ruleId, "zero_rule");
  assert.equal(view.health.expired[0].expires, "2026-08-15");
  assert.equal(Object.isFrozen(view.scenarios[0].unexplained[0].rows[0]), true);
});

test("formatRuleTable includes zero suppression rules and marks unhealthy rules", () => {
  const view = buildDeltaView(record({ scenarios: [scenario({ delta: delta() })] }));
  const table = formatRuleTable(view.rules);

  assert.match(table, /noisy_rule \| external_writer \| public\.jobs \| 3 \| 1 \| 2 \| rule_too_broad/);
  assert.match(table, /zero_rule \| ignore \| public\.zero \| 0 \| 0 \| 10 \| ok/);
  assert.equal(table.indexOf("noisy_rule") < table.indexOf("zero_rule"), true);
});
