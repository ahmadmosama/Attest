import stableStringify from "json-stable-stringify";

import { canonicalValue } from "../db/normalize/canonical.mjs";
import { AttestError } from "../errors.mjs";
import { enforceCaps } from "./rules/caps.mjs";

export const BUCKETS = Object.freeze([
  "expected",
  "explained",
  "suppressed_external",
  "unexplained"
]);

const BUCKET_SET = new Set(BUCKETS);

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function emptyBuckets() {
  return {
    expected: [],
    explained: [],
    suppressed_external: [],
    unexplained: []
  };
}

function emptyCounts(total = 0) {
  return {
    total,
    expected: 0,
    explained: 0,
    suppressed_external: 0,
    unexplained: 0
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function tableName(entity) {
  return typeof entity === "string" ? entity.split(".").at(-1) : entity;
}

function entityMatches(expected, actual) {
  return expected === actual || expected === tableName(actual);
}

function comparable(value) {
  return stableStringify(canonicalValue(value));
}

function rowForWhere(event) {
  if (event.op === "delete") {
    return event.before ?? event.key;
  }

  return event.after ?? event.key;
}

function whereMatches(event, expectation) {
  if (expectation.where === undefined) {
    return true;
  }

  const row = rowForWhere(event);
  if (row === null || typeof row !== "object") {
    return false;
  }

  return Object.entries(expectation.where).every(
    ([key, value]) => comparable(row[key]) === comparable(value)
  );
}

function changedMatches(event, expectation) {
  if (!Array.isArray(expectation.changed)) {
    return true;
  }

  const changed = new Set(asArray(event.paths).map((path) => path[0]));
  return expectation.changed.every((path) => changed.has(path));
}

function eventMatchesExpectation(event, expectation) {
  return (
    entityMatches(expectation.entity, event.entity) &&
    expectation.op === event.op &&
    whereMatches(event, expectation) &&
    changedMatches(event, expectation)
  );
}

function eventOrder(left, right) {
  const leftSeq = Number.isInteger(left.event.seq) ? left.event.seq : null;
  const rightSeq = Number.isInteger(right.event.seq) ? right.event.seq : null;

  if (leftSeq !== null && rightSeq !== null && leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }

  if (leftSeq !== null && rightSeq === null) {
    return -1;
  }

  if (leftSeq === null && rightSeq !== null) {
    return 1;
  }

  return left.index - right.index;
}

function expectationBudget(expectation) {
  if (Number.isInteger(expectation.count) && expectation.count > 0) {
    return expectation.count;
  }

  return 0;
}

function createExpectationState(expectations) {
  return expectations.map((expectation, index) => ({
    index,
    expectation,
    budget: expectationBudget(expectation),
    matched: 0
  }));
}

function allocateExpected(events, expectations) {
  const states = createExpectationState(expectations);
  const matches = new WeakMap();
  const ordered = events.map((event, index) => ({ event, index })).toSorted(eventOrder);

  for (const item of ordered) {
    for (const state of states) {
      if (state.matched >= state.budget) {
        continue;
      }

      if (!eventMatchesExpectation(item.event, state.expectation)) {
        continue;
      }

      state.matched += 1;
      matches.set(item.event, state.index);
      break;
    }
  }

  return {
    matches,
    shortfalls: states
      .filter((state) => state.matched < state.budget)
      .map((state) => ({
        index: state.index,
        entity: state.expectation.entity,
        op: state.expectation.op,
        expected: state.budget,
        matched: state.matched,
        missing: state.budget - state.matched,
        where: state.expectation.where,
        changed: state.expectation.changed
      }))
  };
}

function runEngine(engine, events) {
  if (engine === undefined || engine === null) {
    return [];
  }

  if (typeof engine.prime === "function" && typeof engine.explain === "function") {
    engine.prime(events);
    return events.map((event) => ({
      originalEvent: event,
      event,
      ...engine.explain(event)
    }));
  }

  if (typeof engine.classify === "function") {
    return engine.classify(events);
  }

  if (typeof engine.run === "function") {
    return engine.run(events);
  }

  throw new TypeError("classifyChanges engine must expose explain, classify, or run");
}

function engineResultsByEvent(engineResults, events) {
  const byEvent = new WeakMap();

  for (const [index, result] of engineResults.entries()) {
    const key = result?.originalEvent ?? events[index];
    if (key !== undefined && key !== null && typeof key === "object") {
      byEvent.set(key, result);
    }
  }

  return byEvent;
}

function classifyRuleResult(result) {
  if (result?.explained !== true) {
    return "unexplained";
  }

  if (result.bucket === "suppressed_external" || result.kind === "external_writer") {
    return "suppressed_external";
  }

  return "explained";
}

function bucketEntry({ event, bucket, expectationIndex, ruleResult }) {
  const transformed = ruleResult?.event === undefined ? event : ruleResult.event;

  return {
    event,
    bucket,
    transformedEvent: transformed,
    expectationIndex,
    ruleId: ruleResult?.ruleId,
    ruleKind: ruleResult?.kind,
    volatileStripped: ruleResult?.volatileStripped ?? []
  };
}

function pushBucket({ buckets, counts, classifications, entry }) {
  if (!BUCKET_SET.has(entry.bucket)) {
    throw new AttestError("E_DELTA_CLASSIFICATION_INCOMPLETE", "Unknown delta bucket", {
      bucket: entry.bucket
    });
  }

  buckets[entry.bucket].push(entry);
  counts[entry.bucket] += 1;
  classifications.push(entry);
}

function statsFromEngine(engine) {
  if (engine === undefined || engine === null || typeof engine.stats !== "function") {
    return [];
  }

  return engine.stats();
}

function assertTotality({ events, buckets, counts, classifications }) {
  const bucketTotal = BUCKETS.reduce((sum, bucket) => sum + counts[bucket], 0);
  const members = BUCKETS.flatMap((bucket) => buckets[bucket]);
  const unique = new Set(members.map((entry) => entry.event));

  if (
    counts.total !== events.length ||
    bucketTotal !== events.length ||
    members.length !== events.length ||
    unique.size !== events.length ||
    classifications.length !== events.length
  ) {
    throw new AttestError(
      "E_DELTA_CLASSIFICATION_INCOMPLETE",
      "Delta classification did not account for every change exactly once",
      {
        input: events.length,
        total: counts.total,
        bucketTotal,
        members: members.length,
        unique: unique.size,
        classifications: classifications.length
      }
    );
  }
}

function failureReasons({ counts, capViolations, ruleHealth }) {
  const reasons = [];

  if (counts.unexplained > 0) {
    reasons.push("unexplained_changes");
  }

  if (capViolations.length > 0) {
    reasons.push("rule_too_broad");
  }

  if (asArray(ruleHealth?.expired).length > 0) {
    reasons.push("expired_rules");
  }

  return reasons;
}

export function createDeltaResult(input = {}) {
  const counts = {
    ...emptyCounts(input.counts?.total ?? 0),
    ...input.counts
  };
  const buckets = {
    ...emptyBuckets(),
    ...input.buckets
  };
  const ruleStats = asArray(input.ruleStats);
  const capViolations = input.capViolations ?? enforceCaps(ruleStats);
  const ruleHealth = input.ruleHealth ?? {
    dead: [],
    expired: [],
    expiringSoon: []
  };
  const failures = failureReasons({ counts, capViolations, ruleHealth });

  return deepFreeze({
    counts,
    buckets,
    classifications: asArray(input.classifications),
    ruleStats,
    rulesetHash: input.rulesetHash ?? null,
    expectationShortfalls: asArray(input.expectationShortfalls),
    capViolations,
    ruleHealth,
    failed: failures.length > 0,
    ok: failures.length === 0,
    failureReasons: failures
  });
}

export function classifyChanges({ events = [], expectations = [], engine, rulesetHash = null } = {}) {
  if (!Array.isArray(events)) {
    throw new TypeError("classifyChanges events must be an array");
  }

  if (!Array.isArray(expectations)) {
    throw new TypeError("classifyChanges expectations must be an array");
  }

  const expected = allocateExpected(events, expectations);
  const engineResults = runEngine(engine, events);
  const byEvent = engineResultsByEvent(engineResults, events);
  const buckets = emptyBuckets();
  const counts = emptyCounts(events.length);
  const classifications = [];

  for (const event of events) {
    const expectationIndex = expected.matches.get(event);
    if (expectationIndex !== undefined) {
      pushBucket({
        buckets,
        counts,
        classifications,
        entry: bucketEntry({
          event,
          bucket: "expected",
          expectationIndex,
          ruleResult: undefined
        })
      });
      continue;
    }

    const ruleResult = byEvent.get(event);
    const bucket = classifyRuleResult(ruleResult);
    pushBucket({
      buckets,
      counts,
      classifications,
      entry: bucketEntry({
        event,
        bucket,
        expectationIndex: undefined,
        ruleResult
      })
    });
  }

  assertTotality({ events, buckets, counts, classifications });

  return createDeltaResult({
    counts,
    buckets,
    classifications,
    ruleStats: statsFromEngine(engine),
    rulesetHash,
    expectationShortfalls: expected.shortfalls
  });
}
