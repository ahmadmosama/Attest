import assert from "node:assert/strict";
import test from "node:test";
import { create } from "xmlbuilder2";

import { createRunRecord } from "../../src/report/run-record.mjs";
import { toJUnitXml } from "../../src/report/junit.mjs";

const HASH = "b".repeat(64);

function error(code) {
  return { code, message: "failed", details: {} };
}

function step(index, status, code = "E_STEP_FAILED") {
  return {
    index,
    kind: "tap",
    status,
    durationMs: 10,
    error: status === "pass" ? null : error(code),
    evidence: []
  };
}

function scenario(overrides) {
  return {
    id: "checkout.guest_purchase",
    surface: "web",
    result: "pass",
    durationMs: 20,
    requirements: ["RUN-04"],
    planHash: HASH,
    planPath: "scenarios/checkout.guest_purchase__web/plan.json",
    rawOpUses: 0,
    skipped: null,
    error: null,
    steps: [step(0, "pass")],
    ...overrides
  };
}

function record() {
  return createRunRecord({
    runId: "20260815T044612Z-9f3a1c07",
    startedAt: "2026-08-15T04:46:12.000Z",
    finishedAt: "2026-08-15T04:46:13.000Z",
    durationMs: 1000,
    attestVersion: "0.1.0",
    node: { version: "v24.13.0", platform: "win32" },
    filters: { ids: [], tags: [], surfaces: [], headed: false, dryRun: false },
    artifactDir: "artifacts/20260815T044612Z-9f3a1c07",
    hashes: { bindings: { web: HASH }, ruleset: null },
    telemetry: { timeouts: 0, retries: 0, convergeMs: [] },
    scenarios: [
      scenario({ id: "quote.\"<&", result: "fail", steps: [step(2, "fail", "E_ASSERT")] }),
      scenario({
        id: "checkout.skip",
        result: "skipped",
        skipped: { capabilities: ["web.camera"] },
        steps: [step(0, "skipped")]
      }),
      scenario({
        id: "checkout.driver",
        surface: "android",
        result: "infra_error",
        error: error("E_ADB"),
        steps: [step(0, "timed_out", "E_ADB")]
      })
    ]
  });
}

function testcasesByName(xml) {
  const suites = create(xml).end({ format: "object" }).testsuites.testsuite;
  const cases = suites.flatMap((suite) => (Array.isArray(suite.testcase) ? suite.testcase : [suite.testcase]));

  return new Map(cases.map((testcase) => [decodeXmlAttribute(testcase["@name"]), testcase]));
}

function decodeXmlAttribute(value) {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

test("toJUnitXml projects counts onto a testsuites root", () => {
  const xml = toJUnitXml(record());
  const parsed = create(xml).end({ format: "object" }).testsuites;

  assert.equal(parsed["@tests"], "3");
  assert.equal(parsed["@failures"], "1");
  assert.equal(parsed["@errors"], "1");
  assert.equal(parsed["@skipped"], "1");
});

test("toJUnitXml writes one suite per surface and one testcase per scenario", () => {
  const xml = toJUnitXml(record());
  const parsed = create(xml).end({ format: "object" }).testsuites.testsuite;

  assert.equal(parsed[0]["@name"], "android");
  assert.equal(parsed[0].testcase["@classname"], "android");
  assert.equal(parsed[0].testcase["@name"], "checkout.driver");
  assert.equal(parsed[1]["@name"], "web");
  assert.equal(parsed[1].testcase.length, 2);
});

test("toJUnitXml distinguishes failure, skipped, and infrastructure error", () => {
  const xml = toJUnitXml(record());
  const cases = testcasesByName(xml);
  const androidCase = cases.get("checkout.driver");
  const failedCase = cases.get("quote.\"<&");
  const skippedCase = cases.get("checkout.skip");

  assert.equal(failedCase.failure["@type"], "E_ASSERT");
  assert.match(failedCase.failure["@message"], /step 2 E_ASSERT/);
  assert.equal(skippedCase.skipped["@message"], "web.camera");
  assert.equal(androidCase.error["@type"], "E_ADB");
});

test("toJUnitXml escapes special characters and is stable", () => {
  const runRecord = record();
  const left = toJUnitXml(runRecord);
  const right = toJUnitXml(runRecord);
  const testcase = testcasesByName(left).get("quote.\"<&");

  assert.equal(left, right);
  assert.match(left, /quote\.&quot;&lt;&amp;/);
  assert.equal(decodeXmlAttribute(testcase["@name"]), "quote.\"<&");
});
