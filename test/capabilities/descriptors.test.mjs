import assert from "node:assert/strict";
import test from "node:test";

import { AttestError } from "../../src/errors.mjs";
import { defineDbCapabilities, NOT_IMPLEMENTED_DB_CAPS } from "../../src/capabilities/db-caps.mjs";
import { defineSurfaceCapabilities } from "../../src/capabilities/surface-caps.mjs";

function postgresCaps(overrides = {}) {
  return defineDbCapabilities({
    driver: "postgres",
    capture: "logical_slot",
    deltaAssertion: true,
    boundedPolling: true,
    beforeImages: "full",
    ordering: true,
    txAttribution: true,
    watermarkFencing: "inline",
    transactionalTeardown: true,
    ...overrides
  });
}

test("surface descriptors are frozen and expose capability lookup", () => {
  const descriptor = defineSurfaceCapabilities({
    surface: "web",
    supports: ["file_upload", "clock_control"]
  });

  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.supports), true);
  assert.equal(descriptor.has("file_upload"), true);
  assert.equal(descriptor.has("app_lifecycle"), false);

  assert.throws(() => {
    descriptor.surface = "android";
  });
  assert.throws(() => descriptor.supports.push("raw_escape"));
});

test("surface descriptors reject unknown capabilities before returning", () => {
  assert.throws(
    () => defineSurfaceCapabilities({ surface: "web", supports: ["teleport"] }),
    (error) => error instanceof AttestError && error.code === "E_UNKNOWN_CAPABILITY"
  );
});

test("surface descriptors cannot claim database capabilities", () => {
  assert.throws(
    () => defineSurfaceCapabilities({ surface: "web", supports: ["db.delta_assertion"] }),
    (error) => error instanceof AttestError && error.code === "E_BAD_CAPABILITY_DESCRIPTOR"
  );
});

test("database descriptors derive db capabilities from feature flags", () => {
  const postgres = postgresCaps();
  const bigquery = postgresCaps({
    driver: "bigquery",
    capture: "none",
    deltaAssertion: false,
    boundedPolling: true,
    beforeImages: "none",
    ordering: false,
    txAttribution: false,
    watermarkFencing: "none",
    transactionalTeardown: false
  });

  assert.equal(postgres.has("db.delta_assertion"), true);
  assert.equal(postgres.has("db.bounded_polling"), true);
  assert.deepEqual(postgres.supports, ["db.delta_assertion", "db.bounded_polling"]);
  assert.equal(bigquery.has("db.delta_assertion"), false);
  assert.equal(bigquery.has("db.bounded_polling"), true);
  assert.deepEqual(bigquery.supports, ["db.bounded_polling"]);
});

test("descriptor degraded entries are kept and frozen", () => {
  const descriptor = postgresCaps({
    degraded: ["before images unavailable, using key only"]
  });

  assert.deepEqual(descriptor.degraded, ["before images unavailable, using key only"]);
  assert.equal(Object.isFrozen(descriptor.degraded), true);
  assert.throws(() => descriptor.degraded.push("silent fallback"));
});

test("database descriptors reject out of range enum values with accepted values", () => {
  assert.throws(
    () => postgresCaps({ capture: "mirror" }),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_BAD_CAPABILITY_DESCRIPTOR" &&
      error.details.field === "capture" &&
      error.details.accepted.includes("logical_slot") &&
      error.details.accepted.includes("none")
  );
});

test("database descriptor mutation throws in strict mode", () => {
  const descriptor = postgresCaps();

  assert.throws(() => {
    descriptor.capture = "none";
  });
  assert.throws(() => descriptor.supports.push("db.other"));
});

test("not implemented database capabilities declare no support honestly", () => {
  assert.equal(NOT_IMPLEMENTED_DB_CAPS.driver, "none");
  assert.equal(NOT_IMPLEMENTED_DB_CAPS.capture, "none");
  assert.equal(NOT_IMPLEMENTED_DB_CAPS.deltaAssertion, false);
  assert.equal(NOT_IMPLEMENTED_DB_CAPS.boundedPolling, false);
  assert.deepEqual(NOT_IMPLEMENTED_DB_CAPS.supports, []);
});
