import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import { STAGE_NAME, VERIFY_REPORT, createAttestStage } from "../../src/integrate/atoz-stage.mjs";
import { renderVerdict, validatePhase } from "../../src/integrate/validate-phase.mjs";

function record(overrides = {}) {
  return {
    runId: "20260817T000000Z-07030000",
    artifactDir: ".attest/runs/20260817T000000Z-07030000",
    exitCode: 0,
    counts: { passed: 2, failed: 0, skipped: 0, infra_error: 0 },
    requirements: { covered: ["INTEG-01"] },
    scenarios: [
      { id: "checkout.guest", surface: "web", result: "passed", steps: [] },
      { id: "checkout.card", surface: "web", result: "passed", steps: [] }
    ],
    ...overrides
  };
}

function stageWith(runRecord) {
  return createAttestStage({ runAttest: async () => ({ record: runRecord }) });
}

describe("the AtoZ stage", () => {
  test("conforms to the stage contract without importing anything from AtoZ", async () => {
    const stage = stageWith(record());

    // Name, inputs, applicable, outputSchema, run: the shape AtoZ's registry
    // and stage-runner expect. A shape, not a dependency: two mature projects
    // that import each other are one project with a longer build.
    assert.equal(stage.name, STAGE_NAME);
    assert.deepEqual(stage.inputs, ["build"]);
    assert.equal(typeof stage.applicable, "function");
    assert.equal(typeof stage.outputSchema.parse, "function");

    // The third run() argument is the injection seam, matching the deploy.mjs
    // and sast.mjs precedent. Proven by using it rather than by counting
    // parameters, which default values make meaningless.
    const injected = await createAttestStage({}).run({}, {}, { runAttest: async () => ({ record: record() }) });
    assert.equal(injected.status, "passed");

    const source = await readFile("src/integrate/atoz-stage.mjs", "utf8");
    assert.doesNotMatch(source, /A to Z Deployment/u);
    assert.doesNotMatch(source, /\.\.\/\.\.\/\.\.\//u);
  });

  test("a passing run returns a report that validates against the declared schema", async () => {
    const report = await stageWith(record()).run({});

    assert.equal(report.status, "passed");
    assert.equal(report.counts.failed, 0);
    assert.doesNotThrow(() => VERIFY_REPORT.parse(report));
  });

  test("a failing run blocks the pipeline, and names the scenarios", async () => {
    const failing = record({
      exitCode: 1,
      counts: { passed: 1, failed: 1, skipped: 0, infra_error: 0 },
      scenarios: [
        { id: "checkout.guest", surface: "web", result: "passed", steps: [] },
        {
          id: "checkout.card",
          surface: "web",
          result: "failed",
          error: { code: "E_DELTA_MISSING_MUTATION", message: "orders insert count 1, observed 0" },
          steps: []
        }
      ]
    });

    // Blocking is the point. A verification stage that reports and lets the
    // pipeline continue is a dashboard.
    await assert.rejects(() => stageWith(failing).run({}), (error) => {
      assert.equal(error.name, "BlockerError");
      assert.equal(error.kind, "verify_failed");
      assert.match(error.message, /1 scenario/u);
      assert.deepEqual(
        error.details.report.failures.map((failure) => failure.scenarioId),
        ["checkout.card"]
      );
      return true;
    });
  });

  test("an infrastructure error blocks with a different kind from a scenario failure", async () => {
    const infra = record({
      counts: { passed: 0, failed: 0, skipped: 0, infra_error: 1 },
      scenarios: [
        {
          id: "checkout.guest",
          surface: "android",
          result: "infra_error",
          error: { code: "E_EMULATOR_BOOT_FAILED", message: "emulator did not become ready" },
          steps: []
        }
      ]
    });

    // "The emulator did not boot" and "the app is wrong" call for different
    // actions from whoever is paged, so the distinction survives all the way to
    // the pipeline.
    await assert.rejects(() => stageWith(infra).run({}), (error) => {
      assert.equal(error.kind, "verify_infra");
      assert.equal(error.details.report.status, "infra_error");
      return true;
    });
  });

  test("a run with no readable record blocks rather than passing", async () => {
    const stage = createAttestStage({
      runAttest: async () => ({ artifactRoot: path.join("does", "not", "exist"), runId: "nope" })
    });

    await assert.rejects(() => stage.run({}), (error) => {
      assert.equal(error.name, "BlockerError");
      assert.equal(error.kind, "verify_no_run_record");
      return true;
    });
  });

  test("a stage with no runner wired in blocks by name", async () => {
    await assert.rejects(() => createAttestStage({}).run({}), { kind: "verify_not_configured" });
  });
});

describe("the GSD validate hook", () => {
  const REQUIREMENTS = ["INTEG-01", "INTEG-02"];

  function scenariosFor(results) {
    return async () => results;
  }

  test("a phase whose scenarios all pass is verified", async () => {
    const verdict = await validatePhase({
      phase: "7",
      requirements: REQUIREMENTS,
      runScenarios: scenariosFor([
        { id: "a", surface: "web", result: "passed", requirements: ["INTEG-01"], steps: [] },
        { id: "b", surface: "web", result: "passed", requirements: ["INTEG-02"], steps: [] }
      ])
    });

    assert.equal(verdict.verified, true);
    assert.match(renderVerdict(verdict), /verified: 2 requirement/u);
  });

  test("a requirement with no covering scenario makes the phase unverified, by name", async () => {
    // The half that matters. If the hook only reported on the scenarios that
    // exist, a phase with none would sail through and the hook would lend it
    // authority it had not earned.
    const verdict = await validatePhase({
      phase: "7",
      requirements: REQUIREMENTS,
      runScenarios: scenariosFor([
        { id: "a", surface: "web", result: "passed", requirements: ["INTEG-01"], steps: [] }
      ])
    });

    assert.equal(verdict.verified, false);
    assert.deepEqual(verdict.uncovered, ["INTEG-02"]);
    assert.equal(verdict.reason, "uncovered_requirements");
    assert.match(renderVerdict(verdict), /uncovered INTEG-02: no scenario covers this requirement/u);
  });

  test("a failing scenario makes the phase unverified, and names the scenario and step", async () => {
    const verdict = await validatePhase({
      phase: "7",
      requirements: ["INTEG-01"],
      runScenarios: scenariosFor([
        {
          id: "checkout.card",
          surface: "android",
          result: "failed",
          requirements: ["INTEG-01"],
          error: { code: "E_ANDROID_NOT_FOUND" },
          steps: [
            { index: 0, status: "passed" },
            { index: 3, status: "failed" }
          ]
        }
      ])
    });

    assert.equal(verdict.verified, false);
    assert.equal(verdict.failing[0].scenarioId, "checkout.card");
    assert.equal(verdict.failing[0].step, 3);
    assert.match(renderVerdict(verdict), /failing INTEG-01: checkout.card \[android\] failed at step 3/u);
  });

  test("a phase declaring no requirements is not verified either", async () => {
    // Saying "verified" here would be exactly the false authority this hook
    // exists to avoid lending.
    const verdict = await validatePhase({ phase: "7", requirements: [] });

    assert.equal(verdict.verified, false);
    assert.equal(verdict.reason, "no_requirements_declared");
  });

  test("bad input is refused rather than defaulted into a pass", async () => {
    await assert.rejects(() => validatePhase({ requirements: ["INTEG-01"] }), {
      code: "E_VALIDATE_PHASE_INVALID"
    });
    await assert.rejects(() => validatePhase({ phase: "7", requirements: "INTEG-01" }), {
      code: "E_VALIDATE_PHASE_INVALID"
    });
    await assert.rejects(() => validatePhase({ phase: "7", requirements: ["INTEG-01"] }), {
      code: "E_VALIDATE_PHASE_INVALID"
    });
  });
});
