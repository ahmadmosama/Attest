import assert from "node:assert/strict";
import test from "node:test";

import { AttestError } from "../../src/errors.mjs";
import { OP_CAPABILITIES } from "../../src/ir/ops.mjs";
import {
  ALL_CAPABILITIES,
  assertKnownCapability,
  DB_CAPABILITIES,
  isDbCapability,
  SURFACE_CAPABILITIES
} from "../../src/capabilities/registry.mjs";

test("the capability registry exports a closed frozen vocabulary", () => {
  assert.deepEqual(SURFACE_CAPABILITIES, [
    "file_upload",
    "network_control",
    "app_lifecycle",
    "permission_control",
    "clipboard_control",
    "clock_control",
    "raw_escape"
  ]);
  assert.deepEqual(DB_CAPABILITIES, ["db.delta_assertion", "db.bounded_polling"]);
  assert.deepEqual(ALL_CAPABILITIES, [...SURFACE_CAPABILITIES, ...DB_CAPABILITIES]);

  assert.throws(() => SURFACE_CAPABILITIES.push("teleport"));
  assert.throws(() => DB_CAPABILITIES.push("db.teleport"));
  assert.throws(() => ALL_CAPABILITIES.push("teleport"));
});

test("every capability referenced by the op vocabulary is registered", () => {
  for (const capabilities of Object.values(OP_CAPABILITIES)) {
    for (const capability of capabilities) {
      assert.equal(assertKnownCapability(capability), capability);
    }
  }
});

test("unknown capabilities throw a named AttestError", () => {
  assert.throws(
    () => assertKnownCapability("teleport"),
    (error) => error instanceof AttestError && error.code === "E_UNKNOWN_CAPABILITY"
  );
});

test("db capabilities are discriminated by prefix", () => {
  assert.equal(isDbCapability("db.delta_assertion"), true);
  assert.equal(isDbCapability("file_upload"), false);
});
