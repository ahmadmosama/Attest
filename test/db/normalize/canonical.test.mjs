import assert from "node:assert/strict";
import test from "node:test";

import { AttestError } from "../../../src/errors.mjs";
import {
  canonicalRow,
  canonicalValue,
  fingerprintRow
} from "../../../src/db/normalize/canonical.mjs";

test("objects with the same entries canonicalise identically across key order", () => {
  assert.deepEqual(canonicalRow({ b: 2, a: 1 }), canonicalRow({ a: 1, b: 2 }));
  assert.equal(fingerprintRow({ b: 2, a: 1 }), fingerprintRow({ a: 1, b: 2 }));
});

test("nested objects are sorted recursively and array order is preserved", () => {
  const left = canonicalValue({ z: [{ b: 2, a: 1 }], a: "x" });
  const right = canonicalValue({ a: "x", z: [{ a: 1, b: 2 }] });

  assert.deepEqual(left, right);
  assert.notDeepEqual(canonicalValue(["a", "b"]), canonicalValue(["b", "a"]));
});

test("dates canonicalise to ISO 8601 strings with millisecond precision", () => {
  assert.equal(canonicalValue(new Date("2026-08-16T10:11:12.123Z")), "2026-08-16T10:11:12.123Z");
});

test("buffer and uint8array values canonicalise to base64 byte objects", () => {
  assert.deepEqual(canonicalValue(Buffer.from("abc")), { $bytes: "YWJj" });
  assert.deepEqual(canonicalValue(new Uint8Array([97, 98, 99])), { $bytes: "YWJj" });
});

test("bigint and numeric edge values are stable", () => {
  assert.equal(canonicalValue(12n), "12");
  assert.equal(Object.is(canonicalValue(-0), -0), false);
  assert.equal(canonicalValue(-0), 0);
  assert.equal(canonicalValue(Number.NaN), null);
});

test("undefined canonicalises to null", () => {
  assert.equal(canonicalValue(undefined), null);
  assert.deepEqual(canonicalRow({ missing: undefined }), { missing: null });
});

test("foreign prototypes are stringified instead of traversed", () => {
  class DriverValue {
    toString() {
      return "driver-value";
    }
  }

  assert.equal(canonicalValue(new DriverValue()), "driver-value");
});

test("canonicalRow rejects non plain rows", () => {
  assert.throws(
    () => canonicalRow(null),
    (error) => error instanceof AttestError && error.code === "E_DB_ROW_INVALID"
  );
  assert.throws(
    () => canonicalRow([]),
    (error) => error instanceof AttestError && error.code === "E_DB_ROW_INVALID"
  );
});

test("fingerprintRow is stable and returns lowercase sha256 hex", () => {
  const first = fingerprintRow({ nested: { z: 1, a: 2 }, id: 7 });
  const second = fingerprintRow({ id: 7, nested: { a: 2, z: 1 } });

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});
