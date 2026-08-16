import { createHash } from "node:crypto";

import stableStringify from "json-stable-stringify";

import { AttestError } from "../../errors.mjs";
import { createRedactor, REDACTED } from "../../evidence/redact.mjs";
import { canonicalValue } from "./canonical.mjs";

export const REDACTION_MODES = Object.freeze(["hash", "mask"]);

const HASHED_REDACTION_PATTERN = /^sha256:[0-9a-f]{12}$/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidPolicy(reason, details = {}) {
  return new AttestError("E_REDACTION_POLICY_INVALID", "Invalid database redaction policy", {
    reason,
    ...details
  });
}

function assertMode(mode) {
  if (!REDACTION_MODES.includes(mode)) {
    throw invalidPolicy("invalid_mode", {
      field: "mode",
      accepted: REDACTION_MODES
    });
  }
}

function parseEntry(entry) {
  if (typeof entry !== "string" || entry.length === 0) {
    throw invalidPolicy("invalid_entry", { entry });
  }

  const separator = entry.lastIndexOf(".");
  if (separator <= 0 || separator === entry.length - 1) {
    throw invalidPolicy("invalid_entry", { entry });
  }

  const entity = entry.slice(0, separator);
  const column = entry.slice(separator + 1);

  if (column.includes("*")) {
    throw invalidPolicy("column_wildcard_forbidden", { entry });
  }

  if (entity.includes("*") && entity !== "*") {
    throw invalidPolicy("entity_wildcard_forbidden", { entry });
  }

  if (entity !== "*" && !entity.includes(".")) {
    throw invalidPolicy("entity_not_schema_qualified", { entry });
  }

  if (entity === "*" && column === "*") {
    throw invalidPolicy("database_wildcard_forbidden", { entry });
  }

  return Object.freeze({
    entry,
    entity,
    column,
    anyEntity: entity === "*"
  });
}

function normalizePolicy(sensitive) {
  if (!Array.isArray(sensitive)) {
    throw invalidPolicy("sensitive_not_array", {
      field: "sensitive",
      accepted: "array"
    });
  }

  const unique = new Map();
  for (const entry of sensitive) {
    const parsed = parseEntry(entry);
    unique.set(parsed.entry, parsed);
  }

  return Object.freeze(
    [...unique.values()].toSorted((left, right) => left.entry.localeCompare(right.entry))
  );
}

function hashValue(value) {
  const serialised = stableStringify(canonicalValue(value));
  const digest = createHash("sha256").update(serialised).digest("hex").slice(0, 12);
  return `sha256:${digest}`;
}

function isAlreadyRedacted(value) {
  return value === REDACTED || (typeof value === "string" && HASHED_REDACTION_PATTERN.test(value));
}

function shouldRedactColumn(policy, entity, column) {
  return policy.some((entry) => entry.column === column && (entry.anyEntity || entry.entity === entity));
}

function redactSafeValue(value, redactText) {
  if (typeof value === "string") {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSafeValue(item, redactText));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSafeValue(item, redactText)])
    );
  }

  return value;
}

function redactSensitiveValue(value, mode) {
  if (isAlreadyRedacted(value)) {
    return value;
  }

  if (mode === "mask") {
    return REDACTED;
  }

  return hashValue(value);
}

/**
 * Build the capture time row redactor.
 *
 * This deliberately reuses the evidence redactor for token shaped strings and
 * registered secrets, so database capture and evidence bundling share one
 * secret pattern set.
 */
export function createRowRedactor({ sensitive = [], mode = "hash", secrets = [] } = {}) {
  assertMode(mode);

  const policy = normalizePolicy(sensitive);
  const policyEntries = Object.freeze(policy.map((entry) => entry.entry));
  const { redactText } = createRedactor({ secrets });

  function redactRow(entity, row) {
    if (typeof entity !== "string" || entity.length === 0) {
      throw invalidPolicy("invalid_entity", {
        field: "entity",
        accepted: "schema_qualified_string"
      });
    }

    if (!entity.includes(".")) {
      throw invalidPolicy("invalid_entity", {
        field: "entity",
        accepted: "schema_qualified_string"
      });
    }

    if (!isPlainObject(row)) {
      throw invalidPolicy("invalid_row", {
        field: "row",
        accepted: "plain_object"
      });
    }

    return Object.fromEntries(
      Object.entries(row).map(([column, value]) => {
        const redacted = shouldRedactColumn(policy, entity, column)
          ? redactSensitiveValue(value, mode)
          : redactSafeValue(value, redactText);

        return [column, redacted];
      })
    );
  }

  function describePolicy() {
    return Object.freeze({
      mode,
      sensitive: policyEntries
    });
  }

  return Object.freeze({
    redactRow,
    describePolicy
  });
}
