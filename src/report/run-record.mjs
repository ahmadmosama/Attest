import os from "node:os";
import stableStringify from "json-stable-stringify";
import { z } from "zod";

import { exitCodeFor } from "../cli/exit-codes.mjs";
import { AttestError } from "../errors.mjs";
import { tallyResults } from "../runtime/result.mjs";

export const RUN_RECORD_VERSION = 1;

const Text = z.string().trim().min(1);
const Duration = z.number().int().nonnegative();
const TextArray = z.array(Text);
const JsonObject = z.record(z.string(), z.unknown());
const HexSha = z.string().regex(/^[a-f0-9]{64}$/);

const ArtifactRefSchema = z
  .object({
    kind: Text,
    path: Text.refine((value) => !value.includes("\\"), {
      message: "Artifact paths must use forward slashes"
    }),
    bytes: z.number().int().nonnegative(),
    sha256: HexSha
  })
  .strict();

const ErrorSchema = z.object({ code: Text, message: Text, details: JsonObject }).strict();
const StepSchema = z
  .object({
    index: z.number().int().nonnegative(),
    kind: Text,
    status: z.enum(["pass", "fail", "skipped", "timed_out"]),
    durationMs: Duration,
    error: ErrorSchema.nullable(),
    evidence: z.array(ArtifactRefSchema)
  })
  .strict();

function addIssue(ctx, path, message) {
  ctx.addIssue({ code: "custom", path, message });
}

const ScenarioSchema = z
  .object({
    id: Text,
    surface: Text,
    result: z.enum(["pass", "fail", "infra_error", "skipped", "quarantined"]),
    durationMs: Duration,
    requirements: TextArray,
    planHash: HexSha,
    planPath: Text,
    rawOpUses: z.number().int().nonnegative(),
    skipped: z.object({ capabilities: TextArray.min(1) }).strict().nullable(),
    error: ErrorSchema.nullable(),
    steps: z.array(StepSchema)
  })
  .strict()
  .superRefine((scenario, ctx) => {
    if (scenario.result === "skipped" && scenario.skipped === null) {
      addIssue(ctx, ["skipped"], "Skipped scenarios must name missing capabilities");
    }
    if (scenario.result !== "skipped" && scenario.skipped !== null) {
      addIssue(ctx, ["skipped"], "Only skipped scenarios may carry skipped details");
    }
    if (scenario.result !== "infra_error") {
      return;
    }
    if (scenario.error === null) {
      addIssue(ctx, ["error"], "Infrastructure errors must carry an error code");
    }
    for (const [index, step] of scenario.steps.entries()) {
      if (step.status === "fail") {
        addIssue(ctx, ["steps", index, "status"], "Infrastructure errors cannot claim a failed scenario step");
      }
    }
  });

const CountsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    infra_error: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative()
  })
  .strict();

const EscapeUseSchema = z
  .object({
    scenarioId: Text,
    surface: Text,
    stepIndex: z.number().int().nonnegative(),
    reason: Text
  })
  .strict();

export const RunRecordSchema = z
  .object({
    runRecordVersion: z.literal(RUN_RECORD_VERSION),
    runId: Text,
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    durationMs: Duration,
    attestVersion: Text,
    node: z.object({ version: Text, platform: Text }).strict(),
    status: z.enum(["pass", "fail", "infra_error"]),
    exitCode: z.number().int().min(0).max(4),
    counts: CountsSchema,
    filters: z
      .object({
        ids: TextArray,
        tags: TextArray,
        surfaces: TextArray,
        headed: z.boolean(),
        dryRun: z.boolean()
      })
      .strict(),
    artifactDir: Text,
    requirements: z
      .object({
        covered: TextArray,
        byScenario: z.record(z.string(), TextArray)
      })
      .strict(),
    escapeHatch: z
      .object({
        rawOpUses: z.number().int().nonnegative(),
        uses: z.array(EscapeUseSchema)
      })
      .strict(),
    hashes: z.object({ bindings: z.record(z.string(), Text), ruleset: Text.nullable() }).strict(),
    telemetry: z
      .object({
        timeouts: z.number().int().nonnegative(),
        retries: z.number().int().nonnegative(),
        convergeMs: z.array(Duration)
      })
      .strict(),
    scenarios: z.array(ScenarioSchema)
  })
  .strict();

function invalid(message, details) {
  return new AttestError("E_RUN_RECORD_INVALID", message, details);
}

function parseOrThrow(record) {
  const parsed = RunRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw invalid("Run record failed schema validation", { issues: parsed.error.issues });
  }
  return parsed.data;
}

