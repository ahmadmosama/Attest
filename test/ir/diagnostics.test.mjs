import assert from "node:assert/strict";
import test from "node:test";

import { AttestError } from "../../src/errors.mjs";
import {
  createDiagnostic,
  DiagnosticList,
  formatDiagnostic
} from "../../src/ir/diagnostics.mjs";

test("createDiagnostic returns a frozen positioned error by default", () => {
  const diagnostic = createDiagnostic({
    file: "a.yaml",
    line: 14,
    col: 7,
    code: "E_X",
    reason: "because"
  });

  assert.deepEqual(diagnostic, {
    file: "a.yaml",
    line: 14,
    col: 7,
    code: "E_X",
    reason: "because",
    severity: "error",
    path: []
  });
  assert(Object.isFrozen(diagnostic));
  assert(Object.isFrozen(diagnostic.path));
  assert.throws(() => {
    diagnostic.reason = "changed";
  });
});

test("createDiagnostic rejects useless diagnostics", () => {
  const valid = {
    file: "a.yaml",
    line: 14,
    col: 7,
    code: "E_X",
    reason: "because"
  };

  assert.throws(() => createDiagnostic({ ...valid, code: "" }), TypeError);
  assert.throws(() => createDiagnostic({ ...valid, reason: " " }), TypeError);
  assert.throws(() => createDiagnostic({ ...valid, line: 0 }), TypeError);
  assert.throws(() => createDiagnostic({ ...valid, col: 1.5 }), TypeError);
});

test("formatDiagnostic renders the stable CLI form", () => {
  const diagnostic = createDiagnostic({
    file: "a.yaml",
    line: 14,
    col: 7,
    code: "E_X",
    reason: "because"
  });

  assert.equal(formatDiagnostic(diagnostic), "a.yaml:14:7  E_X  because");
});

test("DiagnosticList accumulates and throws all errors at once", () => {
  const diagnostics = new DiagnosticList();
  diagnostics.add({
    file: "a.yaml",
    line: 1,
    col: 1,
    code: "E_ONE",
    reason: "first"
  });
  diagnostics.add({
    file: "a.yaml",
    line: 2,
    col: 1,
    code: "W_ONE",
    reason: "warning",
    severity: "warning"
  });

  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.all.length, 2);
  assert.equal(diagnostics.errors.length, 1);
  assert(Object.isFrozen(diagnostics.all));
  assert(Object.isFrozen(diagnostics.errors));

  assert.throws(
    () => diagnostics.throwIfErrors(),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_SCENARIO_INVALID" &&
      Object.isFrozen(error.details.diagnostics) &&
      error.details.diagnostics.length === 1
  );
});

test("DiagnosticList ok ignores warning severity entries", () => {
  const diagnostics = new DiagnosticList([
    {
      file: "a.yaml",
      line: 1,
      col: 1,
      code: "W_ONE",
      reason: "warning",
      severity: "warning"
    }
  ]);

  assert.equal(diagnostics.ok, true);
  assert.doesNotThrow(() => diagnostics.throwIfErrors());
});

test("DiagnosticList JSON output round trips unchanged", () => {
  const diagnostics = new DiagnosticList([
    {
      file: "a.yaml",
      line: 1,
      col: 2,
      code: "E_X",
      reason: "because",
      path: ["steps", 0, "open"]
    }
  ]);

  const json = diagnostics.toJSON();

  assert.deepEqual(JSON.parse(JSON.stringify(json)), json);
});
