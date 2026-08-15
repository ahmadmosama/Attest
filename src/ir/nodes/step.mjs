import { capabilitiesFor } from "../ops.mjs";
import { isSemanticRef } from "../semantic-ref.mjs";

const TARGET_ONLY_OPS = new Set([
  "open",
  "tap",
  "long_press",
  "clear",
  "scroll_until_visible",
  "select_option",
  "upload_file",
  "expect_visible",
  "expect_hidden",
  "expect_count"
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  }

  return value;
}

function collectRefs(value, refs = new Set()) {
  if (typeof value === "string") {
    if (isSemanticRef(value)) {
      refs.add(value);
    }
    return refs;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs);
    }
    return refs;
  }

  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collectRefs(item, refs);
    }
  }

  return refs;
}

function normalizeDeltaWindow(step) {
  if (step.delta_window === "open") {
    return { open: true };
  }

  return {
    close: {
      ...(Array.isArray(step.expect_mutations) ? { expect_mutations: cloneJson(step.expect_mutations) } : {}),
      ...(step.require_no_unexplained === undefined
        ? {}
        : { require_no_unexplained: step.require_no_unexplained })
    }
  };
}

function normalizeValue(op, rawValue, sourceStep) {
  if (op === "delta_window") {
    return normalizeDeltaWindow(sourceStep);
  }

  if (TARGET_ONLY_OPS.has(op) && typeof rawValue === "string") {
    return { target: rawValue };
  }

  if (rawValue === true || rawValue === null) {
    return null;
  }

  if (isRecord(rawValue) && Object.keys(rawValue).length === 0) {
    return null;
  }

  return cloneJson(rawValue);
}

export function createStepNode({ index, op, value, pos }) {
  const normalizedValue = normalizeValue(op, value, value?.delta_window === undefined ? { [op]: value } : value);
  const capabilities = [...capabilitiesFor(op, normalizedValue)].toSorted();
  const refs = [...collectRefs(normalizedValue)].toSorted();

  return {
    index,
    op,
    value: normalizedValue,
    capabilities,
    refs,
    pos: {
      line: pos.line,
      col: pos.col
    }
  };
}