function assertSame(field, provided, derived) {
  if (provided !== undefined && stableStringify(provided) !== stableStringify(derived)) {
    throw invalid("Run record derived field drifted", { field, provided, derived });
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function sortUnique(values) {
  return [...new Set(values)].toSorted();
}

function normalizeError(value) {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return { code: value.code, message: value.message, details: value.details ?? {} };
}

function normalizeScenario(scenario) {
  if (scenario === null || typeof scenario !== "object" || Array.isArray(scenario)) {
    return scenario;
  }
  const steps = Array.isArray(scenario.steps)
    ? scenario.steps.map((step) => ({ ...step, error: normalizeError(step.error) }))
    : scenario.steps;
  return { ...scenario, error: normalizeError(scenario.error), steps };
}

function scenarioKey(scenario) {
  return `${scenario.id}\u0000${scenario.surface}`;
}

function deriveRequirements(scenarios) {
  const byScenario = new Map();
  for (const scenario of scenarios) {
    byScenario.set(scenario.id, [...(byScenario.get(scenario.id) ?? []), ...scenario.requirements]);
  }
  const entries = [...byScenario.entries()]
    .map(([id, requirements]) => [id, sortUnique(requirements)])
    .toSorted(([left], [right]) => left.localeCompare(right));
  return Object.freeze({
    covered: sortUnique(scenarios.flatMap((scenario) => scenario.requirements)),
    byScenario: Object.fromEntries(entries)
  });
}

function deriveStatus(counts) {
  if (counts.infra_error > 0) {
    return "infra_error";
  }
  return counts.failed > 0 ? "fail" : "pass";
}

function sortedEscapeUses(uses) {
  return [...uses].toSorted((left, right) => {
    const scenarioOrder = left.scenarioId.localeCompare(right.scenarioId);
    const surfaceOrder = left.surface.localeCompare(right.surface);
    if (scenarioOrder !== 0) {
      return scenarioOrder;
    }
    if (surfaceOrder !== 0) {
      return surfaceOrder;
    }
    return left.stepIndex - right.stepIndex || left.reason.localeCompare(right.reason);
  });
}

function assertEscapeUseCoverage(scenarios, uses) {
  const counts = new Map(scenarios.map((scenario) => [scenarioKey(scenario), 0]));
  for (const use of uses) {
    const key = `${use.scenarioId}\u0000${use.surface}`;
    if (!counts.has(key)) {
      throw invalid("Raw escape hatch use has no scenario", {
        scenarioId: use.scenarioId,
        surface: use.surface
      });
    }
    counts.set(key, counts.get(key) + 1);
  }
  for (const scenario of scenarios) {
    if (scenario.rawOpUses !== counts.get(scenarioKey(scenario))) {
      throw invalid("Scenario raw escape hatch count drifted", {
        scenarioId: scenario.id,
        surface: scenario.surface,
        provided: scenario.rawOpUses,
        derived: counts.get(scenarioKey(scenario))
      });
    }
  }
}

export function createRunRecord(input) {
  const scenarios = Array.isArray(input?.scenarios) ? input.scenarios.map(normalizeScenario) : [];
  const escapeUses = sortedEscapeUses(input?.escapeHatch?.uses ?? []);
  assertEscapeUseCoverage(scenarios, escapeUses);

  const counts = tallyResults(scenarios.map((scenario) => scenario.result));
  const status = deriveStatus(counts);
  const exitCode = exitCodeFor({
    counts,
    usageError: input?.usageError ?? false,
    failOnSkip: input?.failOnSkip ?? true
  });
  const requirements = deriveRequirements(scenarios);
  const escapeHatch = Object.freeze({ rawOpUses: escapeUses.length, uses: escapeUses });

  assertSame("counts", input?.counts, counts);
  assertSame("status", input?.status, status);
  assertSame("exitCode", input?.exitCode, exitCode);
  assertSame("requirements", input?.requirements, requirements);
  assertSame("escapeHatch.rawOpUses", input?.escapeHatch?.rawOpUses, escapeHatch.rawOpUses);

  const record = parseOrThrow({
    runRecordVersion: RUN_RECORD_VERSION,
    runId: input?.runId,
    startedAt: input?.startedAt,
    finishedAt: input?.finishedAt,
    durationMs: input?.durationMs,
    attestVersion: input?.attestVersion,
    node: input?.node ?? { version: process.version, platform: os.platform() },
    status,
    exitCode,
    counts,
    filters: input?.filters,
    artifactDir: input?.artifactDir,
    requirements,
    escapeHatch,
    hashes: input?.hashes,
    telemetry: input?.telemetry,
    scenarios
  });

  return deepFreeze(JSON.parse(stableStringify(record)));
}
