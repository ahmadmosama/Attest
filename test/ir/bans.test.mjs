import assert from "node:assert/strict";
import test from "node:test";

import { applyBans, BAN_RULES } from "../../src/ir/bans.mjs";
import { DiagnosticList, formatDiagnostic } from "../../src/ir/diagnostics.mjs";
import { parseScenarioFile, parseScenarioText } from "../../src/ir/parse.mjs";

const INVALID_CASES = Object.freeze([
  ["sleep_step.attest.yaml", "E_BANNED_SLEEP", 6],
  ["fixed_wait.attest.yaml", "E_BANNED_FIXED_WAIT", 6],
  ["platform_conditional.attest.yaml", "E_BANNED_CONDITIONAL", 6],
  ["selector_in_step.attest.yaml", "E_SELECTOR_IN_SCENARIO", 4],
  ["url_in_step.attest.yaml", "E_URL_IN_SCENARIO", 4],
  ["platform_name.attest.yaml", "E_PLATFORM_NAME_IN_SCENARIO", 6],
  ["unknown_op.attest.yaml", "E_UNKNOWN_OP", 4],
  ["wildcard_ignore.attest.yaml", "E_WILDCARD_ENTITY", 5],
  ["raw_no_reason.attest.yaml", "E_RAW_WITHOUT_REASON", 4]
]);

async function banDiagnosticsFor(fixture) {
  const result = await parseScenarioFile(`test/fixtures/scenarios/invalid/${fixture}`);
  const diagnostics = new DiagnosticList();

  applyBans(result.ast, diagnostics);
  return diagnostics.errors;
}

test("ban rules expose one stable code per banned construct", () => {
  assert.deepEqual(
    BAN_RULES.map((rule) => rule.code),
    INVALID_CASES.map(([, code]) => code)
  );
});

for (const [fixture, code, line] of INVALID_CASES) {
  test(`${fixture} is rejected with ${code} at the offending line`, async () => {
    const errors = await banDiagnosticsFor(fixture);

    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, code);
    assert.equal(errors[0].file, `test/fixtures/scenarios/invalid/${fixture}`);
    assert.equal(errors[0].line, line);
    assert(errors[0].col > 0);
    assert(errors[0].reason.length > 0);
    if (code === "E_UNKNOWN_OP") {
      assert.match(errors[0].reason, /"tapp"/);
      assert.match(errors[0].reason, /"tap"/);
    }
  });
}

test("formatDiagnostic includes file, line, column, code, and reason", async () => {
  const errors = await banDiagnosticsFor("sleep_step.attest.yaml");

  assert.equal(
    formatDiagnostic(errors[0]),
    "test/fixtures/scenarios/invalid/sleep_step.attest.yaml:6:14  E_BANNED_SLEEP  bounded convergence polling replaces sleep; sleep does not exist anywhere in the system"
  );
});

test("volatile_columns wildcards and template placeholders do not trip bans", () => {
  const text = `id: valid.negative_bans
requirement: [REQ-BAN-010]
suppressions:
  - kind: volatile_columns
    entity: "*"
    paths: [updated_at]
steps:
  - fill: { target: field:email, value: "{{tenant.email}}" }
  - fill: { target: field:card_number, value: "{{fixture.test_card}}" }
`;
  const result = parseScenarioText(text, { file: "negative.attest.yaml" });
  const diagnostics = new DiagnosticList();

  applyBans(result.ast, diagnostics);

  assert.equal(diagnostics.errors.length, 0);
});

test("canonical valid fixture produces zero ban diagnostics", async () => {
  const result = await parseScenarioFile("test/fixtures/scenarios/checkout_guest_purchase.attest.yaml");
  const diagnostics = new DiagnosticList();

  applyBans(result.ast, diagnostics);

  assert.equal(diagnostics.errors.length, 0);
});
