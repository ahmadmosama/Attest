import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { computeRequirementCoverage, renderCoverageReport } from "../../src/generate/coverage.mjs";
import { generateFromSpec, generateFromSpecs } from "../../src/generate/spec/generate.mjs";
import { parseRequirements, parseScenarioBlocks, parseSpec } from "../../src/generate/spec/parse.mjs";

const SPEC = [
  "# Checkout",
  "",
  "## Requirements",
  "",
  "- [ ] **CHK-001**: A guest can place an order without an account",
  "- [ ] **CHK-002**: The cart badge shows the number of items",
  "- [x] **CHK-003**: A declined card leaves the cart untouched",
  "",
  "## What CHK-001 means",
  "",
  "```attest",
  "# requirement: CHK-001",
  "steps:",
  "  - open: screen:checkout",
  "  - tap: button:place_order",
  "  - expect_visible: state:order_confirmed",
  "```",
  ""
].join("\n");

describe("reading a spec", () => {
  test("every stated requirement is found with the sentence that states it", () => {
    const requirements = parseRequirements(SPEC, { file: "SPEC.md" });

    assert.deepEqual(requirements.map((entry) => entry.id), ["CHK-001", "CHK-002", "CHK-003"]);
    assert.equal(requirements[0].statement, "A guest can place an order without an account");
    assert.equal(requirements[0].file, "SPEC.md");
    assert.equal(typeof requirements[0].line, "number");
  });

  test("a requirement stated twice is a spec bug and is refused", () => {
    // Silently keeping one of them would hide it.
    assert.throws(
      () => parseRequirements(["- [ ] **CHK-001**: first", "- [ ] **CHK-001**: second"].join("\n")),
      { code: "E_SPEC_PARSE_INVALID" }
    );
  });

  test("an attest block carries the requirements it declares it covers", () => {
    const [block] = parseScenarioBlocks(SPEC, { file: "SPEC.md" });

    assert.deepEqual(block.requirements, ["CHK-001"]);
    assert.match(block.body, /open: screen:checkout/u);
    // The directive itself is not part of the scenario body.
    assert.doesNotMatch(block.body, /# requirement/u);
  });

  test("an unterminated block is refused rather than half read", () => {
    assert.throws(() => parseScenarioBlocks(["```attest", "steps:"].join("\n")), {
      code: "E_SPEC_PARSE_INVALID"
    });
  });

  test("a block claiming a requirement the document never states is reported", () => {
    const spec = parseSpec(
      ["- [ ] **CHK-001**: stated", "```attest", "# requirement: CHK-999", "steps:", "  - back", "```"].join("\n")
    );

    // The whole value of the link is that it points somewhere real.
    assert.deepEqual(spec.danglingLinks.map((entry) => entry.id), ["CHK-999"]);
  });
});

describe("generating from declared intent", () => {
  test("a declared scenario is emitted, linked, and compiles", () => {
    const result = generateFromSpec(SPEC, { file: "SPEC.md" });

    assert.equal(result.scenarios.length, 1);
    const [scenario] = result.scenarios;
    assert.deepEqual(scenario.ir.requirements, ["CHK-001"]);
    assert.match(scenario.text, /^requirement: \[CHK-001\]$/mu);
    // Validated through the real compiler before it is written: a generated
    // file that does not compile looks like coverage and is not.
    assert.equal(scenario.ir.steps.length, 3);
  });

  test("everything emitted is marked proposed, in the file and in the IR", () => {
    const [scenario] = generateFromSpec(SPEC, { file: "SPEC.md" }).scenarios;

    // In the file itself, not only in its path. A proposal copied elsewhere is
    // still a proposal.
    assert.match(scenario.text, /^proposed: true$/mu);
    assert.equal(scenario.ir.proposed, true);
  });

  test("a requirement stated only in prose is reported uncovered, never invented", () => {
    const result = generateFromSpec(SPEC, { file: "SPEC.md" });

    // This is the whole of GEN-05. Inventing steps from prose would be
    // recording a guess and calling it intent.
    const ungrounded = result.ungrounded.filter((entry) => entry.reason === "no_declared_scenario");
    assert.deepEqual(ungrounded.map((entry) => entry.requirement), ["CHK-002", "CHK-003"]);
    assert.match(ungrounded[0].remediation, /will not invent steps from prose/u);
  });

  test("declared steps with no requirement are reported, not emitted", () => {
    const result = generateFromSpec(
      ["- [ ] **CHK-001**: stated", "```attest", "steps:", "  - back", "```"].join("\n")
    );

    assert.equal(result.scenarios.length, 0);
    assert.equal(result.ungrounded.some((entry) => entry.reason === "no_requirement_declared"), true);
  });

  test("a block that does not compile is rejected with its diagnostics, never written", () => {
    const result = generateFromSpec(
      [
        "- [ ] **CHK-001**: stated",
        "```attest",
        "# requirement: CHK-001",
        "steps:",
        "  - sleep: 500",
        "```"
      ].join("\n")
    );

    assert.equal(result.scenarios.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reason, "does_not_compile");
    assert(result.rejected[0].diagnostics.length > 0);
  });

  test("generation across documents reports coverage over all of them", () => {
    const result = generateFromSpecs([
      { file: "SPEC.md", text: SPEC },
      { file: "OTHER.md", text: "- [ ] **OTH-001**: something else" }
    ]);

    assert.equal(result.coverage.counts.stated, 4);
    assert.deepEqual(result.coverage.covered, ["CHK-001"]);
    assert.deepEqual(
      result.coverage.uncovered.map((entry) => entry.id),
      ["CHK-002", "CHK-003", "OTH-001"]
    );
  });
});

describe("the uncovered report is the actual product", () => {
  test("existing hand written scenarios count as coverage", () => {
    const coverage = computeRequirementCoverage({
      requirements: [{ id: "CHK-001", statement: "stated" }, { id: "CHK-002", statement: "also stated" }],
      scenarios: [{ id: "checkout.guest", requirement: ["CHK-001"] }]
    });

    assert.deepEqual(coverage.covered, ["CHK-001"]);
    assert.deepEqual(coverage.uncovered.map((entry) => entry.id), ["CHK-002"]);
    assert.deepEqual(coverage.byRequirement, { "CHK-001": ["checkout.guest"] });
  });

  test("a scenario claiming a requirement no spec states is reported as unknown", () => {
    // Either the spec moved and the scenario did not, or the ID is a typo.
    // Both are worth seeing: a scenario linked to nothing proves nothing.
    const coverage = computeRequirementCoverage({
      requirements: [{ id: "CHK-001" }],
      scenarios: [{ id: "checkout.stale", requirement: ["CHK-404"] }]
    });

    assert.deepEqual(coverage.unknown, [{ id: "CHK-404", scenarios: ["checkout.stale"] }]);
    assert.equal(coverage.counts.unknown, 1);
  });

  test("the report is deterministic, so it diffs cleanly in review", () => {
    const input = {
      requirements: [{ id: "B-002" }, { id: "A-001" }, { id: "C-003" }],
      scenarios: [{ id: "two", requirement: ["C-003"] }, { id: "one", requirement: ["C-003"] }]
    };

    const first = computeRequirementCoverage(input);
    const second = computeRequirementCoverage(input);

    assert.deepEqual(first, second);
    assert.deepEqual(first.uncovered.map((entry) => entry.id), ["A-001", "B-002"]);
    assert.deepEqual(first.byRequirement["C-003"], ["one", "two"]);
  });

  test("the rendered report names the gap rather than implying it", () => {
    const text = renderCoverageReport(
      computeRequirementCoverage({
        requirements: [{ id: "CHK-001", statement: "A guest can place an order" }],
        scenarios: []
      })
    );

    assert.match(text, /1 stated, 0 covered, 1 uncovered/u);
    assert.match(text, /uncovered CHK-001: A guest can place an order/u);
  });
});
