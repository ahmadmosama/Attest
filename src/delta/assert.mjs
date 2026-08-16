import { BUCKETS } from "./classify.mjs";
import { AttestError } from "../errors.mjs";

export const DELTA_VIOLATIONS = Object.freeze([
  "E_DELTA_MISSING_MUTATION",
  "E_DELTA_UNEXPLAINED",
  "E_RULE_TOO_BROAD",
  "E_RULE_EXPIRED",
  "E_DELTA_FIDELITY_INSUFFICIENT"
]);

const CODE_SET = new Set(DELTA_VIOLATIONS);

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

function assertDeltaResult(deltaResult) {
  if (deltaResult === null || typeof deltaResult !== "object" || Array.isArray(deltaResult)) {
    throw new TypeError("assertDelta requires a classified delta result");
  }

  if (deltaResult.counts === null || typeof deltaResult.counts !== "object") {
    throw new TypeError("assertDelta requires deltaResult.counts");
  }

  if (deltaResult.buckets === null || typeof deltaResult.buckets !== "object") {
    throw new TypeError("assertDelta requires deltaResult.buckets");
  }
}

function bucketEntries(deltaResult) {
  return BUCKETS.flatMap((bucket) => asArray(deltaResult.buckets[bucket]));
}

function entryEvent(entry) {
  if (entry?.event !== undefined) {
    return entry.event;
  }

  return entry;
}

function tableName(entity) {
  return typeof entity === "string" ? entity.split(".").at(-1) : entity;
}

function entityMatches(expected, actual) {
  return expected === actual || expected === tableName(actual);
}

function changedColumns(expectation) {
  return asArray(expectation?.changed).filter((column) => typeof column === "string" && column.length > 0);
}

function normalizeShortfall(shortfall) {
  return deepFreeze({
    code: "E_DELTA_MISSING_MUTATION",
    kind: "missing_mutation",
    expectationIndex: shortfall.index,
    entity: shortfall.entity,
    table: shortfall.entity,
    op: shortfall.op,
    expected: shortfall.expected,
    observed: shortfall.matched,
    missing: shortfall.missing,
    changed: changedColumns(shortfall)
  });
}

function missingMutationViolations(deltaResult) {
  return asArray(deltaResult.expectationShortfalls).map(normalizeShortfall);
}

function unexplainedViolation(deltaResult, requireNoUnexplained) {
  const count = Number.isFinite(deltaResult.counts.unexplained)
    ? deltaResult.counts.unexplained
    : asArray(deltaResult.buckets.unexplained).length;

  if (requireNoUnexplained === false || count <= 0) {
    return [];
  }

  return [
    deepFreeze({
      code: "E_DELTA_UNEXPLAINED",
      kind: "unexplained",
      count
    })
  ];
}

function ruleCapViolations(capViolations) {
  return asArray(capViolations).map((violation) =>
    deepFreeze({
      code: "E_RULE_TOO_BROAD",
      kind: "rule_too_broad",
      ruleId: violation.ruleId ?? violation.id,
      id: violation.id ?? violation.ruleId,
      ruleKind: violation.kind,
      reason: violation.reason,
      count: violation.count ?? violation.suppressed,
      suppressed: violation.suppressed,
      overBudget: violation.overBudget,
      cap: violation.cap
    })
  );
}

function expiredRuleViolations(health) {
  return asArray(health?.expired).map((rule) =>
    deepFreeze({
      code: "E_RULE_EXPIRED",
      kind: "rule_expired",
      ruleId: rule.ruleId ?? rule.id,
      id: rule.id ?? rule.ruleId,
      expires: rule.expires
    })
  );
}

function changedExpectationRows(expectations) {
  return asArray(expectations)
    .map((expectation, index) => ({ expectation, index, changed: changedColumns(expectation) }))
    .filter((entry) => entry.changed.length > 0);
}

function fidelityFromCapabilities(capabilities) {
  if (capabilities?.beforeImages === "key_only" || capabilities?.beforeImages === "none") {
    return capabilities.beforeImages;
  }

  return null;
}

function degradedHints(capabilities, entity) {
  const degraded = asArray(capabilities?.degraded).filter((entry) => typeof entry === "string");
  const scoped = degraded.filter((entry) => entity === undefined || entry.includes(entity) || entry.includes(tableName(entity)));

  return scoped.length > 0 ? scoped : degraded;
}

function matchingEventsForExpectation(events, expectation) {
  return events.filter((event) => entityMatches(expectation.entity, event?.entity) && expectation.op === event?.op);
}

function insufficientEventFidelity(events) {
  return events.find((event) => event?.fidelity === "key_only" || event?.fidelity === "value_only")?.fidelity ?? null;
}

