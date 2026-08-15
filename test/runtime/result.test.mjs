import assert from "node:assert/strict";
import test from "node:test";

import { AttestError } from "../../src/errors.mjs";
import { emptyCounts, isResult, RESULTS, tallyResults } from "../../src/runtime/result.mjs";

test("result taxonomy includes all five first class states", () => {
  assert.deepEqual(RESULTS, ["pass", "fail", "infra_error", "skipped", "quarantined"]);
  assert.equal(isResult("infra_error"), true);
  assert.equal(isResult("skipped"), true);
  assert.equal(isResult("missing"), false);
  assert.throws(() => RESULTS.push("missing"));
});

test("emptyCounts returns the run record count shape", () => {
  assert.deepEqual(emptyCounts(), {
    total: 0,
    passed: 0,
    failed: 0,
    infra_error: 0,
    skipped: 0,
    quarantined: 0
  });
  assert.throws(() => {
    emptyCounts().total = 1;
  });
});

test("tallyResults counts every result without dropping skipped or infra_error", () => {
  assert.deepEqual(tallyResults(["pass", "fail", "skipped", "infra_error", "pass"]), {
    total: 5,
    passed: 2,
    failed: 1,
    infra_error: 1,
    skipped: 1,
    quarantined: 0
  });
});

test("tallyResults counts quarantined and returns a frozen object", () => {
  const counts = tallyResults(["quarantined"]);

  assert.deepEqual(counts, {
    total: 1,
    passed: 0,
    failed: 0,
    infra_error: 0,
    skipped: 0,
    quarantined: 1
  });
  assert.throws(() => {
    counts.total = 2;
  });
});

test("tallyResults throws on unknown strings", () => {
  assert.throws(
    () => tallyResults(["pass", "unknown"]),
    (error) => error instanceof AttestError && error.code === "E_UNKNOWN_RESULT"
  );
});
