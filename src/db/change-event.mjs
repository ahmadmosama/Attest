import stableStringify from "json-stable-stringify";

import { AttestError } from "../errors.mjs";
import { canonicalRow, canonicalValue } from "./normalize/canonical.mjs";

export const CHANGE_OPS = Object.freeze(["insert", "update", "delete"]);
export const ACTOR_KINDS = Object.freeze(["app_session", "harness", "external", "unknown"]);
export const FIDELITY_LEVELS = Object.freeze(["full", "key_only", "value_only"]);

const ROW_OR_NULL = Object.freeze(["plain_object", null]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidEvent(field, accepted) {
  return new AttestError("E_CHANGE_EVENT_INVALID", "Invalid database change event", {
    field,
    accepted
  });
}

function assertInput(value) {
  if (!isPlainObject(value)) {
    throw invalidEvent("event", "plain_object");
  }
}

function assertSchemaQualifiedEntity(value) {
  if (typeof value !== "string" || value.length === 0 || !value.includes(".")) {
    throw invalidEvent("entity", "schema_qualified_string");
  }
}

function assertEnum(value, field, accepted) {
  if (!accepted.includes(value)) {
    throw invalidEvent(field, accepted);
  }
}

function assertNullableString(value, field) {
  if (value !== null && typeof value !== "string") {
    throw invalidEvent(field, Object.freeze(["string", null]));
  }
}

function assertNullableInteger(value, field) {
  if (value !== null && (!Number.isInteger(value) || !Number.isSafeInteger(value))) {
    throw invalidEvent(field, Object.freeze(["safe_integer", null]));
  }
}

function assertPath(path, field) {
  if (!Array.isArray(path) || path.length === 0 || path.some((segment) => typeof segment !== "string")) {
    throw invalidEvent(field, "array_of_strings");
  }
}

function normalizePaths(paths) {
  if (!Array.isArray(paths)) {
    throw invalidEvent("paths", "array_of_string_arrays");
  }

  return paths.map((path, index) => {
    assertPath(path, `paths[${index}]`);
    return path.slice();
  });
}

function canonicalNullableRow(value, field) {
  if (value === null) {
    return null;
  }

  if (!isPlainObject(value)) {
    throw invalidEvent(field, ROW_OR_NULL);
  }

  return canonicalRow(value);
}

function canonicalKey(value) {
  if (!isPlainObject(value)) {
    throw invalidEvent("key", "plain_object");
  }

  return canonicalRow(value);
}

function normalizeActor(actor) {
  if (!isPlainObject(actor)) {
    throw invalidEvent("actor", "plain_object");
  }

  assertEnum(actor.kind, "actor.kind", ACTOR_KINDS);
  return { ...actor };
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

function readPath(root, path) {
  let current = root;
  for (const segment of path) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function canonicalComparable(value) {
  return stableStringify(canonicalValue(value));
}

function ownColumnPaths(row) {
  if (!isPlainObject(row)) {
    return [];
  }

  return Object.keys(row)
    .toSorted((left, right) => left.localeCompare(right))
    .map((key) => [key]);
}

function assertChangeEventFields(input) {
  assertInput(input);
  assertSchemaQualifiedEntity(input.entity);
  assertEnum(input.op, "op", CHANGE_OPS);
  assertNullableString(input.txId, "txId");
  assertNullableInteger(input.seq, "seq");
  assertEnum(input.fidelity, "fidelity", FIDELITY_LEVELS);
  normalizePaths(input.paths);
  normalizeActor(input.actor);
  canonicalKey(input.key);
  canonicalNullableRow(input.before, "before");
  canonicalNullableRow(input.after, "after");
}

/**
 * Construct the canonical database change stream event.
 *
 * fidelity is load bearing. It is how a driver says the capture strategy cannot
 * answer which columns changed, such as Postgres without REPLICA IDENTITY FULL.
 * Downstream classifiers must consume that claim instead of inferring that a
 * partial event is complete.
 */
export function createChangeEvent(input) {
  assertInput(input);
  assertSchemaQualifiedEntity(input.entity);
  assertEnum(input.op, "op", CHANGE_OPS);
  assertNullableString(input.txId, "txId");
  assertNullableInteger(input.seq, "seq");
  assertEnum(input.fidelity, "fidelity", FIDELITY_LEVELS);

  const key = canonicalKey(input.key);
  const paths = normalizePaths(input.paths);
  const before = canonicalNullableRow(input.before, "before");
  const after = canonicalNullableRow(input.after, "after");
  const actor = normalizeActor(input.actor);

  return deepFreeze({
    entity: input.entity,
    key,
    op: input.op,
    paths,
    before,
    after,
    txId: input.txId,
    seq: input.seq,
    actor,
    fidelity: input.fidelity
  });
}

export function isChangeEvent(value) {
  try {
    assertChangeEventFields(value);
    return Object.isFrozen(value);
  } catch {
    return false;
  }
}

export function changedPaths(event) {
  if (!isChangeEvent(event)) {
    throw invalidEvent("event", "ChangeEvent");
  }

  if (event.op === "insert") {
    return deepFreeze(ownColumnPaths(event.after));
  }

  return deepFreeze(
    event.paths
      .filter((path) => canonicalComparable(readPath(event.before, path)) !== canonicalComparable(readPath(event.after, path)))
      .map((path) => path.slice())
  );
}
