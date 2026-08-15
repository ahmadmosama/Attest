import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { compileScenarioFile, compileScenarioText } from "../../src/ir/compile.mjs";
import { formatDiagnostic } from "../../src/ir/diagnostics.mjs";

const CANONICAL_FIXTURE = "test/fixtures/scenarios/checkout_guest_purchase.attest.yaml";
const INVALID_CASES = Object.freeze([
  ["sleep_step.attest.yaml", "E_BANNED_SLEEP"],
  ["fixed_wait.attest.yaml", "E_BANNED_FIXED_WAIT"],
  ["platform_conditional.attest.yaml", "E_BANNED_CONDITIONAL"],
  ["selector_in_step.attest.yaml", "E_SELECTOR_IN_SCENARIO"],
  ["url_in_step.attest.yaml", "E_URL_IN_SCENARIO"],
  ["platform_name.attest.yaml", "E_PLATFORM_NAME_IN_SCENARIO"],
  ["unknown_op.attest.yaml", "E_UNKNOWN_OP"],
  ["wildcard_ignore.attest.yaml", "E_WILDCARD_ENTITY"],
  ["raw_no_reason.attest.yaml", "E_RAW_WITHOUT_REASON"]
]);

test("compileScenarioFile returns a frozen IR for the canonical fixture", async () => {
  const result = await compileScenarioFile(CANONICAL_FIXTURE);

  assert.equal(result.diagnostics.ok, true);
  assert.equal(Object.isFrozen(result.ir), true);
  assert.equal(Object.isFrozen(result.ir.steps[0]), true);
});

test("compileScenarioFile returns the expected ban code for every invalid fixture", async () => {
  for (const [fixture, code] of INVALID_CASES) {
    const result = await compileScenarioFile(`test/fixtures/scenarios/invalid/${fixture}`);

    assert.equal(result.ir, null, fixture);
    assert(result.diagnostics.errors.some((diagnostic) => diagnostic.code === code), fixture);
  }
});

test("every banned construct formats with file, line, and reason", async () => {
  for (const [fixture, code] of INVALID_CASES) {
    const result = await compileScenarioFile(`test/fixtures/scenarios/invalid/${fixture}`);
    const diagnostic = result.diagnostics.errors.find((item) => item.code === code);
    const formatted = formatDiagnostic(diagnostic);

    assert.match(formatted, new RegExp(`^test/fixtures/scenarios/invalid/${fixture}:\\d+:\\d+  ${code}  .+`));
    assert(diagnostic.line > 0);
    assert(diagnostic.reason.length > 0);
  }
});

test("compile module does not import fs write APIs", async () => {
  const source = await readFile("src/ir/compile.mjs", "utf8");

  assert.doesNotMatch(source, /\bwriteFile\b|\bappendFile\b|\bcreateWriteStream\b/);
});

test("scenario text over 1 MiB is refused before validation", () => {
  const largeText = `id: too.large
requirement: [REQ-BIG-001]
steps:
  - open: screen:catalog
notes: ${"x".repeat(1024 * 1024)}
`;
  const result = compileScenarioText(largeText, { file: "too_large.attest.yaml" });

  assert.equal(result.ir, null);
  assert.equal(result.diagnostics.errors[0].code, "E_SCENARIO_TOO_LARGE");
});
