import { createRunRecord } from "../report/run-record.mjs";
import { toJUnitXml } from "../report/junit.mjs";
import { classifyError } from "./classify.mjs";
import { createRunContext } from "./run-context.mjs";
import { runScenario } from "./orchestrator.mjs";

const DEFAULT_FILTERS = Object.freeze({
  ids: [],
  tags: [],
  surfaces: [],
  headed: false,
  dryRun: false
});

const ZERO_HASH = "0".repeat(64);

function timeValue(value) {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  throw new TypeError("Clock must return a Date or finite number");
}

function isoTime(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function duration(start, finish) {
  return Math.max(0, Math.round(timeValue(finish) - timeValue(start)));
}

function normalizeFilters(config = {}) {
  return Object.freeze({
    ids: [...(config.filters?.ids ?? DEFAULT_FILTERS.ids)],
    tags: [...(config.filters?.tags ?? DEFAULT_FILTERS.tags)],
    surfaces: [...(config.filters?.surfaces ?? DEFAULT_FILTERS.surfaces)],
    headed: config.filters?.headed ?? config.headed ?? DEFAULT_FILTERS.headed,
    dryRun: config.filters?.dryRun ?? DEFAULT_FILTERS.dryRun
  });
}

function errorEntry(classification) {
  return Object.freeze({
    code: classification.code,
    message: classification.message,
    details: classification.details
  });
}

function rawUses(plan) {
  return plan.ops
    .filter((op) => op.kind === "raw")
    .map((op) =>
      Object.freeze({
        scenarioId: plan.scenarioId,
        surface: plan.surface,
        stepIndex: op.i,
        reason: op.reason
      })
    );
}

function skippedScenario(skip) {
  return Object.freeze({
    id: skip.scenarioId,
    surface: skip.surface,
    result: "skipped",
    durationMs: 0,
    requirements: [],
    planHash: ZERO_HASH,
    planPath: `skipped/${skip.scenarioId}__${skip.surface}.json`,
    rawOpUses: 0,
    skipped: Object.freeze({ capabilities: [...skip.capabilities] }),
    error: null,
    steps: []
  });
}

async function planFailureScenario({ plan, bundle, config, now, error }) {
  const started = now();
  const ctx = createRunContext({
    runId: bundle.runId,
    scenarioId: plan.scenarioId,
    surface: plan.surface,
    bundle,
    headed: config.headed ?? false,
    tenantPrefix: config.tenantPrefix ?? "",
    timeouts: config.timeouts ?? {},
    now,
    db: config.db ?? null
  });
  const planRef = await ctx.bundle.writeJson("plan.json", plan);
  const classification = classifyError(error);

  return Object.freeze({
    id: plan.scenarioId,
    surface: plan.surface,
    result: classification.result,
    durationMs: duration(started, now()),
    requirements: [...plan.requirements],
    planHash: plan.planHash,
    planPath: planRef.path,
    rawOpUses: rawUses(plan).length,
    skipped: null,
    error: errorEntry(classification),
    steps: plan.ops.map((op) =>
      Object.freeze({
        index: op.i,
        kind: op.kind,
        status: "skipped",
        durationMs: 0,
        error: null,
        evidence: []
      })
    )
  });
}

async function runOnePlan({ plan, adapterFor, bundle, config, now }) {
  try {
    const adapter = await adapterFor(plan);
    const ctx = createRunContext({
      runId: bundle.runId,
      scenarioId: plan.scenarioId,
      surface: plan.surface,
      bundle,
      headed: config.headed ?? false,
      tenantPrefix: config.tenantPrefix ?? "",
      timeouts: config.timeouts ?? {},
      now,
      db: config.db ?? null
    });

    return await runScenario({ plan, adapter, ctx });
  } catch (error) {
    return planFailureScenario({ plan, bundle, config, now, error });
  }
}

export async function runSuite({
  plans,
  skips = [],
  adapterFor,
  bundle,
  config = {},
  now = Date.now
} = {}) {
  if (!Array.isArray(plans)) {
    throw new TypeError("plans must be an array");
  }

  if (!Array.isArray(skips)) {
    throw new TypeError("skips must be an array");
  }

  if (typeof adapterFor !== "function") {
    throw new TypeError("adapterFor must be a function");
  }

  const started = now();
  const scenarios = [];
  const concurrency = config.concurrency ?? 1;
  if (concurrency !== 1) {
    throw new TypeError("Phase 1 suite concurrency must be 1");
  }

  for (const plan of plans) {
    scenarios.push(await runOnePlan({ plan, adapterFor, bundle, config, now }));
  }

  for (const skip of skips) {
    scenarios.push(skippedScenario(skip));
  }

  const finished = now();
  const record = createRunRecord({
    runId: bundle.runId,
    startedAt: isoTime(started),
    finishedAt: isoTime(finished),
    durationMs: duration(started, finished),
    attestVersion: config.attestVersion ?? "0.1.0",
    filters: normalizeFilters(config),
    artifactDir: bundle.dir,
    hashes: {
      bindings: config.hashes?.bindings ?? {},
      ruleset: config.hashes?.ruleset ?? null
    },
    telemetry: {
      timeouts: scenarios.flatMap((scenario) => scenario.steps).filter((step) => step.status === "timed_out").length,
      retries: 0,
      convergeMs: []
    },
    scenarios,
    escapeHatch: {
      rawOpUses: plans.flatMap(rawUses).length,
      uses: plans.flatMap(rawUses)
    },
    failOnSkip: config.failOnSkip ?? true
  });

  await bundle.writeJson("run.json", record);
  await bundle.write("junit.xml", toJUnitXml(record));
  const artifacts = await bundle.finalize();

  return Object.freeze({ record, artifacts });
}
