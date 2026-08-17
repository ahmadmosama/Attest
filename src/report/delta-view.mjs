const BUCKETS = Object.freeze([
  ["expected", "expected"],
  ["explained", "explained"],
  ["suppressed_external", "suppressed external"],
  ["unexplained", "unexplained"]
]);

const EMPTY_COUNTS = Object.freeze({
  expected: 0,
  explained: 0,
  suppressed_external: 0,
  unexplained: 0
});
const GROUP_ROW_LIMIT = 5;

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

function textOrNone(value) {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  return "none";
}

function countFor(counts, key) {
  return Number.isInteger(counts?.[key]) && counts[key] >= 0 ? counts[key] : 0;
}

function countsView(counts) {
  return {
    expected: countFor(counts, "expected"),
    explained: countFor(counts, "explained"),
    suppressed_external: countFor(counts, "suppressed_external"),
    unexplained: countFor(counts, "unexplained")
  };
}

function formatRuleFlag(rule) {
  const flags = [];

  if (rule.overBudget > 0) {
    flags.push("rule_too_broad");
  }

  if (rule.dead) {
    flags.push("dead: delete_rule");
  }

  if (rule.expired) {
    flags.push("expired");
  }

  return flags.length === 0 ? "ok" : flags.join(", ");
}

function ruleView(rule) {
  const row = {
    id: textOrNone(rule?.id),
    kind: textOrNone(rule?.kind),
    entity: textOrNone(rule?.entity),
    suppressed: countFor(rule, "suppressed"),
    overBudget: countFor(rule, "overBudget"),
    cap: Number.isInteger(rule?.cap) && rule.cap >= 0 ? rule.cap : null,
    dead: rule?.dead === true,
    expired: rule?.expired === true
  };

  return {
    ...row,
    flag: formatRuleFlag(row)
  };
}

function sortRules(rules) {
  return [...rules].toSorted((left, right) => {
    if (right.suppressed !== left.suppressed) {
      return right.suppressed - left.suppressed;
    }

    return (
      left.id.localeCompare(right.id) ||
      left.kind.localeCompare(right.kind) ||
      left.entity.localeCompare(right.entity)
    );
  });
}

function changedColumns(shortfall) {
  return asArray(shortfall?.changed).filter((column) => typeof column === "string" && column.length > 0);
}

function shortfallView(shortfall) {
  return {
    entity: textOrNone(shortfall?.entity ?? shortfall?.table),
    op: textOrNone(shortfall?.op),
    expected: countFor(shortfall, "expected"),
    observed: countFor(shortfall, "matched") || countFor(shortfall, "observed"),
    missing: countFor(shortfall, "missing"),
    columns: changedColumns(shortfall)
  };
}

function rowView(row) {
  return {
    key: typeof row?.key === "string" ? row.key : "key unavailable",
    columns: asArray(row?.columns).filter((column) => typeof column === "string" && column.length > 0),
    columnText: typeof row?.columnText === "string" && row.columnText.length > 0 ? row.columnText : "unavailable",
    notes: asArray(row?.notes).filter((note) => typeof note === "string" && note.length > 0)
  };
}

function groupView(group) {
  const rows = asArray(group?.rows);
  const visibleRows = rows.slice(0, GROUP_ROW_LIMIT);
  return {
    entity: textOrNone(group?.entity),
    op: textOrNone(group?.op),
    count: countFor(group, "count"),
    rows: visibleRows.map(rowView),
    omitted: countFor(group, "omitted") + Math.max(0, rows.length - visibleRows.length)
  };
}

function quietView(quiet) {
  if (quiet === null || quiet === undefined) {
    return null;
  }

  return {
    quiet: quiet.quiet === true,
    elapsedMs: countFor(quiet, "elapsedMs"),
    events: countFor(quiet, "events"),
    extensions: countFor(quiet, "extensions")
  };
}

function namedRule(rule) {
  return {
    id: textOrNone(rule?.ruleId ?? rule?.id),
    ruleId: textOrNone(rule?.ruleId ?? rule?.id),
    expires: typeof rule?.expires === "string" ? rule.expires : null,
    proposedAction: typeof rule?.proposedAction === "string" ? rule.proposedAction : null,
    consecutiveZeroRuns: Number.isInteger(rule?.consecutiveZeroRuns) ? rule.consecutiveZeroRuns : null,
    daysUntilExpiry: Number.isInteger(rule?.daysUntilExpiry) ? rule.daysUntilExpiry : null
  };
}

