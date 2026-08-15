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
