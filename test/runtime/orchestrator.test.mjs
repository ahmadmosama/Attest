import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { UnsupportedOpError } from "../../src/errors.mjs";
import { createBundle } from "../../src/evidence/bundle.mjs";
import { createExecutionPlan } from "../../src/lower/plan.mjs";
import { createRunContext } from "../../src/runtime/run-context.mjs";
import { runScenario } from "../../src/runtime/orchestrator.mjs";
import { createFakeSurface } from "../../src/surfaces/fake/adapter.mjs";
import { defineScript } from "../../src/surfaces/fake/script.mjs";

const RUN_ID = "20260815T044612Z-9f3a1c07";

function clock() {
  return new Date("2026-08-15T04:46:12.000Z");
}

async function withRuntimeTemp(prefix, fn) {
  const dir = await mkdtemp(path.join(process.cwd(), `test/runtime/${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function plan(overrides = {}) {
  return createExecutionPlan({
    scenarioId: overrides.scenarioId ?? "checkout.guest_purchase",
    surface: overrides.surface ?? "fake",
    app: "shopdemo",
    bindingsHash: "bindings-a",
    requirements: overrides.requirements ?? ["RUN-04"],
    capabilities: {
      demanded: overrides.demanded ?? [],
      satisfiedBy: { surface: ["raw_escape"], db: [] }
    },
    rawOpCount: overrides.rawOpCount ?? 0,
    ops: overrides.ops ?? [
      { i: 0, kind: "click" },
      { i: 1, kind: "checkpoint", label: "after click" }
    ]
  });
}

async function contextFor(root, executionPlan, timeouts = {}) {
  const bundle = await createBundle({ root, runId: RUN_ID });
  return createRunContext({
    runId: bundle.runId,
    scenarioId: executionPlan.scenarioId,
    surface: executionPlan.surface,
    bundle,
    timeouts,
    now: clock
  });
}

function countedAdapter(base) {
  let closes = 0;

  return {
    get closes() {
      return closes;
    },
    describeCapabilities: (...args) => base.describeCapabilities(...args),
    preflight: (...args) => base.preflight(...args),
    open: (...args) => base.open(...args),
    execute: (...args) => base.execute(...args),
    collectEvidence: (...args) => base.collectEvidence(...args),
    close(session, options) {
      closes += 1;
      return base.close(session, options);
    }
  };
}

test("runScenario writes plan.json before the first execute call", async () => {
  await withRuntimeTemp("plan-first", async (root) => {
    const executionPlan = plan();
    const base = createFakeSurface(defineScript({ surface: "fake" }));
    const adapter = {
      describeCapabilities: (...args) => base.describeCapabilities(...args),
      preflight: (...args) => base.preflight(...args),
      open(ctx) {
        return { inner: base.open(ctx), ctx };
      },
      async execute(session, op, options) {
        const planText = await readFile(path.join(session.ctx.bundle.dir, "plan.json"), "utf8");
        assert.equal(JSON.parse(planText).planHash, executionPlan.planHash);
        return base.execute(session.inner, op, options);
      },
      collectEvidence: (session, kind, options) =>
        base.collectEvidence(session.inner, kind, options),
      close: (session, options) => base.close(session?.inner ?? null, options)
    };
    const result = await runScenario({
      plan: executionPlan,
      adapter,
      ctx: await contextFor(root, executionPlan)
    });

    assert.equal(result.planPath, "scenarios/checkout.guest_purchase__fake/plan.json");
    assert.equal(result.result, "pass");
  });
});

test("passing ops return a pass with one duration per step", async () => {
  await withRuntimeTemp("pass", async (root) => {
    const executionPlan = plan();
    const result = await runScenario({
      plan: executionPlan,
      adapter: createFakeSurface(defineScript({ surface: "fake" })),
      ctx: await contextFor(root, executionPlan)
    });

    assert.equal(result.result, "pass");
    assert.equal(result.steps.length, 2);
    assert(result.steps.every((step) => step.status === "pass"));
    assert(result.steps.every((step) => Number.isInteger(step.durationMs)));
  });
});

test("a failing step stops the loop and skips later steps", async () => {
  await withRuntimeTemp("fail", async (root) => {
    const executionPlan = plan();
    const result = await runScenario({
      plan: executionPlan,
      adapter: createFakeSurface(
        defineScript({ surface: "fake", byIndex: { 0: { outcome: "fail" } } })
      ),
      ctx: await contextFor(root, executionPlan)
    });

    assert.equal(result.result, "fail");
    assert.equal(result.steps[0].status, "fail");
    assert.equal(result.steps[1].status, "skipped");
  });
});

test("unsupported ops are scenario failures with the adapter code recorded", async () => {
  await withRuntimeTemp("unsupported", async (root) => {
    const executionPlan = plan({
      demanded: ["file_upload"],
      ops: [{ i: 0, kind: "upload_file" }]
    });
    const result = await runScenario({
      plan: executionPlan,
      adapter: createFakeSurface(defineScript({ surface: "fake", supports: ["raw_escape"] })),
      ctx: await contextFor(root, executionPlan)
    });

    assert.equal(result.result, "fail");
    assert.equal(result.steps[0].status, "fail");
    assert.equal(result.steps[0].error.code, "E_UNSUPPORTED_OP");
    assert(result.steps[0].error.details.missing.includes("file_upload"));
  });
});

test("InfraError yields infra_error without marking a failed step", async () => {
  await withRuntimeTemp("infra", async (root) => {
    const executionPlan = plan();
    const adapter = countedAdapter(
      createFakeSurface(
        defineScript({ surface: "fake", byIndex: { 0: { outcome: "infra" } } })
      )
    );
    const result = await runScenario({
      plan: executionPlan,
      adapter,
      ctx: await contextFor(root, executionPlan)
    });

    assert.equal(result.result, "infra_error");
    assert.equal(result.error.code, "E_FAKE_INFRA");
    assert.equal(result.steps.some((step) => step.status === "fail"), false);
    assert.equal(adapter.closes, 1);
  });
});

test("a hung step times out under budget and still writes evidence", async () => {
  await withRuntimeTemp("hang", async (root) => {
    const executionPlan = plan({ ops: [{ i: 0, kind: "click" }] });
    const adapter = countedAdapter(
      createFakeSurface(
        defineScript({ surface: "fake", byIndex: { 0: { outcome: "hang" } } })
      )
    );
    const started = Date.now();
    const result = await runScenario({
      plan: executionPlan,
      adapter,
      ctx: await contextFor(root, executionPlan, { stepMs: 100, scenarioMs: 1000 })
    });

    assert(Date.now() - started < 2000);
    assert.equal(result.result, "fail");
    assert.equal(result.steps[0].status, "timed_out");
    assert.equal(result.steps[0].evidence.length, 1);
    assert.equal(adapter.closes, 1);
  });
});

test("a scenario timeout preempts individually bounded steps", async () => {
  await withRuntimeTemp("scenario-timeout", async (root) => {
    const executionPlan = plan({
      ops: [
        { i: 0, kind: "click" },
        { i: 1, kind: "click" },
        { i: 2, kind: "click" }
      ]
    });
    const adapter = countedAdapter({
      describeCapabilities: () => Object.freeze({ has: () => true }),
      preflight: () => Object.freeze({ ok: true }),
      open: () => Object.freeze({ id: "slow-session" }),
      async execute(_session, _op, { signal }) {
        await delay(40, undefined, { signal });
        return Object.freeze({ ok: true });
      },
      collectEvidence: (_session, kind, { bundle }) => bundle.writeTextArtifact(kind, "evidence"),
      close: () => Object.freeze({ ok: true })
    });
    const result = await runScenario({
      plan: executionPlan,
      adapter,
      ctx: await contextFor(root, executionPlan, { stepMs: 200, scenarioMs: 60 })
    });

    assert.equal(result.result, "fail");
    assert.equal(result.steps[0].status, "pass");
    assert.equal(result.steps[1].status, "timed_out");
    assert.equal(result.steps[1].error.details.kind, "scenario");
    assert.equal(result.steps[1].evidence.length, 1);
    assert.equal(result.steps[2].status, "skipped");
    assert.equal(adapter.closes, 1);
  });
});

test("close is called exactly once when execute throws an unsupported op directly", async () => {
  await withRuntimeTemp("close-unsupported", async (root) => {
    const executionPlan = plan({ ops: [{ i: 0, kind: "click" }] });
    const adapter = countedAdapter({
      describeCapabilities: () => Object.freeze({ has: () => true }),
      preflight: () => Object.freeze({ ok: true }),
      open: () => Object.freeze({ id: "session" }),
      execute: () => {
        throw new UnsupportedOpError("E_DIRECT_UNSUPPORTED", "unsupported");
      },
      collectEvidence: (_session, kind, { bundle }) => bundle.writeTextArtifact(kind, "evidence"),
      close: () => Object.freeze({ ok: true })
    });
    const result = await runScenario({
      plan: executionPlan,
      adapter,
      ctx: await contextFor(root, executionPlan)
    });

    assert.equal(result.result, "fail");
    assert.equal(result.steps[0].error.code, "E_DIRECT_UNSUPPORTED");
    assert.equal(adapter.closes, 1);
  });
});

test("raw ops are counted in the scenario entry", async () => {
  await withRuntimeTemp("raw", async (root) => {
    const executionPlan = plan({
      rawOpCount: 1,
      ops: [{ i: 0, kind: "raw", surface: "fake", reason: "captcha has no accessible handle" }]
    });
    const result = await runScenario({
      plan: executionPlan,
      adapter: createFakeSurface(defineScript({ surface: "fake" })),
      ctx: await contextFor(root, executionPlan)
    });

    assert.equal(result.result, "pass");
    assert.equal(result.rawOpUses, 1);
  });
});

test("db window ops pass through named hooks when present and pass without hooks", async () => {
  await withRuntimeTemp("db-window", async (root) => {
    const executionPlan = plan({
      ops: [
        { i: 0, kind: "db_window_open", seq: 1 },
        { i: 1, kind: "db_window_close", seq: 1 }
      ]
    });
    const calls = [];
    const bundle = await createBundle({ root, runId: RUN_ID });
    const ctx = createRunContext({
      runId: bundle.runId,
      scenarioId: executionPlan.scenarioId,
      surface: executionPlan.surface,
      bundle,
      now: clock,
      db: {
        onWindowOpen(op) {
          calls.push(op.kind);
        },
        onWindowClose(op) {
          calls.push(op.kind);
        }
      }
    });
    const result = await runScenario({
      plan: executionPlan,
      adapter: createFakeSurface(defineScript({ surface: "fake" })),
      ctx
    });

    assert.equal(result.result, "pass");
    assert.deepEqual(calls, ["db_window_open", "db_window_close"]);
    assert(result.steps.every((step) => step.status === "pass"));
  });
});

test("the orchestrator imports no concrete browser or device driver", async () => {
  const source = await readFile("src/runtime/orchestrator.mjs", "utf8");

  assert.equal(/from\s+["'](?:playwright|appium|adb|simctl)/.test(source), false);
  assert.equal(source.includes("playwright"), false);
  assert.equal(source.includes("appium"), false);
});
