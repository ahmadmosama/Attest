import path from "node:path";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { EXIT } from "../cli/exit-codes.mjs";

/**
 * Attest as an AtoZ pipeline stage.
 *
 * The contract is a SHAPE, not a dependency. This module imports nothing from
 * AtoZ, and AtoZ imports nothing from Attest at build time: it mounts this
 * object in its own `_registry.mjs`. Two mature projects that import each other
 * are one project with a longer build.
 *
 * That also means the blocking error is duck typed. AtoZ blocks on a
 * `BlockerError` carrying `kind` and `reason`, so this throws an error of the
 * same shape and name rather than importing the class.
 */

export const STAGE_NAME = "verify";

// The blocking decision comes from ONE field. Parsing the HTML report, which is
// written for humans, is how a gate starts disagreeing with itself.
export const VERIFY_REPORT = z
  .object({
    status: z.enum(["passed", "failed", "infra_error"]),
    runId: z.string().min(1),
    exitCode: z.number().int(),
    artifactDir: z.string().min(1),
    counts: z
      .object({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        infra_error: z.number().int().nonnegative()
      })
      .passthrough(),
    failures: z.array(
      z.object({
        scenarioId: z.string(),
        surface: z.string(),
        code: z.string().nullable(),
        message: z.string().nullable()
      })
    ),
    requirements: z.array(z.string())
  })
  .strict();

function blocker(kind, reason, details = {}) {
  // Structurally an AtoZ BlockerError: same name, same two fields. Duck typed
  // on purpose, so neither project has to import the other.
  const error = new Error(reason);
  error.name = "BlockerError";
  error.kind = kind;
  error.details = Object.freeze({ ...details });
  return error;
}

function failuresFrom(record) {
  return Object.freeze(
    (record.scenarios ?? [])
      .filter((scenario) => scenario.result === "failed" || scenario.result === "infra_error")
      .map((scenario) =>
        Object.freeze({
          scenarioId: scenario.id,
          surface: scenario.surface,
          code: scenario.error?.code ?? null,
          message: scenario.error?.message ?? null
        })
      )
  );
}

function statusFrom(record) {
  if ((record.counts?.infra_error ?? 0) > 0) {
    // Infrastructure is distinguishable from a scenario failure all the way to
    // the pipeline, because "the emulator did not boot" and "the app is wrong"
    // call for different actions from whoever is paged.
    return "infra_error";
  }

  return (record.counts?.failed ?? 0) > 0 ? "failed" : "passed";
}

async function readRunRecord(artifactDir, runId) {
  const file = path.join(artifactDir, runId, "run.json");

  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw blocker("verify_no_run_record", `Attest produced no readable run record at ${file}`, {
      file,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Build the stage object AtoZ mounts.
 *
 * `runAttest` is injected so the stage's blocking logic is assertable without
 * spawning a real run, and so AtoZ can supply its own runner if it prefers.
 */
export function createAttestStage({ runAttest, inputs = ["build"], applicable = () => true } = {}) {
  return Object.freeze({
    name: STAGE_NAME,
    inputs: Object.freeze([...inputs]),
    applicable,
    outputSchema: VERIFY_REPORT,

    async run(ctx = {}, _inputs = {}, deps = {}) {
      const run = deps.runAttest ?? runAttest;

      if (typeof run !== "function") {
        throw blocker("verify_not_configured", "The verify stage has no Attest runner wired in", {
          remediation: "Pass runAttest when creating the stage, or inject it as the third run() argument."
        });
      }

      const result = await run({
        cwd: ctx.appWorkspace ?? ctx.cwd ?? process.cwd(),
        artifactRoot: ctx.artifactRoot ?? ".attest/runs",
        surfaces: ctx.surfaces ?? ["web"]
      });

      // run.json, never the HTML. One field decides.
      const record = result.record ?? (await readRunRecord(result.artifactRoot, result.runId));
      const status = statusFrom(record);
      const failures = failuresFrom(record);

      const report = VERIFY_REPORT.parse({
        status,
        runId: record.runId,
        exitCode: record.exitCode ?? (status === "passed" ? EXIT.PASS : EXIT.SCENARIO_FAILURE),
        artifactDir: record.artifactDir,
        counts: record.counts,
        failures,
        requirements: record.requirements?.covered ?? []
      });

      if (status !== "passed") {
        // Blocking is the point. A verification stage that reports and lets the
        // pipeline continue is a dashboard.
        throw blocker(
          status === "infra_error" ? "verify_infra" : "verify_failed",
          status === "infra_error"
            ? `Attest could not verify: ${failures.length} infrastructure error(s)`
            : `Attest verification failed: ${report.counts.failed} scenario(s)`,
          { report }
        );
      }

      return report;
    }
  });
}