function fidelityViolationFor({ row, events, capabilities }) {
  const relevant = matchingEventsForExpectation(events, row.expectation);
  const eventFidelity = insufficientEventFidelity(relevant);
  const capabilityFidelity = fidelityFromCapabilities(capabilities);
  const fidelity = eventFidelity ?? capabilityFidelity;

  if (fidelity === null) {
    return null;
  }

  return deepFreeze({
    code: "E_DELTA_FIDELITY_INSUFFICIENT",
    kind: "fidelity_insufficient",
    expectationIndex: row.index,
    entity: row.expectation.entity,
    table: row.expectation.entity,
    op: row.expectation.op,
    changed: row.changed,
    fidelity,
    remediation: "Set REPLICA IDENTITY FULL on the table before asserting changed columns.",
    degraded: degradedHints(capabilities, row.expectation.entity)
  });
}

function fidelityViolations({ deltaResult, expectations, capabilities }) {
  const events = bucketEntries(deltaResult).map(entryEvent);

  return changedExpectationRows(expectations)
    .map((row) => fidelityViolationFor({ row, events, capabilities }))
    .filter(Boolean);
}

function orderedViolations(groups) {
  return DELTA_VIOLATIONS.flatMap((code) => groups[code]);
}

function groupViolations(violations) {
  const groups = Object.fromEntries(DELTA_VIOLATIONS.map((code) => [code, []]));

  for (const violation of violations) {
    if (!CODE_SET.has(violation.code)) {
      continue;
    }

    groups[violation.code].push(violation);
  }

  return groups;
}

function successResult({ deltaResult, health, capabilities }) {
  return deepFreeze({
    ok: true,
    counts: {
      total: deltaResult.counts.total,
      expected: deltaResult.counts.expected,
      explained: deltaResult.counts.explained,
      suppressed_external: deltaResult.counts.suppressed_external,
      unexplained: deltaResult.counts.unexplained
    },
    violations: [],
    deadRules: asArray(health?.dead),
    expiringSoonRules: asArray(health?.expiringSoon),
    capabilities: capabilities ?? null
  });
}

function messageFor(primary, groups) {
  if (primary === "E_DELTA_MISSING_MUTATION") {
    const first = groups.E_DELTA_MISSING_MUTATION[0];
    return `Expected ${first.entity} ${first.op} mutation count ${first.expected}, observed ${first.observed}`;
  }

  if (primary === "E_DELTA_UNEXPLAINED") {
    const first = groups.E_DELTA_UNEXPLAINED[0];
    return `Delta assertion found ${first.count} unexplained change(s)`;
  }

  if (primary === "E_RULE_TOO_BROAD") {
    const ids = groups.E_RULE_TOO_BROAD.map((violation) => violation.ruleId).join(", ");
    return `Delta rule cap exceeded: ${ids}`;
  }

  if (primary === "E_RULE_EXPIRED") {
    const ids = groups.E_RULE_EXPIRED.map((violation) => `${violation.ruleId} expired ${violation.expires}`).join(", ");
    return `Delta rule expired: ${ids}`;
  }

  return "Delta assertion needs column fidelity but capture is key only";
}

function failureDetails({ deltaResult, groups, ordered, health, capabilities }) {
  return deepFreeze({
    counts: {
      total: deltaResult.counts.total,
      expected: deltaResult.counts.expected,
      explained: deltaResult.counts.explained,
      suppressed_external: deltaResult.counts.suppressed_external,
      unexplained: deltaResult.counts.unexplained
    },
    violations: ordered,
    byCode: groups,
    deadRules: asArray(health?.dead),
    expiringSoonRules: asArray(health?.expiringSoon),
    rulesetHash: deltaResult.rulesetHash ?? null,
    capabilities: capabilities ?? null
  });
}

export function assertDelta({
  deltaResult,
  expectations = [],
  requireNoUnexplained = true,
  capViolations,
  health,
  capabilities
} = {}) {
  assertDeltaResult(deltaResult);

  const resolvedCaps = capViolations ?? deltaResult.capViolations;
  const resolvedHealth = health ?? deltaResult.ruleHealth;
  const violations = [
    ...missingMutationViolations(deltaResult),
    ...unexplainedViolation(deltaResult, requireNoUnexplained),
    ...ruleCapViolations(resolvedCaps),
    ...expiredRuleViolations(resolvedHealth),
    ...fidelityViolations({ deltaResult, expectations, capabilities })
  ];
  const groups = groupViolations(violations);
  const ordered = orderedViolations(groups);

  if (ordered.length === 0) {
    return successResult({ deltaResult, health: resolvedHealth, capabilities });
  }

  const primary = ordered[0].code;
  throw new AttestError(primary, messageFor(primary, groups), failureDetails({
    deltaResult,
    groups,
    ordered,
    health: resolvedHealth,
    capabilities
  }));
}
