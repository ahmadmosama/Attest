const DEFAULT_TIMEOUTS = Object.freeze({
  stepMs: 5000,
  scenarioMs: 30000,
  preflightMs: 5000,
  openMs: 5000,
  evidenceMs: 1000,
  closeMs: 1000
});

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non empty string`);
  }
}

function normalizeTimeouts(timeouts = {}) {
  const normalized = { ...DEFAULT_TIMEOUTS, ...timeouts };

  for (const [key, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Timeout ${key} must be a non negative safe integer`);
    }
  }

  return normalized;
}

function createEvidenceBundle(scenarioBundle) {
  let evidenceSeq = 0;

  return {
    ...scenarioBundle,
    writeTextArtifact(kind, text) {
      const index = String(evidenceSeq).padStart(3, "0");
      evidenceSeq += 1;
      return scenarioBundle.write(`evidence/${index}-${kind}.txt`, text);
    },
    writeArtifact(kind, data) {
      const index = String(evidenceSeq).padStart(3, "0");
      evidenceSeq += 1;
      return scenarioBundle.write(`evidence/${index}-${kind}.bin`, data);
    }
  };
}

function scenarioBundleFor(bundle, scenarioId, surface) {
  if (typeof bundle?.scenario === "function") {
    return bundle.scenario(scenarioId, surface);
  }

  return bundle;
}

export function createRunContext({
  runId,
  scenarioId,
  surface,
  bundle,
  headed = false,
  tenantPrefix = "",
  timeouts = {},
  now = Date.now,
  db = null
} = {}) {
  assertNonEmptyString(runId, "runId");
  assertNonEmptyString(scenarioId, "scenarioId");
  assertNonEmptyString(surface, "surface");

  if (bundle === null || typeof bundle !== "object") {
    throw new TypeError("bundle must be an object");
  }

  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }

  const scenarioBundle = scenarioBundleFor(bundle, scenarioId, surface);
  if (typeof scenarioBundle?.writeJson !== "function" || typeof scenarioBundle.write !== "function") {
    throw new TypeError("scenario bundle must expose write and writeJson");
  }

  return deepFreeze({
    runId,
    scenarioId,
    surface,
    bundle: createEvidenceBundle(scenarioBundle),
    headed: Boolean(headed),
    tenantPrefix,
    timeouts: normalizeTimeouts(timeouts),
    now,
    db
  });
}
