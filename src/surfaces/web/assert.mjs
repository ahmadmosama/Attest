import { AttestError, InfraError, UnsupportedOpError } from "../../errors.mjs";
import { converge } from "../../runtime/converge.mjs";
import { describeLocator, toLocator } from "./locate.mjs";

const ASSERTION_INTERVAL_MS = 50;
const DEFAULT_ASSERT_TIMEOUT_MS = 5000;
const IMMEDIATE_QUERY_TIMEOUT_MS = 0;

export const ASSERT_KINDS = Object.freeze(
  new Set(["expect_visible", "expect_hidden", "expect_text", "expect_state", "expect_count"])
);

const ACCEPTED_STATES = Object.freeze(["enabled", "disabled", "checked", "unchecked", "focused"]);
const ACCEPTED_STATE_SET = new Set(ACCEPTED_STATES);

function abortReason(signal) {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw abortReason(signal);
  }
}

function timeoutMsFor(session) {
  return session?.assertTimeoutMs ?? DEFAULT_ASSERT_TIMEOUT_MS;
}

function redactValue(session, value) {
  return session?.redactor?.redactValue?.(value) ?? value;
}

function actionErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isInfrastructureError(error) {
  const message = actionErrorMessage(error);
  return (
    /Target page, context or browser has been closed/i.test(message) ||
    /Browser has been closed/i.test(message) ||
    /browser has disconnected/i.test(message) ||
    /Execution context was destroyed/i.test(message)
  );
}

function infraErrorFor(error, op, locator) {
  return new InfraError("E_WEB_ASSERTION_INFRA", "Web browser became unavailable during assertion", {
    i: op.i,
    kind: op.kind,
    locator,
    cause: actionErrorMessage(error)
  });
}

function combinedSignalFor(signal, infraAbort) {
  if (signal === undefined) {
    return infraAbort.signal;
  }

  return AbortSignal.any([signal, infraAbort.signal]);
}

function assertionFailed({ op, locator, expected, observed, result, session }) {
  return new AttestError("E_WEB_ASSERTION_FAILED", "Web assertion did not converge", {
    i: op.i,
    kind: op.kind,
    locator,
    expected: redactValue(session, expected),
    observed: redactValue(session, observed),
    convergeMs: result.elapsedMs,
    attempts: result.attempts
  });
}

async function runConverge(session, op, locatorDescription, probe, { signal } = {}) {
  const infraAbort = new AbortController();
  const convergeSignal = combinedSignalFor(signal, infraAbort);

  // Assertions use the project convergence seam instead of Playwright retrying
  // assertions. The run record needs per assertion convergence time, and DB
  // assertions in Phase 3 must share the same bounded polling semantics.
  return converge({
    signal: convergeSignal,
    timeoutMs: timeoutMsFor(session),
    intervalMs: ASSERTION_INTERVAL_MS,
    probe: async () => {
      try {
        return await probe();
      } catch (error) {
        if (isInfrastructureError(error)) {
          infraAbort.abort(infraErrorFor(error, op, locatorDescription));
        }

        throw error;
      }
    }
  });
}

function okDetail(op, result) {
  return Object.freeze({
    ok: true,
    detail: Object.freeze({
      i: op.i,
      kind: op.kind,
      convergeMs: result.elapsedMs,
      attempts: result.attempts
    })
  });
}

function normalizeExpectedText(value) {
  return String(value).trim();
}

async function firstInnerText(locator) {
  return (await locator.first().innerText({ timeout: IMMEDIATE_QUERY_TIMEOUT_MS })).trim();
}

async function focused(locator) {
  return locator
    .first()
    .evaluate((node) => document.activeElement === node, undefined, {
      timeout: IMMEDIATE_QUERY_TIMEOUT_MS
    });
}