function capViolationView(violation) {
  return {
    code: textOrNone(violation?.code ?? "rule_too_broad"),
    ruleId: textOrNone(violation?.ruleId ?? violation?.id),
    reason: textOrNone(violation?.reason),
    count: countFor(violation, "count") || countFor(violation, "suppressed"),
    overBudget: countFor(violation, "overBudget"),
    cap: Number.isInteger(violation?.cap) && violation.cap >= 0 ? violation.cap : null
  };
}

function scenarioDeltaView(scenario) {
  const delta = scenario.delta;

  return {
    scenarioId: scenario.id,
    surface: scenario.surface,
    counts: countsView(delta.counts),
    bucketHeader: formatBucketHeader(delta.counts),
    unexplained: asArray(delta.unexplained).map(groupView),
    shortfalls: asArray(delta.shortfalls).map(shortfallView),
    convergeMs: asArray(delta.convergeMs).filter((value) => Number.isInteger(value) && value >= 0),
    quiet: quietView(delta.quiet),
    quietPeriods: asArray(delta.quietPeriods).map(quietView).filter(Boolean),
    rulesetHash: textOrNone(delta.rulesetHash),
    capViolations: asArray(delta.capViolations).map(capViolationView),
    health: healthView(delta.health)
  };
}

function scenarioHasDelta(scenario) {
  return scenario?.delta !== null && scenario?.delta !== undefined;
}

function healthView(health = {}) {
  return {
    dead: asArray(health.dead).map(namedRule),
    expired: asArray(health.expired).map(namedRule),
    expiringSoon: asArray(health.expiringSoon).map(namedRule)
  };
}

function suiteHealth(scenarios) {
  return {
    dead: scenarios.flatMap((scenario) => scenario.health.dead),
    expired: scenarios.flatMap((scenario) => scenario.health.expired),
    expiringSoon: scenarios.flatMap((scenario) => scenario.health.expiringSoon)
  };
}

function suiteCounts(record, scenarios) {
  if (record.delta?.counts !== undefined) {
    return countsView(record.delta.counts);
  }

  const counts = { ...EMPTY_COUNTS };
  for (const scenario of scenarios) {
    for (const [key] of BUCKETS) {
      counts[key] += scenario.counts[key];
    }
  }

  return counts;
}

function rulesetHash(record, scenarios) {
  if (typeof record.hashes?.ruleset === "string" && record.hashes.ruleset.length > 0) {
    return record.hashes.ruleset;
  }

  const hashes = [...new Set(scenarios.map((scenario) => scenario.rulesetHash).filter((hash) => hash !== "none"))];
  return hashes.length === 1 ? hashes[0] : "none";
}

function absentView() {
  return deepFreeze({
    present: false,
    counts: { ...EMPTY_COUNTS },
    bucketHeader: formatBucketHeader(EMPTY_COUNTS),
    scenarios: [],
    rules: [],
    ruleTable: "",
    rulesetHash: "none",
    health: { dead: [], expired: [], expiringSoon: [] }
  });
}

export function formatBucketHeader(counts = {}) {
  return BUCKETS.map(([key, label]) => `${label} ${countFor(counts, key)}`).join(", ");
}

export function formatRuleTable(rules = []) {
  const rows = sortRules(asArray(rules).map(ruleView));
  if (rows.length === 0) {
    return "No delta rules configured";
  }

  return [
    "Rule | Kind | Entity | Suppressed | Over budget | Cap | Health",
    ...rows.map((rule) =>
      [
        rule.id,
        rule.kind,
        rule.entity,
        String(rule.suppressed),
        String(rule.overBudget),
        rule.cap === null ? "none" : String(rule.cap),
        rule.flag
      ].join(" | ")
    )
  ].join("\n");
}

export function buildDeltaView(record = {}) {
  const scenarioDeltas = asArray(record.scenarios).filter(scenarioHasDelta).map(scenarioDeltaView);

  if (record.delta === null || record.delta === undefined || scenarioDeltas.length === 0) {
    return absentView();
  }

  const rules = sortRules(asArray(record.delta.rules).map(ruleView));
  const counts = suiteCounts(record, scenarioDeltas);
  return deepFreeze({
    present: true,
    counts,
    bucketHeader: formatBucketHeader(counts),
    scenarios: scenarioDeltas,
    rules,
    ruleTable: formatRuleTable(rules),
    rulesetHash: rulesetHash(record, scenarioDeltas),
    health: suiteHealth(scenarioDeltas)
  });
}
