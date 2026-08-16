import assert from "node:assert/strict";
import test from "node:test";

import { defineDbCapabilities } from "../../src/capabilities/db-caps.mjs";
import { createChangeEvent } from "../../src/db/change-event.mjs";
import { BUCKETS, classifyChanges, createDeltaResult } from "../../src/delta/classify.mjs";
import { compileRuleset, createRuleEngine } from "../../src/delta/rules/engine.mjs";
import { hashRuleset } from "../../src/delta/rules/hash.mjs";

function postgresCaps() {
  return defineDbCapabilities({
    driver: "postgres",
    capture: "logical_slot",
    deltaAssertion: true,
    boundedPolling: true,
    beforeImages: "full",
    ordering: true,
    txAttribution: true,
    watermarkFencing: "inline",
    transactionalTeardown: true
  });
}

function ruleset(rules) {
  return { version: 1, rules };
}

function event(overrides = {}) {
  return createChangeEvent({
    entity: "public.orders",
    key: { id: 1 },
    op: "update",
    paths: [["status"]],
    before: { id: 1, status: "pending" },
    after: { id: 1, status: "paid" },
    txId: "tx_app",
    seq: 1,
    actor: { kind: "app_session", applicationName: "shopdemo" },
    fidelity: "full",
    ...overrides
  });
}

function orderDelete(seq = 1, overrides = {}) {
  return event({
    op: "delete",
    paths: [["id"]],
    before: { id: seq },
    after: null,
    txId: "tx_delete",
    seq,
    ...overrides
  });
}

function auditInsert(seq = 2, overrides = {}) {
  return event({
    entity: "public.audit_log",
    key: { id: seq },
    op: "insert",
    paths: [],
    before: null,
    after: { id: seq, order_id: 1, action: "delete" },
    txId: `tx_audit_${seq}`,
    seq,
    actor: { kind: "unknown" },
    ...overrides
  });
}

function jobInsert(seq, txId = `tx_job_${seq}`, overrides = {}) {
  return event({
    entity: "public.jobs",
    key: { id: seq },
    op: "insert",
    paths: [],
    before: null,
    after: { id: seq, status: "queued" },
    txId,
    seq,
    actor: { kind: "external", applicationName: "worker" },
    ...overrides
  });
}

function derivedRule(overrides = {}) {
  return {
    id: "order_delete_audit",
    kind: "derived",
    entity: "public.audit_log",
    caused_by: { entity: "public.orders", op: "delete" },
    mechanism: "trigger",
    per_source: 1,
    cap: 50,
    ...overrides
  };
}

function externalRule(overrides = {}) {
  return {
    id: "background_jobs",
    kind: "external_writer",
    entity: "public.jobs",
    identity: { by: "transaction", not_in: "scenario_transactions" },
    cap: 50,
    ...overrides
  };
}

function ignoreRule(overrides = {}) {
  return {
    id: "temporary_ignore",
    kind: "ignore",
    entity: "public.ignored_log",
    reason: "Temporary migration cleanup.",
    expires: "2099-01-01",
    cap: 50,
    ...overrides
  };
}

function engineFor({ suppressions = [], expectations = [] } = {}) {
  const value = ruleset(suppressions);
  const compiled = compileRuleset({
    ruleset: value,
    dbCaps: postgresCaps(),
    expectedMutations: expectations,
    now: () => new Date("2026-08-16T00:00:00Z")
  });

  return {
    engine: createRuleEngine(compiled),
    rulesetHash: hashRuleset(value)
  };
}

test("BUCKETS is the closed four bucket vocabulary", () => {
  assert.deepEqual(BUCKETS, ["expected", "explained", "suppressed_external", "unexplained"]);
  assert.equal(Object.isFrozen(BUCKETS), true);
});

test("expected mutations win over rules and consume only their declared budget", () => {
  const expectations = [{ entity: "public.orders", op: "update", count: 2 }];
  const first = event({ seq: 1, key: { id: 1 } });
  const second = event({ seq: 2, key: { id: 2 } });
  const third = event({ seq: 3, key: { id: 3 } });
  const { engine } = engineFor({
    suppressions: [
      {
        id: "ignore_orders",
        kind: "ignore",
        entity: "public.orders",
        reason: "Temporary migration cleanup.",
        expires: "2099-01-01",
        cap: 50
      }
    ],
    expectations
  });
  const result = classifyChanges({ events: [third, second, first], expectations, engine });

  assert.equal(result.counts.expected, 2);
  assert.deepEqual(
    result.buckets.expected.map((entry) => entry.event.seq).toSorted(),
    [1, 2]
  );
  assert.equal(result.buckets.explained[0].event.seq, 3);
  assert.equal(result.buckets.explained[0].ruleId, "ignore_orders");
});

