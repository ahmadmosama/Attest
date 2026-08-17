import assert from "node:assert/strict";
import test from "node:test";

import { renderConsoleSummary } from "../../src/report/console.mjs";
import { createRunRecord } from "../../src/report/run-record.mjs";

const HASH = "c".repeat(64);
const ANSI_ESCAPE_PREFIX = String.fromCharCode(27, 91);

function scenario(overrides) {
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
    steps: [
      {
        index: 0,
        kind: "tap",
        status: "pass",
        durationMs: 20,
        error: null,
        evidence: []
      }
    ],
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
    unexplained: [],
    shortfalls: [],
    convergeMs: [12],
    quiet: { quiet: true, elapsedMs: 3, events: 0, extensions: 0 },
    quietPeriods: [{ quiet: true, elapsedMs: 3, events: 0, extensions: 0 }],
    rulesetHash: "d".repeat(64),
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
        id: "broad_rule",
        kind: "external_writer",
        entity: "public.jobs",
        suppressed: 4,
        overBudget: 2,
        cap: 2,
        dead: true,
        expired: true
      }
    ],
    capViolations: [{ code: "rule_too_broad", ruleId: "broad_rule", reason: "absolute", count: 4, cap: 2 }],
    health: {
      dead: [{ ruleId: "broad_rule", proposedAction: "delete_rule", consecutiveZeroRuns: 3 }],
      expired: [{ ruleId: "old_ignore", expires: "2026-08-15" }],
      expiringSoon: [{ ruleId: "soon_ignore", expires: "2026-08-20", daysUntilExpiry: 5 }]
    },
    ...overrides
  };
}

function baseInput(overrides = {}) {
  return {
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
    scenarios: [
      scenario({ id: "checkout.pass" }),
      scenario({
        id: "checkout.fail",
        result: "fail",
        steps: [
          {
            index: 1,
            kind: "tap",
            status: "fail",
            durationMs: 30,
            error: { code: "E_ASSERT", message: "missing", details: {} },
            evidence: []
          }
        ]
      }),
      scenario({
        id: "checkout.skip",
        result: "skipped",
        skipped: { capabilities: ["web.camera"] },
        steps: []
      }),
      scenario({
        id: "checkout.infra",
        result: "infra_error",
        error: { code: "E_DRIVER", message: "driver failed", details: {} },
        steps: []
      })
    ],
    ...overrides
  };
}

function record() {
  return createRunRecord(baseInput());
}

test("renderConsoleSummary prints a deterministic header and table without ANSI by default", () => {
  const summary = renderConsoleSummary(record(), { color: false, width: 80 });

  assert.match(summary, /^4 scenarios: 1 passed, 1 failed, 1 skipped, 1 infra/);
  assert.match(summary, /Scenario/);
  assert.match(summary, /checkout.fail/);
  assert.equal(summary.includes(ANSI_ESCAPE_PREFIX), false);
});

test("renderConsoleSummary is independent of TTY state", () => {
  const runRecord = record();

  assert.equal(
    renderConsoleSummary(runRecord, { color: false, width: 80 }),
    renderConsoleSummary(runRecord, { color: false, width: 80 })
  );
});

test("renderConsoleSummary prints raw escape hatch count and reasons", () => {
  const runRecord = createRunRecord({
    ...baseInput(),
    scenarios: [scenario({ rawOpUses: 1 })],
    escapeHatch: {
      rawOpUses: 1,
      uses: [
        {
          scenarioId: "checkout.guest_purchase",
          surface: "web",
          stepIndex: 2,
          reason: "captcha has no accessible handle"
        }
      ]
    }
  });
  const summary = renderConsoleSummary(runRecord, { color: false, width: 80 });

  assert.match(summary, /Raw escape hatch uses: 1/);
  assert.match(summary, /captcha has no accessible handle/);
});

test("renderConsoleSummary prints delta buckets, rule accounting, health flags, and ruleset hash", () => {
  const runRecord = createRunRecord({
    ...baseInput({
      hashes: { bindings: { web: HASH }, ruleset: null },
      scenarios: [scenario({ id: "checkout.delta", delta: delta() })]
    })
  });
  const summary = renderConsoleSummary(runRecord, { color: false, width: 80 });

  assert.match(summary, /expected 1, explained 1, suppressed external 1, unexplained 1/);
  assert.match(summary, /Delta rule suppressions/);
  assert.match(summary, /broad_rule \| external_writer \| public\.jobs \| 4 \| 2 \| 2 \| rule_too_broad, dead: delete_rule, expired/);
  assert.match(summary, /zero_rule \| ignore \| public\.zero \| 0 \| 0 \| 10 \| ok/);
  assert.match(summary, /Dead rule: broad_rule proposed delete_rule/);
  assert.match(summary, /Expired ignore: old_ignore expired 2026-08-15/);
  assert.match(summary, /Expiring ignore: soon_ignore expires 2026-08-20/);
  assert.match(summary, new RegExp(`Run ID: ${runRecord.runId} \\| Ruleset hash: ${"d".repeat(64)}`));
  assert.equal(summary.includes(ANSI_ESCAPE_PREFIX), false);
});

test("renderConsoleSummary keeps delta output valid with colour enabled", () => {
  const runRecord = createRunRecord({
    ...baseInput({
      scenarios: [scenario({ id: "checkout.delta", delta: delta() })]
    })
  });
  const summary = renderConsoleSummary(runRecord, { color: true, width: 80 });

  assert.match(summary, /expected 1, explained 1, suppressed external 1, unexplained 1/);
  assert.equal(summary.includes(ANSI_ESCAPE_PREFIX), true);
});
