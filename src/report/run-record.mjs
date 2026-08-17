import os from "node:os";
import stableStringify from "json-stable-stringify";
import { z } from "zod";

import { exitCodeFor } from "../cli/exit-codes.mjs";
import { AttestError } from "../errors.mjs";
import { tallyResults } from "../runtime/result.mjs";

export const RUN_RECORD_VERSION = 2;

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

const DeltaCountsSchema = z
  .object({
    expected: z.number().int().nonnegative(),
    explained: z.number().int().nonnegative(),
    suppressed_external: z.number().int().nonnegative(),
    unexplained: z.number().int().nonnegative()
  })
  .strict();

const DeltaRowSchema = z
  .object({
    entity: Text,
    op: Text,
    key: z.string(),
    columns: TextArray,
    columnText: z.string(),
    notes: z.array(z.string())
  })
  .strict();

const UnexplainedGroupSchema = z
  .object({
    entity: Text,
    op: Text,
    count: z.number().int().nonnegative(),
    rows: z.array(DeltaRowSchema),
    omitted: z.number().int().nonnegative()
  })
  .strict();

const QuietSchema = z
  .object({
    quiet: z.boolean(),
    elapsedMs: Duration,
    events: z.number().int().nonnegative(),
    extensions: z.number().int().nonnegative()
  })
  .strict();

const RuleAccountingSchema = z
  .object({
    id: Text,
    kind: Text,
    entity: Text,
    suppressed: z.number().int().nonnegative(),
    overBudget: z.number().int().nonnegative(),
    cap: z.number().int().nonnegative().nullable(),
    dead: z.boolean(),
    expired: z.boolean()
  })
  .strict();

const DeltaHealthSchema = z
  .object({
    dead: z.array(JsonObject),
    expired: z.array(JsonObject),
    expiringSoon: z.array(JsonObject)
  })
  .strict();

const ScenarioDeltaSchema = z
  .object({
    capturedEventCount: z.number().int().nonnegative(),
    counts: DeltaCountsSchema,
    unexplained: z.array(UnexplainedGroupSchema),
    shortfalls: z.array(JsonObject),
    convergeMs: z.array(Duration),
    quiet: QuietSchema.nullable(),
    quietPeriods: z.array(QuietSchema),
    rulesetHash: HexSha,
    rules: z.array(RuleAccountingSchema),
    capViolations: z.array(JsonObject),
    health: DeltaHealthSchema
  })
  .strict()
  .superRefine((delta, ctx) => {
    const bucketTotal =
      delta.counts.expected +
      delta.counts.explained +
      delta.counts.suppressed_external +
      delta.counts.unexplained;
    if (bucketTotal !== delta.capturedEventCount) {
      addIssue(ctx, ["counts"], "Delta bucket counts must sum to capturedEventCount");
    }
  });

const StepSchema = z
  .object({
    index: z.number().int().nonnegative(),
    kind: Text,
    status: z.enum(["pass", "fail", "skipped", "timed_out"]),
    durationMs: Duration,
    error: ErrorSchema.nullable(),
    evidence: z.array(ArtifactRefSchema),
    delta: ScenarioDeltaSchema.nullable().default(null)
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
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
    durationMs: Duration,
    requirements: TextArray,
    planHash: HexSha,
    planPath: Text,
    rawOpUses: z.number().int().nonnegative(),
    skipped: z.object({ capabilities: TextArray.min(1) }).strict().nullable(),
    error: ErrorSchema.nullable(),
    delta: ScenarioDeltaSchema.nullable().default(null),
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

const DeltaSchedulingSchema = z
  .object({
    forcedSerial: z.number().int().nonnegative(),
    reason: Text.nullable()
  })
  .strict();

const RunDeltaSchema = z
  .object({
    counts: DeltaCountsSchema,
    rules: z.array(RuleAccountingSchema)
  })
  .strict();

function upgradeRecordVersion(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return record;
  }

  if (record.runRecordVersion === RUN_RECORD_VERSION) {
    return record;
  }

  if (record.runRecordVersion === 1 && record.delta === undefined) {
    return { ...record, runRecordVersion: RUN_RECORD_VERSION };
  }

  return record;
}

export const RunRecordSchema = z.preprocess(
  upgradeRecordVersion,
  z
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
    hashes: z.object({ bindings: z.record(z.string(), Text), ruleset: HexSha.nullable() }).strict(),
    telemetry: z
      .object({
        timeouts: z.number().int().nonnegative(),
        retries: z.number().int().nonnegative(),
        convergeMs: z.array(Duration),
        deltaScheduling: DeltaSchedulingSchema.default({ forcedSerial: 0, reason: null })
      })
      .strict(),
    delta: RunDeltaSchema.nullable().default(null),
    scenarios: z.array(ScenarioSchema)
  })
    .strict()
);

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

