export const CAP_DEFAULT = 50;

const SUPPRESSING_KINDS = Object.freeze(["derived", "external_writer", "ignore"]);

function freeze(value) {
  return Object.freeze(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function positiveIntegerOrDefault(value, fallback) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  return fallback;
}

function declaredCap(stat) {
  return positiveIntegerOrDefault(stat?.cap, CAP_DEFAULT);
}

function suppressionCount(stat) {
  return numberOrZero(stat?.suppressed);
}

function overBudgetCount(stat) {
  return numberOrZero(stat?.overBudget);
}

function sourceCount(stat) {
  return numberOrZero(stat?.sourceCount ?? stat?.source_count);
}

function perSource(stat) {
  return numberOrZero(stat?.perSource ?? stat?.per_source);
}

function totalMatchedCount(stat) {
  return suppressionCount(stat) + overBudgetCount(stat);
}

function declaredCardinalityCap(stat) {
  const sources = sourceCount(stat);
  const each = perSource(stat);

  if (stat?.kind !== "derived" || sources <= 0 || each <= 0) {
    return null;
  }

  return sources * each;
}

function isSuppressingRule(stat) {
  return SUPPRESSING_KINDS.includes(stat?.kind);
}

function baseViolation(stat, reason) {
  return {
    code: "rule_too_broad",
    reason,
    ruleId: stat.id,
    id: stat.id,
    kind: stat.kind
  };
}

function absoluteCapViolation(stat) {
  const count = suppressionCount(stat);
  const cap = declaredCap(stat);

  if (count <= cap) {
    return null;
  }

  return freeze({
    ...baseViolation(stat, "absolute_cap"),
    count,
    cap
  });
}

function cardinalityViolation(stat) {
  const overBudget = overBudgetCount(stat);
  const cardinalityCap = declaredCardinalityCap(stat);
  const count = totalMatchedCount(stat);

  if (overBudget <= 0 && (cardinalityCap === null || suppressionCount(stat) <= cardinalityCap)) {
    return null;
  }

  return freeze({
    ...baseViolation(stat, "declared_cardinality"),
    count,
    overBudget,
    cap: cardinalityCap ?? declaredCap(stat)
  });
}

function violationsFor(stat) {
  if (!isSuppressingRule(stat)) {
    return [];
  }

  return [cardinalityViolation(stat), absoluteCapViolation(stat)].filter(Boolean);
}

export function enforceCaps(ruleStats = []) {
  return freeze(asArray(ruleStats).flatMap(violationsFor));
}
