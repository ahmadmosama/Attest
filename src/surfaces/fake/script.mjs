import { AttestError } from "../../errors.mjs";
import { OP_CAPABILITIES, OPS } from "../../ir/ops.mjs";
import { assertKnownCapability } from "../../capabilities/registry.mjs";

const OUTCOMES = Object.freeze(["ok", "fail", "infra", "hang"]);
const UNKNOWN_KIND_VALUES = Object.freeze(["throw", "ok"]);
const LOWERED_KIND_ALIASES = Object.freeze(["click"]);

function badScript(reason, details = {}) {
  return new AttestError("E_BAD_FAKE_SCRIPT", "Invalid fake surface script", {
    reason,
    ...details
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw badScript("invalid_string", { field });
  }
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) {
    throw badScript("invalid_supports");
  }

  const seen = new Set();
  const capabilities = [];
  for (const capability of value) {
    assertKnownCapability(capability);
    if (!seen.has(capability)) {
      seen.add(capability);
      capabilities.push(capability);
    }
  }

  return Object.freeze(capabilities);
}

function normalizeOutcome(value, field) {
  if (!isPlainObject(value)) {
    throw badScript("invalid_outcome_entry", { field });
  }

  if (!OUTCOMES.includes(value.outcome)) {
    throw badScript("invalid_outcome", { field, accepted: OUTCOMES });
  }

  if (value.message !== undefined && typeof value.message !== "string") {
    throw badScript("invalid_message", { field });
  }

  return Object.freeze({
    outcome: value.outcome,
    ...(value.message === undefined ? {} : { message: value.message })
  });
}

function normalizeByKind(value) {
  if (!isPlainObject(value)) {
    throw badScript("invalid_byKind");
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([kind, entry]) => {
        assertNonEmptyString(kind, "byKind");
        return [kind, normalizeOutcome(entry, `byKind.${kind}`)];
      })
    )
  );
}

function normalizeByIndex(value) {
  if (!isPlainObject(value)) {
    throw badScript("invalid_byIndex");
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([index, entry]) => {
        const parsed = Number(index);
        if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== index) {
          throw badScript("invalid_index", { index });
        }

        return [index, normalizeOutcome(entry, `byIndex.${index}`)];
      })
    )
  );
}

const DEFAULT_BY_KIND = Object.freeze(
  Object.fromEntries(
    [...OPS, ...LOWERED_KIND_ALIASES].map((kind) => [kind, Object.freeze({ outcome: "ok" })])
  )
);

export function defineScript(partial = {}) {
  if (!isPlainObject(partial)) {
    throw badScript("script_not_object");
  }

  const surface = partial.surface ?? "fake";
  const supports = normalizeCapabilities(partial.supports ?? ["raw_escape"]);
  const byKind = Object.freeze({
    ...DEFAULT_BY_KIND,
    ...normalizeByKind(partial.byKind ?? {})
  });
  const byIndex = normalizeByIndex(partial.byIndex ?? {});
  const unknownKind = partial.unknownKind ?? "throw";

  assertNonEmptyString(surface, "surface");
  if (!UNKNOWN_KIND_VALUES.includes(unknownKind)) {
    throw badScript("invalid_unknownKind", { accepted: UNKNOWN_KIND_VALUES });
  }

  for (const [kind, capabilities] of Object.entries(OP_CAPABILITIES)) {
    assertNonEmptyString(kind, "opCapabilityKind");
    for (const capability of capabilities) {
      assertKnownCapability(capability);
    }
  }

  return Object.freeze({
    surface,
    supports,
    byKind,
    byIndex,
    unknownKind
  });
}

export function defaultScript() {
  return defineScript();
}