function normalizeDelta(value) {
  return value ?? null;
}

function normalizeScenario(scenario, fallback = {}) {
  if (scenario === null || typeof scenario !== "object" || Array.isArray(scenario)) {
    return scenario;
  }
  const steps = Array.isArray(scenario.steps)
    ? scenario.steps.map((step) => ({
        ...step,
        error: normalizeError(step.error),
        delta: normalizeDelta(step.delta)
      }))
    : scenario.steps;
  return {
    ...scenario,
    startedAt: scenario.startedAt ?? fallback.startedAt,
    finishedAt: scenario.finishedAt ?? fallback.finishedAt,
    error: normalizeError(scenario.error),
    delta: normalizeDelta(scenario.delta),
    steps
  };
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

function emptyDeltaCounts() {
  return {
    expected: 0,
    explained: 0,
    suppressed_external: 0,
    unexplained: 0
  };
}

function addDeltaCounts(target, source = {}) {
  target.expected += source.expected ?? 0;
  target.explained += source.explained ?? 0;
  target.suppressed_external += source.suppressed_external ?? 0;
  target.unexplained += source.unexplained ?? 0;
}

function ruleKey(rule) {
  return `${rule.id}\u0000${rule.kind}\u0000${rule.entity}`;
}

function mergeRuleAccounting(rules) {
  const merged = new Map();

  for (const rule of rules) {
    const key = ruleKey(rule);
    const current = merged.get(key) ?? {
      id: rule.id,
      kind: rule.kind,
      entity: rule.entity,
      suppressed: 0,
      overBudget: 0,
      cap: rule.cap ?? null,
      dead: false,
      expired: false
    };

    current.suppressed += rule.suppressed ?? 0;
    current.overBudget += rule.overBudget ?? 0;
    current.dead = current.dead || rule.dead === true;
    current.expired = current.expired || rule.expired === true;
    merged.set(key, current);
  }

  return [...merged.values()].toSorted(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.kind.localeCompare(right.kind) ||
      left.entity.localeCompare(right.entity)
  );
}

function scenarioDeltas(scenarios) {
  return scenarios.map((scenario) => scenario.delta).filter(Boolean);
}

function deriveDelta(scenarios) {
  const deltas = scenarioDeltas(scenarios);
  if (deltas.length === 0) {
    return null;
  }

  const counts = emptyDeltaCounts();
  for (const delta of deltas) {
    addDeltaCounts(counts, delta.counts);
  }

  return Object.freeze({
    counts,
    rules: mergeRuleAccounting(deltas.flatMap((delta) => delta.rules ?? []))
  });
}

function deriveRulesetHash(inputHash, scenarios) {
  if (inputHash !== undefined && inputHash !== null) {
    return inputHash;
  }

  const hashes = [...new Set(scenarioDeltas(scenarios).map((delta) => delta.rulesetHash).filter(Boolean))];
  return hashes.length === 1 ? hashes[0] : null;
}

function deriveConvergeMs(scenarios) {
  return scenarioDeltas(scenarios).flatMap((delta) => delta.convergeMs ?? []);
}

function telemetryFor(input, scenarios) {
  const convergeMs = deriveConvergeMs(scenarios);

  return Object.freeze({
    timeouts: input?.telemetry?.timeouts,
    retries: input?.telemetry?.retries,
    convergeMs,
    deltaScheduling: input?.telemetry?.deltaScheduling ?? { forcedSerial: 0, reason: null }
  });
}

export function createRunRecord(input) {
  const fallbackTiming = Object.freeze({
    startedAt: input?.startedAt,
    finishedAt: input?.finishedAt
  });
  const scenarios = Array.isArray(input?.scenarios)
    ? input.scenarios.map((scenario) => normalizeScenario(scenario, fallbackTiming))
    : [];
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
  const delta = deriveDelta(scenarios);
  const hashes = Object.freeze({
    bindings: input?.hashes?.bindings ?? {},
    ruleset: deriveRulesetHash(input?.hashes?.ruleset, scenarios)
  });
  const telemetry = telemetryFor(input, scenarios);

  assertSame("counts", input?.counts, counts);
  assertSame("status", input?.status, status);
  assertSame("exitCode", input?.exitCode, exitCode);
  assertSame("requirements", input?.requirements, requirements);
  assertSame("escapeHatch.rawOpUses", input?.escapeHatch?.rawOpUses, escapeHatch.rawOpUses);
  assertSame("delta", input?.delta, delta);
  if ((input?.telemetry?.convergeMs ?? []).length > 0 || telemetry.convergeMs.length === 0) {
    assertSame("telemetry.convergeMs", input?.telemetry?.convergeMs, telemetry.convergeMs);
  }

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
    hashes,
    telemetry,
    delta,
    scenarios
  });

  return deepFreeze(JSON.parse(stableStringify(record)));
}
