import assert from "node:assert/strict";
import test from "node:test";

import { AttestError, InfraError, UnsupportedOpError } from "../../src/errors.mjs";
import { classifyError } from "../../src/runtime/classify.mjs";
import { TimeoutError } from "../../src/runtime/timeout.mjs";

test("InfraError is an infra_error", () => {
  const result = classifyError(new InfraError("E_DB_DOWN", "database unavailable"));

  assert.equal(result.result, "infra_error");
  assert.equal(result.code, "E_DB_DOWN");
});

test("UnsupportedOpError is a scenario failure", () => {
  const result = classifyError(new UnsupportedOpError("E_UNSUPPORTED_OP", "unsupported"));

  assert.equal(result.result, "fail");
  assert.equal(result.code, "E_UNSUPPORTED_OP");
});

test("TimeoutError classification depends on timeout kind", () => {
  assert.equal(
    classifyError(new TimeoutError({ kind: "step", ms: 50, at: 1 })).result,
    "fail"
  );
  assert.equal(
    classifyError(new TimeoutError({ kind: "preflight", ms: 50, at: null })).result,
    "infra_error"
  );
});

test("adapter coded AttestErrors are infrastructure failures", () => {
  const result = classifyError(new AttestError("E_ADAPTER_START", "adapter failed"));

  assert.equal(result.result, "infra_error");
});

test("ordinary AttestErrors are scenario failures", () => {
  const result = classifyError(new AttestError("E_ASSERTION_FAILED", "missing text"));

  assert.equal(result.result, "fail");
});

test("unexpected harness bugs are infra_error and never pass", () => {
  const result = classifyError(new TypeError("x is not a function"));

  assert.equal(result.result, "infra_error");
  assert.equal(result.code, "E_UNEXPECTED");
  assert.equal(result.message, "x is not a function");
  assert.notEqual(result.result, "pass");
});
