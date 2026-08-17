import assert from "node:assert/strict";
import test from "node:test";

import { exitCodeFor } from "../../src/cli/exit-codes.mjs";
import { AttestError, InfraError } from "../../src/errors.mjs";
import {
  createRunRecord,
  RUN_RECORD_VERSION,
  RunRecordSchema
} from "../../src/report/run-record.mjs";

const HASH = "a".repeat(64);

function artifact(path) {
  return Object.freeze({
    kind: "txt",
    path,
    bytes: 3,
    sha256: HASH
  });
}

function error(code = "E_STEP_FAILED") {
  return Object.freeze({
    code,
    message: "step failed",
    details: {}
  });
}

function step(index, status = "pass", stepError = null) {
  return Object.freeze({
    index,
    kind: "tap",
    status,
    durationMs: 10,
    error: stepError,
    evidence: [artifact(`scenarios/example/steps/${index}.txt`)]
  });
}

function scenario(overrides = {}) {
  return {
    id: "checkout.guest_purchase",
    surface: "web",
    result: "pass",
    startedAt: "2026-08-15T04:46:12.100Z",
    finishedAt: "2026-08-15T04:46:12.112Z",
    durationMs: 12,
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

function delta(overrides = {}) {
  return {
    capturedEventCount: 2,
    counts: {
      expected: 1,
      explained: 0,
      suppressed_external: 0,
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
    rulesetHash: "d".repeat(64),
    rules: [
      {
        id: "ignore_jobs",
        kind: "ignore",
        entity: "public.jobs",
        suppressed: 1,
        overBudget: 0,
        cap: 50,
        dead: false,
        expired: false
      }
    ],
    capViolations: [],
    health: { dead: [], expired: [], expiringSoon: [] },
    ...overrides
  };
}

function input(overrides = {}) {
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
    scenarios: [scenario()],
    ...overrides
  };
}

test("createRunRecord validates and freezes a well formed record", () => {
  const record = createRunRecord(input());

  assert.equal(record.runRecordVersion, RUN_RECORD_VERSION);
  assert.equal(record.runRecordVersion, 2);
  assert.equal(record.scenarios[0].startedAt, "2026-08-15T04:46:12.100Z");
  assert.equal(record.scenarios[0].finishedAt, "2026-08-15T04:46:12.112Z");
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.scenarios[0]), true);
  assert.throws(() => {
    record.counts.total = 100;
  });
});

test("createRunRecord backfills missing scenario timing from the run timing", () => {
  const legacyScenario = scenario();
  delete legacyScenario.startedAt;
  delete legacyScenario.finishedAt;

  const record = createRunRecord(input({ scenarios: [legacyScenario] }));

  assert.equal(record.scenarios[0].startedAt, "2026-08-15T04:46:12.000Z");
  assert.equal(record.scenarios[0].finishedAt, "2026-08-15T04:46:13.000Z");
});

test("createRunRecord rejects caller counts missing skipped", () => {
  assert.throws(
    () => createRunRecord(input({ counts: { total: 1, passed: 1, failed: 0, infra_error: 0 } })),
    (err) => err instanceof AttestError && err.code === "E_RUN_RECORD_INVALID"
  );
});

test("status is derived from scenario results", () => {
  const failed = createRunRecord(input({ scenarios: [scenario({ result: "fail", steps: [step(0, "fail", error())] })] }));
  const infra = createRunRecord(
    input({ scenarios: [scenario({ result: "infra_error", error: error("E_DRIVER"), steps: [] })] })
  );

  assert.equal(failed.status, "fail");
  assert.equal(infra.status, "infra_error");
});

test("exitCode matches the phase 01 exit contract", () => {
  const record = createRunRecord(input({ scenarios: [scenario({ result: "skipped", skipped: { capabilities: ["web.camera"] } })] }));

  assert.equal(record.exitCode, exitCodeFor({ counts: record.counts }));
});