async function observedState(locator, state) {
  switch (state) {
    case "enabled":
      return locator.first().isEnabled({ timeout: IMMEDIATE_QUERY_TIMEOUT_MS });
    case "disabled":
      return !(await locator.first().isEnabled({ timeout: IMMEDIATE_QUERY_TIMEOUT_MS }));
    case "checked":
      return locator.first().isChecked({ timeout: IMMEDIATE_QUERY_TIMEOUT_MS });
    case "unchecked":
      return !(await locator.first().isChecked({ timeout: IMMEDIATE_QUERY_TIMEOUT_MS }));
    case "focused":
      return focused(locator);
    default:
      throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported web assertion state", {
        state,
        accepted: ACCEPTED_STATES
      });
  }
}

function stateExpected(op) {
  if (op.equals === undefined) {
    return op.state;
  }

  return Object.freeze({ state: op.state, text: normalizeExpectedText(op.equals) });
}

export async function convergeOnLocator(session, locatorDescriptor, { signal } = {}) {
  throwIfAborted(signal);

  const locator = toLocator(session.page, locatorDescriptor);
  const locatorDescription = describeLocator(locatorDescriptor);
  let observed = false;

  const result = await runConverge(
    session,
    { i: null, kind: "ready" },
    locatorDescription,
    async () => {
      observed = await locator.first().isVisible({ timeout: IMMEDIATE_QUERY_TIMEOUT_MS });
      return Object.freeze({ ok: observed, value: observed });
    },
    { signal }
  );

  return Object.freeze({
    ...result,
    locator: locatorDescription,
    observed
  });
}

export async function executeAssert(session, op, { signal } = {}) {
  throwIfAborted(signal);

  if (!ASSERT_KINDS.has(op?.kind)) {
    throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported web assertion op", {
      i: op?.i,
      kind: op?.kind
    });
  }

  const locator = toLocator(session.page, op.locator);
  const locatorDescription = describeLocator(op.locator);
  let expected;
  let observed;

  let result;
  switch (op.kind) {
    case "expect_visible":
      expected = "visible";
      result = await convergeOnLocator(session, op.locator, { signal });
      observed = result.observed ? "visible" : "hidden";
      break;
    case "expect_hidden":
      expected = "hidden";
      result = await runConverge(
        session,
        op,
        locatorDescription,
        async () => {
          const count = await locator.count();
          const hidden =
            count === 0 ||
            !(await locator.first().isVisible({ timeout: IMMEDIATE_QUERY_TIMEOUT_MS }));
          observed = hidden ? "hidden" : "visible";
          return Object.freeze({ ok: hidden, value: observed });
        },
        { signal }
      );
      break;
    case "expect_text":
      expected = normalizeExpectedText(op.equals);
      result = await runConverge(
        session,
        op,
        locatorDescription,
        async () => {
          observed = await firstInnerText(locator);
          return Object.freeze({ ok: observed === expected, value: observed });
        },
        { signal }
      );
      break;
    case "expect_count":
      expected = op.equals;
      result = await runConverge(
        session,
        op,
        locatorDescription,
        async () => {
          observed = await locator.count();
          return Object.freeze({ ok: observed === expected, value: observed });
        },
        { signal }
      );
      break;
    case "expect_state":
      if (!ACCEPTED_STATE_SET.has(op.state)) {
        throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported web assertion state", {
          i: op.i,
          kind: op.kind,
          locator: locatorDescription,
          state: op.state,
          accepted: ACCEPTED_STATES
        });
      }

      expected = stateExpected(op);
      result = await runConverge(
        session,
        op,
        locatorDescription,
        async () => {
          const stateMatches = await observedState(locator, op.state);
          if (op.equals === undefined) {
            observed = op.state;
            return Object.freeze({ ok: stateMatches, value: observed });
          }

          const text = await firstInnerText(locator);
          observed = Object.freeze({ state: stateMatches ? op.state : `not_${op.state}`, text });
          return Object.freeze({
            ok: stateMatches && text === normalizeExpectedText(op.equals),
            value: observed
          });
        },
        { signal }
      );
      break;
    default:
      throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported web assertion op", {
        i: op.i,
        kind: op.kind
      });
  }

  if (!result.ok) {
    throw assertionFailed({
      op,
      locator: locatorDescription,
      expected,
      observed,
      result,
      session
    });
  }

  return okDetail(op, result);
}
