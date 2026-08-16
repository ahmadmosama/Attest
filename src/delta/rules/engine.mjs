import stableStringify from "json-stable-stringify";

import { AttestError } from "../../errors.mjs";
import { hashRuleset } from "./hash.mjs";
import { RulesetSchema } from "./schema.mjs";
import { createDerivedMatcher } from "./derived.mjs";
import { createExternalWriterMatcher } from "./external-writer.mjs";
import { createIgnoreMatcher } from "./ignore.mjs";
import { createVolatileMatcher } from "./volatile.mjs";

const DEFAULT_RULE_CAP = 50;

function freeze(value) {
  return Object.freeze(value);
}

function defaultClock() {
  return new Date();
}

function tableName(entity) {
  return typeof entity === "string" ? entity.split(".").at(-1) : entity;
}

function entityMatches(expected, actual) {
  return expected === actual || expected === tableName(actual);
}

function dateOnly(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("now must be a Date or a date parseable value");
  }

  return date.toISOString().slice(0, 10);
}

function nowValue(now) {
  return typeof now === "function" ? now() : now;
}

function sourceRuleset(input) {
  if (input?.ruleset !== undefined && Array.isArray(input.ruleset?.rules)) {
    return {
      ruleset: input.ruleset,
      hash: input.hash ?? hashRuleset(input.ruleset)
    };
  }

  if (Array.isArray(input?.rules)) {
    return {
      ruleset: input,
      hash: hashRuleset(input)
    };
  }

  throw new TypeError("compileRuleset ruleset must be a loaded ruleset or ruleset object");
}

function ruleExpired(rule, now) {
  return rule.kind === "ignore" && rule.expires < dateOnly(nowValue(now));
}

function expiredRuleError(rule) {
  return new AttestError("E_RULE_EXPIRED", `Rule ${rule.id} expired on ${rule.expires}`, {
    ruleId: rule.id,
    expires: rule.expires
  });
}

function invalidRulesetError(error) {
  return new AttestError("E_RULESET_INVALID", "Invalid ruleset supplied to compileRuleset", {
    issues: error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message
    }))
  });
}

function normalizeRule(rule) {
  return freeze({
    cap: DEFAULT_RULE_CAP,
    ...rule
  });
}

function looksCompileReady(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isInteger(value.version) &&
    Array.isArray(value.rules) &&
    value.rules.every((rule) => rule !== null && typeof rule === "object" && !Array.isArray(rule))
  );
}

function validateRulesetShape(ruleset) {
  const parsed = RulesetSchema.safeParse(ruleset);
  if (parsed.success) {
    return parsed.data;
  }

  if (looksCompileReady(ruleset)) {
    return freeze({
      ...ruleset,
      rules: freeze(ruleset.rules.map(normalizeRule))
    });
  }

  throw invalidRulesetError(parsed.error);
}

function readRow(event, mutation) {
  if (mutation.op === "delete") {
    return event.before ?? event.key;
  }

  return event.after ?? event.key;
}