test("raw escape hatch uses are counted and carry written reasons", () => {
  const record = createRunRecord(
    input({
      scenarios: [scenario({ rawOpUses: 2 })],
      escapeHatch: {
        rawOpUses: 2,
        uses: [
          {
            scenarioId: "checkout.guest_purchase",
            surface: "web",
            stepIndex: 3,
            reason: "captcha has no accessible handle"
          },
          {
            scenarioId: "checkout.guest_purchase",
            surface: "web",
            stepIndex: 4,
            reason: "native picker has no semantic binding yet"
          }
        ]
      }
    })
  );

  assert.equal(record.escapeHatch.rawOpUses, 2);
  assert.deepEqual(
    record.escapeHatch.uses.map((use) => use.reason),
    ["captcha has no accessible handle", "native picker has no semantic binding yet"]
  );
});

test("requirements.covered is the sorted deduped union of scenario requirements", () => {
  const record = createRunRecord(
    input({
      scenarios: [
        scenario({ id: "checkout.guest_purchase", requirements: ["RUN-04", "SCEN-05"] }),
        scenario({ id: "checkout.returning_purchase", requirements: ["SCEN-05", "RUN-06"] })
      ]
    })
  );

  assert.deepEqual(record.requirements.covered, ["RUN-04", "RUN-06", "SCEN-05"]);
});

test("skipped scenarios require missing capabilities", () => {
  assert.throws(
    () => createRunRecord(input({ scenarios: [scenario({ result: "skipped", skipped: null })] })),
    (err) => err instanceof AttestError && err.code === "E_RUN_RECORD_INVALID"
  );
});

test("infra_error scenarios carry error codes and cannot claim failed steps", () => {
  assert.throws(
    () =>
      createRunRecord(
        input({
          scenarios: [
            scenario({
              result: "infra_error",
              error: error("E_DRIVER"),
              steps: [step(0, "fail", error())]
            })
          ]
        })
      ),
    (err) => err instanceof AttestError && err.code === "E_RUN_RECORD_INVALID"
  );
});

test("run record is pure JSON data and schema round trips unchanged", () => {
  const record = createRunRecord(input());

  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  assert.deepEqual(RunRecordSchema.parse(record), record);
});

test("version 2 derives scenario delta, suite totals, ruleset hash, and converge telemetry", () => {
  const record = createRunRecord(
    input({
      hashes: { bindings: { web: HASH }, ruleset: null },
      scenarios: [scenario({ delta: delta(), steps: [step(0, "pass")] })]
    })
  );

  assert.equal(record.runRecordVersion, 2);
  assert.deepEqual(record.delta.counts, {
    expected: 1,
    explained: 0,
    suppressed_external: 0,
    unexplained: 1
  });
  assert.equal(record.delta.rules[0].id, "ignore_jobs");
  assert.equal(record.hashes.ruleset, "d".repeat(64));
  assert.deepEqual(record.telemetry.convergeMs, [14]);
  assert.equal(record.scenarios[0].delta.unexplained[0].entity, "public.customers");
});

test("schema refuses delta counts that do not sum to captured events", () => {
  assert.throws(
    () =>
      createRunRecord(
        input({
          scenarios: [
            scenario({
              delta: delta({
                capturedEventCount: 3
              }),
              steps: [step(0, "pass")]
            })
          ]
        })
      ),
    (err) => err instanceof AttestError && err.code === "E_RUN_RECORD_INVALID"
  );
});

test("infra error details do not introduce connection strings into the record", () => {
  const infra = new InfraError("E_DB_CONNECT", "database connection failed", {
    reason: "connection_refused"
  });
  const record = createRunRecord(
    input({
      scenarios: [
        scenario({
          result: "infra_error",
          error: infra.toJSON(),
          steps: []
        })
      ]
    })
  );

  assert.equal(JSON.stringify(record).includes("postgres://"), false);
});
