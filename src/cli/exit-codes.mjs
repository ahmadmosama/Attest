import { UsageError } from "../errors.mjs";

export const EXIT = Object.freeze({
  PASS: 0,
  SCENARIO_FAILURE: 1,
  HARNESS_ERROR: 2,
  USAGE_ERROR: 3,
  SKIPPED_AS_FAILURE: 4
});

const REQUIRED_COUNT_FIELDS = Object.freeze(["infra_error", "failed", "skipped"]);

function validateCounts(counts) {
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) {
    throw new UsageError("E_BAD_COUNTS", "Exit code counts must be an object", {
      reason: "counts_not_object"
    });
  }

  for (const field of REQUIRED_COUNT_FIELDS) {
    const value = counts[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new UsageError("E_BAD_COUNTS", "Exit code counts contain an invalid field", {
        field,
        reason: "missing_or_non_numeric"
      });
    }
  }
}

export function exitCodeFor({ counts, usageError = false, failOnSkip = true }) {
  validateCounts(counts);

  if (typeof usageError !== "boolean") {
    throw new UsageError("E_BAD_EXIT_OPTION", "usageError must be boolean", {
      field: "usageError"
    });
  }

  if (typeof failOnSkip !== "boolean") {
    throw new UsageError("E_BAD_EXIT_OPTION", "failOnSkip must be boolean", {
      field: "failOnSkip"
    });
  }

  // Precedence is usage, infra, scenario failure, skipped as failure, pass.
  if (usageError) {
    return EXIT.USAGE_ERROR;
  }

  if (counts.infra_error > 0) {
    return EXIT.HARNESS_ERROR;
  }

  if (counts.failed > 0) {
    return EXIT.SCENARIO_FAILURE;
  }

  if (counts.skipped > 0 && failOnSkip) {
    return EXIT.SKIPPED_AS_FAILURE;
  }

  return EXIT.PASS;
}
