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

function timedScenario(scenario, started, finished) {
  return Object.freeze({
    ...scenario,
    startedAt: isoTime(started),
    finishedAt: isoTime(finished)
  });
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

function skippedScenario(skip, now) {
  const instant = now();
  return Object.freeze({
    id: skip.scenarioId,
    surface: skip.surface,
    result: "skipped",
    startedAt: isoTime(instant),
    finishedAt: isoTime(instant),
    durationMs: 0,
    requirements: [],
    planHash: ZERO_HASH,
    planPath: `skipped/${skip.scenarioId}__${skip.surface}.json`,
    rawOpUses: 0,
    skipped: Object.freeze({ capabilities: [...skip.capabilities] }),
    error: null,
    delta: null,
    steps: []
  });
}

function dbForPlan(config, plan) {
  if (typeof config.dbForPlan === "function") {
    return config.dbForPlan(plan);
  }

  if (typeof config.db === "function") {
    return config.db(plan);
  }

  return config.db ?? null;
}

async function planFailureScenario({ plan, bundle, config, now, error, started = now() }) {
  const ctx = createRunContext({
    runId: bundle.runId,
    scenarioId: plan.scenarioId,
    surface: plan.surface,
    bundle,
    headed: config.headed ?? false,
    tenantPrefix: config.tenantPrefix ?? "",
    timeouts: config.timeouts ?? {},
    now,
    db: dbForPlan(config, plan)
  });
  const planRef = await ctx.bundle.writeJson("plan.json", plan);
  const classification = classifyError(error);
  const finished = now();

  return Object.freeze({
    id: plan.scenarioId,
    surface: plan.surface,
    result: classification.result,
    startedAt: isoTime(started),
    finishedAt: isoTime(finished),
    durationMs: duration(started, finished),
    requirements: [...plan.requirements],
    planHash: plan.planHash,
    planPath: planRef.path,
    rawOpUses: rawUses(plan).length,
    skipped: null,
    error: errorEntry(classification),
    delta: null,
    steps: plan.ops.map((op) =>
      Object.freeze({
        index: op.i,
        kind: op.kind,
        status: "skipped",
        durationMs: 0,
        error: null,
        evidence: [],
        delta: null
      })
    )
  });
}

async function runOnePlan({ plan, adapterFor, bundle, config, now }) {
  const started = now();
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
      db: dbForPlan(config, plan)
    });

    const scenario = await runScenario({ plan, adapter, ctx });
    return timedScenario(scenario, started, now());
  } catch (error) {
    return planFailureScenario({ plan, bundle, config, now, error, started });
  }
}

function planHasDeltaAssertion(plan) {
  return plan.capabilities?.demanded?.includes("db.delta_assertion") === true;
}

function positiveConcurrency(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("concurrency must be a positive safe integer");
  }

  return value;
}

function dbCapabilities(config) {
  if (config.dbCapabilities !== undefined) {
    return config.dbCapabilities;
  }

  const db = typeof config.db === "function" ? null : config.db;
  if (typeof db?.describeCapabilities === "function") {
    try {
      return db.describeCapabilities();
    } catch {
      return null;
    }
  }

  return db?.capabilities ?? null;
}

function supportsParallelDelta(config) {
  const capabilities = dbCapabilities(config);

  return (
    (config.parallelDelta === true || config.deltaConcurrency === true || config.db?.parallelDelta === true) &&
    capabilities?.txAttribution === true &&
    capabilities?.watermarkFencing === "inline" &&
    (capabilities?.perScenarioTenancy === true ||
      capabilities?.scenarioTenancy === true ||
      capabilities?.transactionalTeardown === true)
  );
}

function deltaScheduling(config, deltaPlans, concurrency) {
  if (deltaPlans.length === 0 || concurrency === 1 || supportsParallelDelta(config)) {
    return Object.freeze({ forcedSerial: 0, reason: null });
  }

  return Object.freeze({
    forcedSerial: deltaPlans.length,
    reason: "delta scenarios require transaction attribution, inline watermark fencing, and per scenario tenancy for parallel attribution"
  });
}

function partitionPlans(plans) {
  const nonDelta = [];
  const delta = [];

  plans.forEach((plan, index) => {
    const item = Object.freeze({ plan, index });
    if (planHasDeltaAssertion(plan)) {
      delta.push(item);
    } else {
      nonDelta.push(item);
    }
  });

  return Object.freeze({ nonDelta, delta });
}

async function runBounded(items, limit, fn) {
  const results = Array.from({ length: items.length });
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function runPartitionedPlans({ plans, adapterFor, bundle, config, now, concurrency }) {
  const partitioned = partitionPlans(plans);
  const resultsByPlanIndex = Array.from({ length: plans.length });
  const scheduling = deltaScheduling(config, partitioned.delta, concurrency);
  const deltaLimit = scheduling.reason === null && supportsParallelDelta(config) ? concurrency : 1;
  const runItem = async ({ plan, index }) => {
    resultsByPlanIndex[index] = await runOnePlan({ plan, adapterFor, bundle, config, now });
  };

  await runBounded(partitioned.nonDelta, concurrency, runItem);
  await runBounded(partitioned.delta, deltaLimit, runItem);

  return Object.freeze({
    scenarios: Object.freeze(resultsByPlanIndex.filter(Boolean)),
    scheduling
  });
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
  const concurrency = positiveConcurrency(config.concurrency ?? 1);
  const run = await runPartitionedPlans({ plans, adapterFor, bundle, config, now, concurrency });
  const scenarios = [...run.scenarios];

  for (const skip of skips) {
    scenarios.push(skippedScenario(skip, now));
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
      convergeMs: [],
      deltaScheduling: run.scheduling
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
