import assert from "node:assert/strict";
import test from "node:test";

import { AttestError } from "../../src/errors.mjs";
import { DB_PORT_METHODS, assertImplementsDbPort } from "../../src/db/port.mjs";
import { SURFACE_PORT_METHODS, assertImplementsSurfacePort } from "../../src/surfaces/port.mjs";

function functionsFor(methods, overrides = {}) {
  return Object.fromEntries(methods.map((method) => [method, overrides[method] ?? (() => {})]));
}

test("surface port validator reports every missing method", () => {
  assert.throws(
    () => assertImplementsSurfacePort({}),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_BAD_ADAPTER" &&
      assert.deepEqual(error.details.missing, SURFACE_PORT_METHODS) === undefined
  );
});

test("surface port validator accepts objects exposing all methods", () => {
  assert.doesNotThrow(() => assertImplementsSurfacePort(functionsFor(SURFACE_PORT_METHODS)));
});

test("surface port validator treats non functions as missing", () => {
  assert.throws(
    () => assertImplementsSurfacePort(functionsFor(SURFACE_PORT_METHODS, { execute: true })),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_BAD_ADAPTER" &&
      assert.deepEqual(error.details.missing, ["execute"]) === undefined
  );
});

test("database port validator mirrors the surface port behavior", () => {
  assert.throws(
    () => assertImplementsDbPort({}),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_BAD_ADAPTER" &&
      assert.deepEqual(error.details.missing, DB_PORT_METHODS) === undefined
  );

  assert.doesNotThrow(() => assertImplementsDbPort(functionsFor(DB_PORT_METHODS)));

  assert.throws(
    () => assertImplementsDbPort(functionsFor(DB_PORT_METHODS, { poll: "later" })),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_BAD_ADAPTER" &&
      assert.deepEqual(error.details.missing, ["poll"]) === undefined
  );
});

test("port method lists are frozen", () => {
  assert.throws(() => SURFACE_PORT_METHODS.push("noop"));
  assert.throws(() => DB_PORT_METHODS.push("noop"));
});