test("a matching derived rule lands in explained with the rule id recorded", () => {
  const expectations = [{ entity: "public.orders", op: "delete", count: 1 }];
  const source = orderDelete(1);
  const audit = auditInsert(2);
  const { engine } = engineFor({ suppressions: [derivedRule()], expectations });
  const result = classifyChanges({ events: [source, audit], expectations, engine });

  assert.equal(result.counts.expected, 1);
  assert.equal(result.counts.explained, 1);
  assert.equal(result.buckets.explained[0].ruleId, "order_delete_audit");
});

test("ignore rules are explained and external writer rules are suppressed external", () => {
  const ignored = event({
    entity: "public.ignored_log",
    key: { id: 1 },
    op: "insert",
    paths: [],
    before: null,
    after: { id: 1 },
    seq: 1
  });
  const job = jobInsert(2, "tx_worker");
  const { engine } = engineFor({
    suppressions: [ignoreRule(), externalRule()],
    expectations: []
  });
  const result = classifyChanges({ events: [ignored, job], engine });

  assert.equal(result.counts.explained, 1);
  assert.equal(result.counts.suppressed_external, 1);
  assert.equal(result.buckets.explained[0].ruleId, "temporary_ignore");
  assert.equal(result.buckets.suppressed_external[0].ruleId, "background_jobs");
});

test("where predicates use canonical after images for inserts and updates and before for deletes", () => {
  const inserted = event({
    op: "insert",
    paths: [],
    before: null,
    after: { id: 1, amount: 10n },
    seq: 1
  });
  const updated = event({
    before: { id: 2, amount: 10 },
    after: { id: 2, amount: 20 },
    seq: 2
  });
  const deleted = event({
    op: "delete",
    paths: [["id"]],
    before: { id: 3, archived: true },
    after: null,
    seq: 3
  });
  const expectations = [
    { entity: "public.orders", op: "insert", count: 1, where: { amount: "10" } },
    { entity: "public.orders", op: "update", count: 1, where: { amount: 20 } },
    { entity: "public.orders", op: "delete", count: 1, where: { archived: true } }
  ];
  const result = classifyChanges({ events: [inserted, updated, deleted], expectations });

  assert.equal(result.counts.expected, 3);
});

test("an event matching nothing is unexplained and fails the result", () => {
  const unmatched = event({
    entity: "public.customers",
    key: { id: 99 },
    before: { id: 99, name: "A" },
    after: { id: 99, name: "B" },
    txId: "tx_customer",
    seq: 10
  });
  const result = classifyChanges({ events: [unmatched] });

  assert.equal(result.counts.unexplained, 1);
  assert.equal(result.failed, true);
  assert.deepEqual(result.failureReasons, ["unexplained_changes"]);
});

test("over broad rule stats fail the result as rule_too_broad", () => {
  const result = createDeltaResult({
    counts: {
      total: 1,
      expected: 0,
      explained: 1,
      suppressed_external: 0,
      unexplained: 0
    },
    ruleStats: [
      {
        id: "temporary_ignore",
        kind: "ignore",
        entity: "public.orders",
        suppressed: 2,
        overBudget: 0,
        cap: 1
      }
    ]
  });

  assert.equal(result.failed, true);
  assert.equal(result.capViolations[0].code, "rule_too_broad");
  assert.deepEqual(result.failureReasons, ["rule_too_broad"]);
});

test("classification is total across a mixed randomised event set", () => {
  const events = Array.from({ length: 60 }, (_, index) =>
    event({
      entity: index % 3 === 0 ? "public.orders" : `public.unmatched_${index}`,
      key: { id: index },
      before: { id: index, status: "old" },
      after: { id: index, status: "new" },
      seq: 60 - index
    })
  );
  const expectations = [{ entity: "public.orders", op: "update", count: 20 }];
  const result = classifyChanges({ events, expectations });
  const bucketMembers = BUCKETS.flatMap((bucket) => result.buckets[bucket].map((entry) => entry.event));
  const bucketTotal = BUCKETS.reduce((sum, bucket) => sum + result.counts[bucket], 0);

  assert.equal(bucketTotal, events.length);
  assert.equal(result.counts.total, events.length);
  assert.equal(bucketMembers.length, events.length);
  assert.equal(new Set(bucketMembers).size, events.length);
});

test("createDeltaResult returns a deeply frozen result with rule stats and hash", () => {
  const result = createDeltaResult({
    counts: {
      total: 0,
      expected: 0,
      explained: 0,
      suppressed_external: 0,
      unexplained: 0
    },
    buckets: {},
    ruleStats: [{ id: "quiet_rule", kind: "ignore", suppressed: 0, overBudget: 0, cap: 50 }],
    rulesetHash: "abc123",
    expectationShortfalls: [{ index: 0, missing: 1 }]
  });

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.counts), true);
  assert.equal(Object.isFrozen(result.ruleStats[0]), true);
  assert.equal(result.rulesetHash, "abc123");
  assert.deepEqual(result.expectationShortfalls, [{ index: 0, missing: 1 }]);
});
