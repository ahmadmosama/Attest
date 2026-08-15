import assert from "node:assert/strict";
import test from "node:test";

import { formatDiagnostic } from "../../src/ir/diagnostics.mjs";
import { parseScenarioFile, parseScenarioText, positionOf } from "../../src/ir/parse.mjs";

const CANONICAL_FIXTURE = "test/fixtures/scenarios/checkout_guest_purchase.attest.yaml";
const MALFORMED_FIXTURE = "test/fixtures/scenarios/malformed.attest.yaml";

test("canonical fixture parses into an AST with no diagnostics", async () => {
  const result = await parseScenarioFile(CANONICAL_FIXTURE);

  assert.equal(result.diagnostics.ok, true);
  assert.equal(result.ast.file, CANONICAL_FIXTURE);
  assert.equal(result.ast.value.id, "checkout.guest_purchase");
  assert.equal(result.ast.pos.line, 1);
  assert.equal(result.ast.pos.col, 1);
});

test("every canonical step has a source position", async () => {
  const { ast } = await parseScenarioFile(CANONICAL_FIXTURE);

  for (const [index, step] of ast.value.steps.entries()) {
    const opName = Object.keys(step)[0];
    const stepPos = ast.positionOf(["steps", index]);
    const opPos = ast.positionOf(["steps", index, opName]);

    assert.equal(stepPos.file, CANONICAL_FIXTURE);
    assert.equal(opPos.file, CANONICAL_FIXTURE);
    assert(stepPos.line > 0, `step ${index}`);
    assert(opPos.line > 0, `step ${index}.${opName}`);
    assert(opPos.col > 0, `step ${index}.${opName}`);
  }
});

test("YAML syntax errors become positioned diagnostics", async () => {
  const result = await parseScenarioFile(MALFORMED_FIXTURE);

  assert.equal(result.ast, null);
  assert.equal(result.diagnostics.ok, false);
  assert.equal(result.diagnostics.errors[0].code, "E_YAML_SYNTAX");
  assert.equal(result.diagnostics.errors[0].line, 3);
  assert.match(formatDiagnostic(result.diagnostics.errors[0]), /^test\/fixtures\/scenarios\/malformed/);
});

test("duplicate mapping keys are diagnostics, not last write wins", () => {
  const text = `id: duplicate.keys
id: duplicate.other
requirement: [REQ-DUP-001]
steps:
  - open: screen:catalog
`;

  const result = parseScenarioText(text, { file: "duplicate.attest.yaml" });

  assert.equal(result.ast, null);
  assert.equal(result.diagnostics.errors[0].code, "E_YAML_SYNTAX");
  assert.equal(result.diagnostics.errors[0].line, 2);
});

test("schema failures become one positioned diagnostic per zod issue", () => {
  const text = `id: bad.schema
requirement: [REQ-BAD-001]
steps:
  - fill: { target: "#email", value: "{{tenant.email}}" }
`;

  const result = parseScenarioText(text, { file: "bad.attest.yaml" });

  assert.equal(result.diagnostics.ok, false);
  assert.equal(result.diagnostics.errors[0].code, "E_SCHEMA");
  assert.deepEqual(result.diagnostics.errors[0].path, ["steps", 0, "fill", "target"]);
  assert.equal(result.diagnostics.errors[0].line, 4);
  assert(result.diagnostics.errors[0].col > 0);
});

test("missing scenario files return E_SCENARIO_NOT_FOUND", async () => {
  const result = await parseScenarioFile("test/fixtures/scenarios/missing.attest.yaml");

  assert.equal(result.ast, null);
  assert.equal(result.diagnostics.errors[0].code, "E_SCENARIO_NOT_FOUND");
  assert.equal(result.diagnostics.errors[0].line, 1);
  assert.equal(result.diagnostics.errors[0].col, 1);
});

test("anchors and aliases are rejected before toJS", () => {
  const text = `id: anchor.alias
requirement: [REQ-ANCHOR-001]
steps:
  - open: &catalog screen:catalog
  - tap: *catalog
`;

  const result = parseScenarioText(text, { file: "alias.attest.yaml" });
  const codes = result.diagnostics.errors.map((diagnostic) => diagnostic.code);

  assert.equal(result.diagnostics.ok, false);
  assert(codes.every((code) => code === "E_YAML_UNSUPPORTED"));
  assert(codes.length >= 2);
});

test("positionOf falls back to nearest parent position", async () => {
  const { ast } = await parseScenarioFile(CANONICAL_FIXTURE);
  const expected = ast.positionOf(["steps", 0, "open"]);

  assert.deepEqual(positionOf(ast.positions, ["steps", 0, "open", "missing"]), expected);
});
