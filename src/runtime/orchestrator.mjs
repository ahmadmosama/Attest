import { assertImplementsSurfacePort } from "../surfaces/port.mjs";
import { classifyError } from "./classify.mjs";
import { TimeoutError, withTimeout } from "./timeout.mjs";

const DB_WINDOW_OPS = new Set(["db_window_open", "db_window_close"]);

function timeValue(value) {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  throw new TypeError("Clock must return a Date or finite number");
}

function durationFrom(start, now) {
  return Math.max(0, Math.round(timeValue(now()) - start));
}

function errorEntry(classification) {
  return Object.freeze({
    code: classification.code,
    message: classification.message,
    details: classification.details
  });
}

function passedStep(op, durationMs, evidence = []) {
  return Object.freeze({
    index: op.i,
    kind: op.kind,
    status: "pass",
    durationMs,
    error: null,
    evidence
  });
}

function skippedStep(op) {
  return Object.freeze({
    index: op.i,
    kind: op.kind,
    status: "skipped",
    durationMs: 0,
    error: null,
    evidence: []
  });
}

function failedStep(op, durationMs, classification, evidence) {
  const timedOut = classification.code === "E_TIMEOUT";
  const status =
    classification.result === "infra_error" ? "skipped" : timedOut ? "timed_out" : "fail";

  return Object.freeze({
    index: op.i,
    kind: op.kind,
    status,
    durationMs,
    error: errorEntry(classification),
    evidence
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

function scenarioEntry({ plan, result, durationMs, planPath, error, steps }) {
  return Object.freeze({
    id: plan.scenarioId,
    surface: plan.surface,
    result,
    durationMs,
    requirements: [...plan.requirements],
    planHash: plan.planHash,
    planPath,
    rawOpUses: rawUses(plan).length,
    skipped: null,
    error,
    steps: Object.freeze(steps)
  });
}

async function collectFailureEvidence({ adapter, session, ctx }) {
  if (session === null) {
    return [];
  }

  try {
    const ref = await withTimeout(
      ({ signal }) => adapter.collectEvidence(session, "failure", { bundle: ctx.bundle, signal }),
      { ms: ctx.timeouts.evidenceMs, kind: "evidence" }
    );
    return ref === null || ref === undefined ? [] : [ref];
  } catch {
    return [];
  }
}

async function closeSession({ adapter, session, ctx }) {
  try {
    await withTimeout(({ signal }) => adapter.close(session, { signal }), {
      ms: ctx.timeouts.closeMs,
      kind: "close"
    });
  } catch {
    // Close failures are telemetry for later phases. They must not overwrite
    // the scenario result produced by the execution loop.
  }
}

function timeoutFromSignal(signal, ms) {
  if (signal.reason instanceof TimeoutError) {
    return signal.reason;
  }

  return new TimeoutError({ kind: "scenario", ms, at: null });
}

async function runDbWindow(op, ctx, signal) {
  const hookName = op.kind === "db_window_open" ? "onWindowOpen" : "onWindowClose";
  if (typeof ctx.db?.[hookName] !== "function") {
    return Object.freeze({ ok: true });
  }

  return ctx.db[hookName](op, { signal, ctx });
}

async function executeLoop({ plan, adapter, ctx, scenarioSignal, startedAt, planPath }) {
  let session = null;
  const steps = [];
  let result = "pass";
  let scenarioError = null;

  try {
    await withTimeout(({ signal }) => adapter.preflight(ctx, { signal }), {
      ms: ctx.timeouts.preflightMs,
      kind: "preflight",
      parentSignal: scenarioSignal
    });
    session = await withTimeout(({ signal }) => adapter.open(ctx, { signal }), {
      ms: ctx.timeouts.openMs,
      kind: "preflight",
      parentSignal: scenarioSignal
    });

    // Retries are whole scenario only. Retrying a single step can double write.
    for (const op of plan.ops) {
      if (scenarioSignal.aborted) {
        throw timeoutFromSignal(scenarioSignal, ctx.timeouts.scenarioMs);
      }

      const stepStartedAt = timeValue(ctx.now());
      try {
        if (DB_WINDOW_OPS.has(op.kind)) {
          await withTimeout(({ signal }) => runDbWindow(op, ctx, signal), {
            ms: ctx.timeouts.stepMs,
            kind: "step",
            at: op.i,
            parentSignal: scenarioSignal
          });
        } else {
          await withTimeout(({ signal }) => adapter.execute(session, op, { signal }), {
            ms: ctx.timeouts.stepMs,
            kind: "step",
            at: op.i,
            parentSignal: scenarioSignal
          });
        }

        steps.push(passedStep(op, durationFrom(stepStartedAt, ctx.now)));
      } catch (error) {
        const classification = classifyError(error);
        const evidence = await collectFailureEvidence({ adapter, session, ctx });
        const durationMs = durationFrom(stepStartedAt, ctx.now);
        steps.push(failedStep(op, durationMs, classification, evidence));

        result = classification.result;
        scenarioError = classification.result === "infra_error" ? errorEntry(classification) : null;
        break;
      }
    }
  } catch (error) {
    const classification = classifyError(error);
    result = classification.result;
    scenarioError = classification.result === "infra_error" ? errorEntry(classification) : null;
  } finally {
    for (const op of plan.ops.slice(steps.length)) {
      steps.push(skippedStep(op));
    }
    await closeSession({ adapter, session, ctx });
  }

  return scenarioEntry({
    plan,
    result,
    durationMs: durationFrom(startedAt, ctx.now),
    planPath,
    error: scenarioError,
    steps
  });
}

export async function runScenario({ plan, adapter, ctx }) {
  assertImplementsSurfacePort(adapter);

  const startedAt = timeValue(ctx.now());
  const planRef = await ctx.bundle.writeJson("plan.json", plan);
  let loopPromise = null;

  try {
    return await withTimeout(
      ({ signal }) => {
        loopPromise = executeLoop({
          plan,
          adapter,
          ctx,
          scenarioSignal: signal,
          startedAt,
          planPath: planRef.path
        });
        return loopPromise;
      },
      { ms: ctx.timeouts.scenarioMs, kind: "scenario" }
    );
  } catch (error) {
    if (error instanceof TimeoutError && error.details.kind === "scenario" && loopPromise !== null) {
      return loopPromise;
    }

    throw error;
  }
}
