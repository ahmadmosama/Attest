import stableStringify from "json-stable-stringify";

import { BUCKETS } from "./classify.mjs";
import { canonicalValue } from "../db/normalize/canonical.mjs";

const DEFAULT_PER_GROUP = 5;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function entryEvent(value) {
  if (value?.event !== undefined) {
    return value.event;
  }

  return value;
}

function countFor(counts, bucket) {
  return Number.isFinite(counts?.[bucket]) ? counts[bucket] : 0;
}

function bucketHeader(deltaResult = {}) {
  const counts = deltaResult.counts ?? {};

  return BUCKETS.map((bucket) => `${bucket}=${countFor(counts, bucket)}`).join(" ");
}

function positiveInteger(value, fallback) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  return fallback;
}

function eventKey(event) {
  const key = event?.key;

  if (key === null || typeof key !== "object" || Array.isArray(key) || Object.keys(key).length === 0) {
    return {
      text: "key unavailable",
      note: "set REPLICA IDENTITY FULL so the capture stream can report row identity"
    };
  }

  return {
    text: stableStringify(canonicalValue(key)),
    note: null
  };
}

function rowColumns(event) {
  const paths = asArray(event?.paths)
    .filter((path) => Array.isArray(path) && path.length > 0)
    .map((path) => path.join("."));

  if (paths.length > 0) {
    return [...new Set(paths)].toSorted((left, right) => left.localeCompare(right));
  }

  const row = event?.after ?? event?.before;
  if (row !== null && typeof row === "object" && !Array.isArray(row)) {
    return Object.keys(row).toSorted((left, right) => left.localeCompare(right));
  }

  return [];
}

function rowForEvent(event) {
  const key = eventKey(event);
  const columns = rowColumns(event);
  const columnText = columns.length > 0
    ? columns.join(", ")
    : "unavailable";
  const notes = [
    ...(key.note === null ? [] : [key.note]),
    ...(columns.length > 0 ? [] : ["changed columns unavailable; set REPLICA IDENTITY FULL"])
  ];

  return Object.freeze({
    entity: event?.entity,
    op: event?.op,
    key: key.text,
    columns,
    columnText,
    notes
  });
}

function groupKey(event) {
  return `${event?.entity ?? "unknown"}\0${event?.op ?? "unknown"}`;
}

function sortedGroups(groups) {
  return [...groups.values()].toSorted((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }

    const entityOrder = left.entity.localeCompare(right.entity);
    if (entityOrder !== 0) {
      return entityOrder;
    }

    return left.op.localeCompare(right.op);
  });
}

export function groupUnexplained(events = [], { perGroup = DEFAULT_PER_GROUP } = {}) {
  const cap = positiveInteger(perGroup, DEFAULT_PER_GROUP);
  const groups = new Map();

  for (const value of asArray(events)) {
    const event = entryEvent(value);
    const key = groupKey(event);
    const current = groups.get(key) ?? {
      entity: event?.entity ?? "unknown",
      op: event?.op ?? "unknown",
      count: 0,
      rows: []
    };

    current.count += 1;
    if (current.rows.length < cap) {
      current.rows.push(rowForEvent(event));
    }

    groups.set(key, current);
  }

  return Object.freeze(
    sortedGroups(groups).map((group) =>
      Object.freeze({
        entity: group.entity,
        op: group.op,
        count: group.count,
        rows: Object.freeze(group.rows),
        omitted: Math.max(0, group.count - group.rows.length)
      })
    )
  );
}

function requireContextValue(context, field, accepted) {
  const value = context[field];
  const valid = accepted(value);

  if (!valid) {
    throw new TypeError(`formatDeltaFailure requires context.${field}`);
  }

  return value;
}

