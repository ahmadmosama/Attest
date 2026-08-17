import assert from "node:assert/strict";
import test from "node:test";

import { computeKillRate, KILL_RATE_VERSION } from "../../src/selfverify/killrate.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function baseline() {
  return Object.freeze({ outcome: "passed", exitCode: 0, reason: "passed" });
}

function result(mutantId, outcome) {
  return Object.freeze({ mutantId, outcome, exitCode: outcome === "survived" ? 0 : 1, reason: outcome });
}

test("computeKillRate excludes errors from the denominator", () => {
  const report = computeKillRate({
    baseline: baseline(),
    results: [
      result("one", "killed"),
      result("two", "killed"),
      result("three", "survived"),
      result("four", "error")
    ],
    corpusHash: HASH_A,
    rulesetHash: HASH_B,
    fixtureTreeHash: HASH_C
  });

  assert.equal(report.version, KILL_RATE_VERSION);
  assert.deepEqual(report.counts, {
    total: 4,
    killed: 2,
    survived: 1,
    errored: 1,
    scored: 3
  });
  assert.equal(report.rate, 2 / 3);
  assert.equal(report.ratePercent, 66.67);
  assert.equal(report.confidence, "degraded");
});

test("computeKillRate records the hashes that produced the number", () => {
  const report = computeKillRate({
    baseline: baseline(),
    results: [result("one", "survived")],
    corpusHash: HASH_A,
    rulesetHash: HASH_B,
    fixtureTreeHash: HASH_C
  });

  assert.deepEqual(report.hashes, {
    corpus: HASH_A,
    ruleset: HASH_B,
    fixtureTree: HASH_C
  });
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.results[0]), true);
});

test("computeKillRate degrades confidence when restore fails", () => {
  const report = computeKillRate({
    baseline: baseline(),
    results: [result("one", "killed")],
    corpusHash: HASH_A,
    rulesetHash: HASH_B,
    fixtureTreeHash: HASH_C,
    restored: false
  });

  assert.equal(report.confidence, "degraded");
  assert.equal(report.restored, false);
});

test("computeKillRate rejects unknown outcomes", () => {
  assert.throws(
    () =>
      computeKillRate({
        baseline: baseline(),
        results: [result("one", "broken")],
        corpusHash: HASH_A,
        rulesetHash: HASH_B,
        fixtureTreeHash: HASH_C
      }),
    /Unknown self verification outcome/u
  );
});
