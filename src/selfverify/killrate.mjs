export const KILL_RATE_VERSION = 1;

const OUTCOMES = Object.freeze(["killed", "survived", "error"]);

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function assertOutcome(outcome) {
  if (!OUTCOMES.includes(outcome)) {
    throw new TypeError(`Unknown self verification outcome ${String(outcome)}`);
  }
}

function countByOutcome(results) {
  const counts = {
    killed: 0,
    survived: 0,
    errored: 0,
    total: results.length
  };

  for (const result of results) {
    assertOutcome(result?.outcome);
    if (result.outcome === "error") {
      counts.errored += 1;
    } else {
      counts[result.outcome] += 1;
    }
  }

  return counts;
}

function rateFor(counts) {
  const scored = counts.killed + counts.survived;
  if (scored === 0) {
    return null;
  }

  return counts.killed / scored;
}

function confidenceFor(counts, restored) {
  if (restored !== true) {
    return "degraded";
  }

  return counts.errored > 0 ? "degraded" : "clean";
}

function requireHash(value, field) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a SHA 256 hex string`);
  }
}

function normalizeBaseline(baseline) {
  if (baseline === null || typeof baseline !== "object" || Array.isArray(baseline)) {
    throw new TypeError("computeKillRate baseline must be an object");
  }

  return Object.freeze({
    outcome: baseline.outcome ?? (baseline.exitCode === 0 ? "passed" : "failed"),
    exitCode: baseline.exitCode ?? null,
    reason: baseline.reason ?? null
  });
}

function normalizeResult(result) {
  assertOutcome(result?.outcome);
  return Object.freeze({
    mutantId: result.mutantId,
    outcome: result.outcome,
    exitCode: result.exitCode ?? null,
    reason: result.reason ?? null
  });
}

function normalizeHashes(input) {
  requireHash(input.corpusHash, "corpusHash");
  requireHash(input.rulesetHash, "rulesetHash");
  requireHash(input.fixtureTreeHash, "fixtureTreeHash");

  return Object.freeze({
    corpus: input.corpusHash,
    ruleset: input.rulesetHash,
    fixtureTree: input.fixtureTreeHash
  });
}

export function computeKillRate({
  baseline,
  results,
  corpusHash,
  rulesetHash,
  fixtureTreeHash,
  restored = true
} = {}) {
  const normalizedResults = asArray(results).map(normalizeResult);
  const counts = countByOutcome(normalizedResults);
  const scored = counts.killed + counts.survived;
  const rate = rateFor(counts);

  return deepFreeze({
    version: KILL_RATE_VERSION,
    baseline: normalizeBaseline(baseline),
    counts: {
      total: counts.total,
      killed: counts.killed,
      survived: counts.survived,
      errored: counts.errored,
      scored
    },
    rate,
    ratePercent: rate === null ? null : Number((rate * 100).toFixed(2)),
    confidence: confidenceFor(counts, restored),
    restored: restored === true,
    hashes: normalizeHashes({ corpusHash, rulesetHash, fixtureTreeHash }),
    results: normalizedResults
  });
}
