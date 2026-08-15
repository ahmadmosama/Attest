import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { exitCodeFor } from "../../src/cli/exit-codes.mjs";
import { createBundle } from "../../src/evidence/bundle.mjs";
import { SkipDecision } from "../../src/lower/errors.mjs";
import { createExecutionPlan } from "../../src/lower/plan.mjs";
import { RunRecordSchema } from "../../src/report/run-record.mjs";
import { runSuite } from "../../src/runtime/suite.mjs";
import { createFakeSurface } from "../../src/surfaces/fake/adapter.mjs";
import { defineScript } from "../../src/surfaces/fake/script.mjs";

const START = new Date("2026-08-15T04:46:12.000Z");

function pinnedClock() {
  return START;
}

async function withRuntimeTemp(prefix, fn) {
  const dir = await mkdtemp(path.join(process.cwd(), `test/runtime/${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function plan(id, ops, overrides = {}) {
  return createExecutionPlan({
    scenarioId: id,
    surface: "fake",
    app: "shopdemo",
    bindingsHash: "bindings-a",
    requirements: overrides.requirements ?? ["RUN-04"],
    capabilities: {
      demanded: overrides.demanded ?? [],
      satisfiedBy: { surface: ["raw_escape"], db: [] }
    },
    rawOpCount: overrides.rawOpCount ?? ops.filter((op) => op.kind === "raw").length,
    ops
  });
}

function adapterFor(planEntry) {
  if (planEntry.scenarioId === "failing") {
    return createFakeSurface(
      defineScript({ surface: "fake", byIndex: { 0: { outcome: "fail" } } })
    );
  }

  if (planEntry.scenarioId === "hanging") {
    return createFakeSurface(
      defineScript({ surface: "fake", byIndex: { 0: { outcome: "hang" } } })
    );
  }

  return createFakeSurface(defineScript({ surface: "fake" }));
}

function stripTiming(record) {
  return {
    ...record,
    artifactDir: "<artifactDir>",
    durationMs: 0,
    scenarios: record.scenarios.map((scenario) => ({
      ...scenario,
      durationMs: 0,
      steps: scenario.steps.map((step) => ({ ...step, durationMs: 0 }))
    }))
  };
}

async function accessOk(filePath) {
  await access(filePath);
  return true;
}

test("runSuite records pass, fail, and hang counts and writes reports", async () => {
  await withRuntimeTemp("suite-counts", async (root) => {
    const bundle = await createBundle({ root, runId: "20260815T044612Z-11111111" });
    const plans = [
      plan("passing", [{ i: 0, kind: "click" }]),
      plan("failing", [{ i: 0, kind: "click" }]),
      plan("hanging", [{ i: 0, kind: "click" }])
    ];
    const { record } = await runSuite({
      plans,
      adapterFor,
      bundle,
      config: { timeouts: { stepMs: 50, scenarioMs: 500 } },
      now: pinnedClock
    });

    assert.deepEqual(record.counts, {
      total: 3,
      passed: 1,
      failed: 2,
      infra_error: 0,
      skipped: 0,
      quarantined: 0
    });
    assert.equal(record.exitCode, exitCodeFor({ counts: record.counts }));
    assert.equal(await accessOk(path.join(bundle.dir, "run.json")), true);
    assert.equal(await accessOk(path.join(bundle.dir, "junit.xml")), true);

    const manifest = JSON.parse(await readFile(path.join(bundle.dir, "manifest.json"), "utf8"));
    assert(manifest.some((entry) => entry.path === "run.json"));
    assert(manifest.some((entry) => entry.path === "junit.xml"));

    const runJson = JSON.parse(await readFile(path.join(bundle.dir, "run.json"), "utf8"));
    assert.deepEqual(RunRecordSchema.parse(runJson), runJson);
  });
});

test("skip decisions become visible skipped scenario entries", async () => {
  await withRuntimeTemp("suite-skip", async (root) => {
    const bundle = await createBundle({ root, runId: "20260815T044612Z-22222222" });
    const skip = SkipDecision({
      scenarioId: "camera_flow",
      surface: "fake",
      reason: "capability_missing",
      capabilities: ["file_upload"]
    });
    const { record } = await runSuite({
      plans: [],
      skips: [skip],
      adapterFor,
      bundle,
      config: {},
      now: pinnedClock
    });

    assert.equal(record.scenarios[0].result, "skipped");
    assert.deepEqual(record.scenarios[0].skipped.capabilities, ["file_upload"]);
  });
});

test("raw escape hatch uses are aggregated with their written reasons", async () => {
  await withRuntimeTemp("suite-raw", async (root) => {
    const bundle = await createBundle({ root, runId: "20260815T044612Z-33333333" });
    const plans = [
      plan(
        "raw_one",
        [{ i: 0, kind: "raw", surface: "fake", reason: "captcha has no accessible handle" }],
        { rawOpCount: 1 }
      ),
      plan(
        "raw_two",
        [{ i: 0, kind: "raw", surface: "fake", reason: "native picker needs raw input" }],
        { rawOpCount: 1 }
      )
    ];
    const { record } = await runSuite({
      plans,
      adapterFor,
      bundle,
      config: {},
      now: pinnedClock
    });

    assert.equal(record.escapeHatch.rawOpUses, 2);
    assert.deepEqual(
      record.escapeHatch.uses.map((use) => use.reason),
      ["captcha has no accessible handle", "native picker needs raw input"]
    );
  });
});

test("requirements covered is the sorted deduped union", async () => {
  await withRuntimeTemp("suite-req", async (root) => {
    const bundle = await createBundle({ root, runId: "20260815T044612Z-44444444" });
    const { record } = await runSuite({
      plans: [
        plan("one", [{ i: 0, kind: "click" }], { requirements: ["SCEN-05", "RUN-04"] }),
        plan("two", [{ i: 0, kind: "click" }], { requirements: ["RUN-06", "SCEN-05"] })
      ],
      adapterFor,
      bundle,
      config: {},
      now: pinnedClock
    });

    assert.deepEqual(record.requirements.covered, ["RUN-04", "RUN-06", "SCEN-05"]);
  });
});

test("same plans with a pinned clock are deterministic after timing fields are removed", async () => {
  const plans = [
    plan("passing", [{ i: 0, kind: "click" }]),
    plan("failing", [{ i: 0, kind: "click" }]),
    plan("hanging", [{ i: 0, kind: "click" }])
  ];

  await withRuntimeTemp("suite-stable-a", async (leftRoot) => {
    await withRuntimeTemp("suite-stable-b", async (rightRoot) => {
      const left = await runSuite({
        plans,
        adapterFor,
        bundle: await createBundle({ root: leftRoot, runId: "20260815T044612Z-55555555" }),
        config: { timeouts: { stepMs: 30, scenarioMs: 500 } },
        now: pinnedClock
      });
      const right = await runSuite({
        plans,
        adapterFor,
        bundle: await createBundle({ root: rightRoot, runId: "20260815T044612Z-55555555" }),
        config: { timeouts: { stepMs: 30, scenarioMs: 500 } },
        now: pinnedClock
      });

      assert.deepEqual(stripTiming(left.record), stripTiming(right.record));
    });
  });
});

test("one unexpected runner bug becomes infra_error and later scenarios still run", async () => {
  await withRuntimeTemp("suite-crash", async (root) => {
    const bundle = await createBundle({ root, runId: "20260815T044612Z-66666666" });
    const plans = [
      plan("before", [{ i: 0, kind: "click" }]),
      plan("crash", [{ i: 0, kind: "click" }]),
      plan("after", [{ i: 0, kind: "click" }])
    ];
    const { record } = await runSuite({
      plans,
      adapterFor(planEntry) {
        if (planEntry.scenarioId === "crash") {
          throw new TypeError("adapter factory crashed");
        }
        return createFakeSurface(defineScript({ surface: "fake" }));
      },
      bundle,
      config: {},
      now: pinnedClock
    });

    assert.deepEqual(
      record.scenarios.map((scenario) => [scenario.id, scenario.result, scenario.error?.code ?? null]),
      [
        ["before", "pass", null],
        ["crash", "infra_error", "E_UNEXPECTED"],
        ["after", "pass", null]
      ]
    );
  });
});

test("scenarios execute serially in phase 1", async () => {
  await withRuntimeTemp("suite-serial", async (root) => {
    const bundle = await createBundle({ root, runId: "20260815T044612Z-77777777" });
    const active = new Set();
    const overlaps = [];
    const order = [];
    const plans = [
      plan("one", [{ i: 0, kind: "click" }]),
      plan("two", [{ i: 0, kind: "click" }]),
      plan("three", [{ i: 0, kind: "click" }])
    ];

    await runSuite({
      plans,
      adapterFor(planEntry) {
        return {
          describeCapabilities: () => Object.freeze({ has: () => true }),
          preflight: () => Object.freeze({ ok: true }),
          open: () => Object.freeze({ id: planEntry.scenarioId }),
          async execute(session, op, { signal }) {
            active.add(session.id);
            overlaps.push(active.size);
            order.push(`${session.id}:${op.i}`);
            await delay(5, undefined, { signal });
            active.delete(session.id);
            return Object.freeze({ ok: true });
          },
          collectEvidence: (_session, kind, { bundle: evidenceBundle }) =>
            evidenceBundle.writeTextArtifact(kind, "evidence"),
          close: () => Object.freeze({ ok: true })
        };
      },
      bundle,
      config: {},
      now: pinnedClock
    });

    assert.deepEqual(order, ["one:0", "two:0", "three:0"]);
    assert.deepEqual(overlaps, [1, 1, 1]);
  });
});
