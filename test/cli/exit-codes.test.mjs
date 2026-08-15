import assert from "node:assert/strict";
import test from "node:test";

import { UsageError } from "../../src/errors.mjs";
import { EXIT, exitCodeFor } from "../../src/cli/exit-codes.mjs";

const zeroCounts = Object.freeze({
  infra_error: 0,
  failed: 0,
  skipped: 0
});

test("usage error takes precedence over infra errors", () => {
  const counts = Object.freeze({
    infra_error: 1,
    failed: 1,
    skipped: 1
  });

  assert.equal(exitCodeFor({ counts, usageError: true }), EXIT.USAGE_ERROR);
});

test("infra errors take precedence over scenario failures", () => {
  const counts = Object.freeze({
    infra_error: 1,
    failed: 1,
    skipped: 1
  });

  assert.equal(exitCodeFor({ counts }), EXIT.HARNESS_ERROR);
});

test("scenario failures take precedence over skipped scenarios", () => {
  const counts = Object.freeze({
    infra_error: 0,
    failed: 1,
    skipped: 1
  });

  assert.equal(exitCodeFor({ counts }), EXIT.SCENARIO_FAILURE);
});

test("skipped scenarios pass when failOnSkip is off", () => {
  const counts = Object.freeze({
    infra_error: 0,
    failed: 0,
    skipped: 1
  });

  assert.equal(exitCodeFor({ counts, failOnSkip: false }), EXIT.PASS);
});

test("all zero counts pass", () => {
  assert.equal(exitCodeFor({ counts: zeroCounts }), EXIT.PASS);
});

test("invalid counts throw UsageError", () => {
  assert.throws(
    () => exitCodeFor({ counts: { infra_error: 0, failed: "1", skipped: 0 } }),
    (error) => error instanceof UsageError && error.code === "E_BAD_COUNTS"
  );
});
