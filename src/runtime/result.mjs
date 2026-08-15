import { AttestError } from "../errors.mjs";

export const RESULTS = Object.freeze(["pass", "fail", "infra_error", "skipped", "quarantined"]);

const RESULT_SET = new Set(RESULTS);

function freezeCounts(counts) {
  return Object.freeze({ ...counts });
}

function assertKnownResult(result) {
  if (!RESULT_SET.has(result)) {
    throw new AttestError("E_UNKNOWN_RESULT", "Unknown result", { result });
  }
}

export function isResult(result) {
  return RESULT_SET.has(result);
}

export function emptyCounts() {
  return freezeCounts({
    total: 0,
    passed: 0,
    failed: 0,
    infra_error: 0,
    skipped: 0,
    quarantined: 0
  });
}

export function tallyResults(results) {
  if (!Array.isArray(results)) {
    throw new AttestError("E_BAD_RESULTS", "Results must be an array", {
      reason: "results_not_array"
    });
  }

  const counts = {
    total: 0,
    passed: 0,
    failed: 0,
    infra_error: 0,
    skipped: 0,
    quarantined: 0
  };

  for (const result of results) {
    assertKnownResult(result);
    counts.total += 1;

    if (result === "pass") {
      counts.passed += 1;
    } else if (result === "fail") {
      counts.failed += 1;
    } else {
      counts[result] += 1;
    }
  }

  return freezeCounts(counts);
}