function valueMatches(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function whereMatches(event, mutation) {
  if (mutation.where === undefined) {
    return true;
  }

  const row = readRow(event, mutation);
  if (row === null || typeof row !== "object") {
    return false;
  }

  return Object.entries(mutation.where).every(([key, value]) => valueMatches(row[key], value));
}

function changedMatches(event, mutation) {
  if (!Array.isArray(mutation.changed)) {
    return true;
  }

  const changed = new Set(event.paths.map((path) => path[0]));
  return mutation.changed.every((path) => changed.has(path));
}

function eventMatchesMutation(event, mutation) {
  return (
    entityMatches(mutation.entity, event.entity) &&
    mutation.op === event.op &&
    whereMatches(event, mutation) &&
    changedMatches(event, mutation)
  );
}

function scenarioTransactions(events, expectedMutations) {
  const transactions = new Set();

  for (const event of events) {
    if (event.txId === null) {
      continue;
    }

    const isHarness = event.actor?.kind === "harness";
    const isExpected = expectedMutations.some((mutation) => eventMatchesMutation(event, mutation));
    if (isHarness || isExpected) {
      transactions.add(event.txId);
    }
  }

  return transactions;
}

function createMatcher(rule, options) {
  switch (rule.kind) {
    case "volatile_columns":
      return createVolatileMatcher(rule);
    case "derived":
      return createDerivedMatcher(rule);
    case "external_writer":
      return createExternalWriterMatcher(rule, { dbCaps: options.dbCaps });
    case "ignore":
      return createIgnoreMatcher(rule, { now: options.now });
    default:
      throw new AttestError("E_RULE_KIND_UNKNOWN", `Unknown rule kind ${rule.kind}`, {
        ruleId: rule.id,
        kind: rule.kind
      });
  }
}

function groupMatchers(matchers) {
  return freeze({
    volatile: freeze(matchers.filter((matcher) => matcher.kind === "volatile_columns")),
    derived: freeze(matchers.filter((matcher) => matcher.kind === "derived")),
    external: freeze(matchers.filter((matcher) => matcher.kind === "external_writer")),
    ignore: freeze(matchers.filter((matcher) => matcher.kind === "ignore"))
  });
}

export function compileRuleset({ ruleset, dbCaps, now = defaultClock, expectedMutations = [] }) {
  const loaded = sourceRuleset(ruleset);

  for (const rule of loaded.ruleset.rules ?? []) {
    if (ruleExpired(rule, now)) {
      throw expiredRuleError(rule);
    }
  }

  const rulesetValue = validateRulesetShape(loaded.ruleset);
  const matchers = rulesetValue.rules.map((rule) => createMatcher(rule, { dbCaps, now }));
  const byId = freeze(Object.fromEntries(matchers.map((matcher) => [matcher.id, matcher])));

  return freeze({
    hash: loaded.hash,
    ruleset: rulesetValue,
    expectedMutations: freeze(expectedMutations.map((mutation) => freeze({ ...mutation }))),
    matchersById: byId,
    byId,
    matchers: groupMatchers(matchers),
    all: freeze(matchers)
  });
}

function resetAll(compiled) {
  for (const matcher of compiled.all) {
    matcher.reset?.();
  }
}

function applyVolatile(event, volatileMatchers) {
  let current = event;
  const stripped = [];

  for (const matcher of volatileMatchers) {
    const result = matcher.match(current);
    current = result.event ?? current;
    stripped.push(...(result.volatileStripped ?? []));
  }

  return freeze({
    originalEvent: event,
    event: current,
    volatileStripped: freeze(stripped)
  });
}

function primeMatchers(compiled, transformedEvents, originalEvents) {
  for (const matcher of compiled.matchers.derived) {
    matcher.prime(transformedEvents);
  }

  const transactions = scenarioTransactions(originalEvents, compiled.expectedMutations);
  for (const matcher of compiled.matchers.external) {
    matcher.prime({ scenarioTransactions: transactions });
  }
}

function explainWith(event, matchers) {
  for (const matcher of matchers) {
    const result = matcher.match(event);
    if (result.explained) {
      return result;
    }
  }

  return freeze({ explained: false });
}

function classifyOne(transformed, compiled) {
  const event = transformed.event;
  const derived = explainWith(event, compiled.matchers.derived);
  const external = derived.explained ? derived : explainWith(event, compiled.matchers.external);
  const explained = external.explained ? external : explainWith(event, compiled.matchers.ignore);

  if (explained.explained) {
    return freeze({
      originalEvent: transformed.originalEvent,
      event,
      explained: true,
      touched: true,
      ruleId: explained.ruleId,
      kind: explained.kind,
      volatileStripped: transformed.volatileStripped
    });
  }

  return freeze({
    originalEvent: transformed.originalEvent,
    event,
    explained: false,
    touched: true,
    volatileStripped: transformed.volatileStripped
  });
}

export function createRuleEngine(compiled) {
  let lastResults = freeze([]);

  function classify(events = []) {
    if (!Array.isArray(events)) {
      throw new TypeError("rule engine classify expects an array of ChangeEvent objects");
    }

    resetAll(compiled);
    const transformed = events.map((event) => applyVolatile(event, compiled.matchers.volatile));
    primeMatchers(
      compiled,
      transformed.map(({ event }) => event),
      events
    );
    lastResults = freeze(transformed.map((item) => classifyOne(item, compiled)));
    return lastResults;
  }

  return freeze({
    classify,
    run: classify,
    results() {
      return lastResults;
    },
    stats() {
      return freeze(compiled.all.map((matcher) => matcher.stats()));
    }
  });
}
