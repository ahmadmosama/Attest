import { AttestError, InfraError, UnsupportedOpError } from "../../errors.mjs";
import { converge } from "../../runtime/converge.mjs";
import { findAll } from "./hierarchy.mjs";
import { findByQuery, toAndroidQuery } from "./locate.mjs";
import { dumpHierarchy } from "./session.mjs";

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

function redactValue(session, value) {
  return session?.redactor?.redactValue?.(value) ?? value;
}

function okDetail(op, result, extra = {}) {
  return Object.freeze({
    ok: true,
    detail: Object.freeze({
      i: op.i,
      kind: op.kind,
      convergeMs: result.elapsedMs,
      attempts: result.attempts,
      ...extra
    })
  });
}

function assertionFailed({ session, op, locator, expected, observed, result }) {
  return new AttestError("E_ANDROID_ASSERTION_FAILED", "Android assertion did not converge", {
    i: op.i,
    kind: op.kind,
    locator,
    expected: redactValue(session, expected),
    observed: redactValue(session, observed),
    convergeMs: result.elapsedMs,
    attempts: result.attempts
  });
}

// An element's accessible text on Android is its text when it has one and its
// content description otherwise. A TextView carries text, an ImageButton
// carries only a description, and one scenario has to cover both.
function accessibleText(node) {
  return (node.text.length > 0 ? node.text : node.contentDesc).trim();
}

function observedState(node, state) {
  switch (state) {
    case "enabled":
      return node.enabled;
    case "disabled":
      return !node.enabled;
    case "checked":
      return node.checked;
    case "unchecked":
      return node.checkable && !node.checked;
    case "focused":
      return node.focused;
    default:
      throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported android assertion state", {
        state,
        accepted: ACCEPTED_STATES
      });
  }
}

function stateExpected(op) {
  return op.equals === undefined ? op.state : Object.freeze({ state: op.state, text: String(op.equals).trim() });
}

async function convergeOnHierarchy(session, { signal }, probe) {
  let lastError;

  const result = await converge({
    signal,
    timeoutMs: session.stepTimeoutMs,
    intervalMs: session.dumpIntervalMs,
    probe: async () => {
      try {
        return probe(await dumpHierarchy(session, { signal }));
      } catch (error) {
        lastError = error;
        throw error;
      }
    }
  });

  // A device that went away is infrastructure, not a failed assertion.
  if (result.ok !== true && lastError instanceof InfraError) {
    throw lastError;
  }

  return result;
}

export async function executeAssert(session, op, { signal } = {}) {
  throwIfAborted(signal);

  if (!ASSERT_KINDS.has(op?.kind)) {
    throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported android assertion op", {
      i: op?.i,
      kind: op?.kind
    });
  }

  if (op.kind === "expect_state" && !ACCEPTED_STATE_SET.has(op.state)) {
    throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported android assertion state", {
      i: op.i,
      kind: op.kind,
      state: op.state,
      accepted: ACCEPTED_STATES
    });
  }

  const query = toAndroidQuery(op.locator);
  let expected;
  let observed;

  const result = await convergeOnHierarchy(session, { signal }, (nodes) => {
    switch (op.kind) {
      case "expect_visible": {
        expected = "visible";
        const found = findByQuery(nodes, query, { requireVisible: true });
        observed = found.ok === true ? "visible" : found.reason;
        return Object.freeze({ ok: found.ok === true, value: observed });
      }
      case "expect_hidden": {
        expected = "hidden";
        const found = findByQuery(nodes, query, { requireVisible: true });
        observed = found.ok === true ? "visible" : "hidden";
        return Object.freeze({ ok: found.ok !== true, value: observed });
      }
      case "expect_text": {
        expected = String(op.equals).trim();
        const found = findByQuery(nodes, query, { requireVisible: true });
        observed = found.ok === true ? accessibleText(found.node) : found.reason;
        return Object.freeze({ ok: found.ok === true && observed === expected, value: observed });
      }
      case "expect_count": {
        expected = op.equals;
        // Count ignores nth: nth picks one of many, and counting how many
        // there are is the opposite question.
        observed = findAll(nodes, query.selector, { requireVisible: true }).length;
        return Object.freeze({ ok: observed === expected, value: observed });
      }
      default: {
        expected = stateExpected(op);
        const found = findByQuery(nodes, query, { requireVisible: true });
        if (found.ok !== true) {
          observed = found.reason;
          return Object.freeze({ ok: false, value: observed });
        }

        const matches = observedState(found.node, op.state);
        if (op.equals === undefined) {
          observed = matches ? op.state : `not_${op.state}`;
          return Object.freeze({ ok: matches, value: observed });
        }

        const text = accessibleText(found.node);
        observed = Object.freeze({ state: matches ? op.state : `not_${op.state}`, text });
        return Object.freeze({ ok: matches && text === String(op.equals).trim(), value: observed });
      }
    }
  });

  if (result.ok !== true) {
    throw assertionFailed({
      session,
      op,
      locator: query.description,
      expected,
      observed,
      result
    });
  }

  return okDetail(op, result, { locator: query.description });
}