function normalizeContext(input) {
  const context = input.context ?? input;
  const scenarioId = requireContextValue(
    context,
    "scenarioId",
    (value) => typeof value === "string" && value.length > 0
  );
  const surface = requireContextValue(
    context,
    "surface",
    (value) => typeof value === "string" && value.length > 0
  );
  const stepIndex = requireContextValue(context, "stepIndex", Number.isInteger);
  const requirements = requireContextValue(context, "requirements", Array.isArray);
  const artifactDir = requireContextValue(
    context,
    "artifactDir",
    (value) => typeof value === "string" && value.length > 0
  );

  return { scenarioId, surface, stepIndex, requirements, artifactDir };
}

function violationsFrom(input) {
  if (Array.isArray(input.violations)) {
    return input.violations;
  }

  if (Array.isArray(input.error?.details?.violations)) {
    return input.error.details.violations;
  }

  return [];
}

function missingLines(violations) {
  const missing = violations.filter((violation) => violation.code === "E_DELTA_MISSING_MUTATION");

  if (missing.length === 0) {
    return [];
  }

  return [
    "Missing expected mutations:",
    ...missing.map(
      (violation) =>
        `- table ${violation.entity} op ${violation.op} expected ${violation.expected} observed ${violation.observed}`
    )
  ];
}

function capLines(violations) {
  const caps = violations.filter((violation) => violation.code === "E_RULE_TOO_BROAD");

  if (caps.length === 0) {
    return [];
  }

  return [
    "Rule caps exceeded:",
    ...caps.map(
      (violation) =>
        `- rule ${violation.ruleId} reason ${violation.reason} count ${violation.count} cap ${violation.cap}`
    )
  ];
}

function expiredLines(violations) {
  const expired = violations.filter((violation) => violation.code === "E_RULE_EXPIRED");

  if (expired.length === 0) {
    return [];
  }

  return [
    "Expired ignore rules:",
    ...expired.map((violation) => `- rule ${violation.ruleId} expired ${violation.expires}`)
  ];
}

function fidelityLines(violations) {
  const fidelity = violations.filter((violation) => violation.code === "E_DELTA_FIDELITY_INSUFFICIENT");

  if (fidelity.length === 0) {
    return [];
  }

  return [
    "Insufficient capture fidelity:",
    ...fidelity.map(
      (violation) =>
        `- table ${violation.entity} op ${violation.op} columns ${asArray(violation.changed).join(", ")} fidelity ${violation.fidelity}; ${violation.remediation}`
    )
  ];
}

function unexplainedLines(deltaResult, perGroup) {
  const groups = groupUnexplained(asArray(deltaResult?.buckets?.unexplained), { perGroup });

  if (groups.length === 0) {
    return [];
  }

  const lines = ["Unexplained changes:"];

  for (const group of groups) {
    lines.push(`- ${group.entity} ${group.op}: ${group.count} change(s), showing ${group.rows.length}`);

    for (const row of group.rows) {
      const note = row.notes.length > 0 ? ` (${row.notes.join("; ")})` : "";
      lines.push(`  table ${row.entity} row key ${row.key} column ${row.columnText}${note}`);
    }

    if (group.omitted > 0) {
      lines.push(`  ${group.omitted} more ${group.entity} ${group.op} change(s) omitted`);
    }
  }

  return lines;
}

function contextLines(context) {
  return [
    `Scenario: ${context.scenarioId}`,
    `Surface: ${context.surface}`,
    `Step: ${context.stepIndex}`,
    `Requirements: ${context.requirements.length > 0 ? context.requirements.join(", ") : "none"}`,
    `Artifacts: ${context.artifactDir}`
  ];
}

export function formatDeltaFailure(input = {}) {
  const context = normalizeContext(input);
  const deltaResult = input.deltaResult ?? input.error?.details?.deltaResult ?? {};
  const violations = violationsFrom(input);
  const perGroup = positiveInteger(input.perGroup, DEFAULT_PER_GROUP);
  const lines = [
    `Delta counts: ${bucketHeader(deltaResult)}`,
    ...contextLines(context),
    ...missingLines(violations),
    ...unexplainedLines(deltaResult, perGroup),
    ...capLines(violations),
    ...expiredLines(violations),
    ...fidelityLines(violations)
  ];

  return `${lines.join("\n")}\n`;
}
