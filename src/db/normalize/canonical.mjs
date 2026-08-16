import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import stableStringify from "json-stable-stringify";

import { AttestError } from "../../errors.mjs";

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isByteArray(value) {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function invalidRow() {
  return new AttestError("E_DB_ROW_INVALID", "Database row must be a plain object", {
    field: "row",
    accepted: "plain_object"
  });
}

function canonicalNumber(value) {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return null;
  }

  if (Object.is(value, -0)) {
    return 0;
  }

  return value;
}

function canonicalObject(value) {
  const entries = Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalValue(item)]);

  return Object.fromEntries(entries);
}

/**
 * Convert a database value into a deterministic JSON safe value.
 *
 * Driver specific objects are intentionally not walked. Their string form is a
 * stable boundary for the canonical stream without learning driver internals.
 */
export function canonicalValue(value) {
  if (value === undefined) {
    return null;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === "number") {
    return canonicalNumber(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (isByteArray(value)) {
    return {
      $bytes: Buffer.from(value).toString("base64")
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item));
  }

  if (isPlainObject(value)) {
    return canonicalObject(value);
  }

  return String(value);
}

export function canonicalRow(row) {
  if (!isPlainObject(row)) {
    throw invalidRow();
  }

  return canonicalObject(row);
}

export function fingerprintRow(row) {
  const serialised = stableStringify(canonicalRow(row));
  return createHash("sha256").update(serialised).digest("hex");
}
