import assert from "node:assert/strict";
import test from "node:test";

import { defineDbCapabilities, NOT_IMPLEMENTED_DB_CAPS } from "../../../src/capabilities/db-caps.mjs";
import { createChangeEvent } from "../../../src/db/change-event.mjs";
import { compileRuleset, createRuleEngine } from "../../../src/delta/rules/engine.mjs";
import { hashRuleset } from "../../../src/delta/rules/hash.mjs";
import { AttestError } from "../../../src/errors.mjs";

function postgresCaps(overrides = {}) {
  return defineDbCapabilities({
    driver: "postgres",
    capture: "logical_slot",
    deltaAssertion: true,
    boundedPolling: true,
    beforeImages: "full",
    ordering: true,
    txAttribution: true,
    watermarkFencing: "inline",
    transactionalTeardown: true,
    ...overrides
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

function jobInsert(seq, txId, overrides = {}) {
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
    entity: "public.audit_log",
    reason: "Temporary migration cleanup.",
    expires: "2099-01-01",
    cap: 50,
    ...overrides
  };
}

test("transaction external writer matches only transactions outside scenario transactions", () => {
  const compiled = compileRuleset({
    ruleset: ruleset([externalRule()]),
    dbCaps: postgresCaps(),
    expectedMutations: [{ entity: "public.orders", op: "delete", count: 1 }],
    now: () => new Date("2026-08-16T12:00:00Z")
  });
  const engine = createRuleEngine(compiled);
  const source = orderDelete();
  const appJob = jobInsert(2, "tx_delete");
  const externalJob = jobInsert(3, "tx_worker");
  const results = engine.classify([source, appJob, externalJob]);

  assert.equal(results[1].explained, false);
  assert.equal(results[2].explained, true);
  assert.equal(results[2].ruleId, "background_jobs");
  assert.equal(engine.stats()[0].suppressed, 1);
});

test("application name predicate requires a driver reported attribution capability", () => {
  assert.throws(
    () =>
      compileRuleset({
        ruleset: ruleset([
          externalRule({
            identity: { by: "application_name", not_equals: "shopdemo" }
          })
        ]),
        dbCaps: postgresCaps(),
        now: () => new Date("2026-08-16T12:00:00Z")
      }),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_RULE_IDENTITY_UNSUPPORTED" &&
      error.details.ruleId === "background_jobs" &&
      error.details.driver === "postgres"
  );

  const compiled = compileRuleset({
    ruleset: ruleset([
      externalRule({
        identity: { by: "application_name", not_equals: "shopdemo" }
      })
    ]),
    dbCaps: { driver: "custom", applicationNameAttribution: true },
    now: () => new Date("2026-08-16T12:00:00Z")
  });
  const engine = createRuleEngine(compiled);
  const results = engine.classify([jobInsert(1, "tx_worker")]);

  assert.equal(results[0].explained, true);
  assert.equal(results[0].ruleId, "background_jobs");
});

test("transaction predicate requires transaction attribution", () => {
  assert.throws(
    () =>
      compileRuleset({
        ruleset: ruleset([externalRule()]),
        dbCaps: NOT_IMPLEMENTED_DB_CAPS,
        now: () => new Date("2026-08-16T12:00:00Z")
      }),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_RULE_IDENTITY_UNSUPPORTED" &&
      error.details.ruleId === "background_jobs" &&
      error.details.driver === "none"
  );
});

test("compileRuleset returns hash and matchers keyed by rule id", () => {
  const value = ruleset([derivedRule(), ignoreRule()]);
  const compiled = compileRuleset({
    ruleset: value,
    dbCaps: postgresCaps(),
    now: () => new Date("2026-08-16T12:00:00Z")
  });

  assert.equal(compiled.hash, hashRuleset(value));
  assert.equal(compiled.byId.order_delete_audit.kind, "derived");
  assert.equal(compiled.matchersById.temporary_ignore.kind, "ignore");
});

test("compileRuleset refuses expired ignore rules by rule id and expiry date", () => {
  assert.throws(
    () =>
      compileRuleset({
        ruleset: ruleset([ignoreRule({ expires: "2026-08-15" })]),
        dbCaps: postgresCaps(),
        now: () => new Date("2026-08-16T00:00:00Z")
      }),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_RULE_EXPIRED" &&
      error.details.ruleId === "temporary_ignore" &&
      error.details.expires === "2026-08-15"
  );
});

test("engine runs volatile, derived, external writer, then ignore", () => {
  const compiled = compileRuleset({
    ruleset: ruleset([
      {
        id: "volatile_order_dates",
        kind: "volatile_columns",
        entity: "public.orders",
        paths: ["updated_at"],
        cap: 50
      },
      derivedRule(),
      externalRule({ entity: "public.audit_log" }),
      ignoreRule()
    ]),
    dbCaps: postgresCaps(),
    expectedMutations: [{ entity: "public.orders", op: "delete", count: 1 }],
    now: () => new Date("2026-08-16T12:00:00Z")
  });
  const engine = createRuleEngine(compiled);
  const volatileOnly = event({
    paths: [["updated_at"]],
    before: { id: 1, updated_at: "a" },
    after: { id: 1, updated_at: "b" }
  });
  const source = orderDelete(2);
  const audit = auditInsert(3);
  const results = engine.classify([volatileOnly, source, audit]);

  assert.equal(results[0].explained, false);
  assert.deepEqual(results[0].event.paths, []);
  assert.deepEqual(results[0].volatileStripped, ["updated_at"]);
  assert.equal(results[2].explained, true);
  assert.equal(results[2].ruleId, "order_delete_audit");
  assert.deepEqual(
    engine.stats().map(({ id, suppressed }) => [id, suppressed]),
    [
      ["volatile_order_dates", 1],
      ["order_delete_audit", 1],
      ["background_jobs", 0],
      ["temporary_ignore", 0]
    ]
  );
});

test("engine reports every rule including zero fire rules and never drops events", () => {
  const compiled = compileRuleset({
    ruleset: ruleset([derivedRule(), externalRule(), ignoreRule()]),
    dbCaps: postgresCaps(),
    expectedMutations: [{ entity: "public.orders", op: "delete", count: 1 }],
    now: () => new Date("2026-08-16T12:00:00Z")
  });
  const engine = createRuleEngine(compiled);
  const unmatched = event({
    entity: "public.customers",
    key: { id: 99 },
    before: { id: 99, name: "A" },
    after: { id: 99, name: "B" },
    txId: "tx_customer",
    seq: 10
  });
  const results = engine.run([unmatched]);

  assert.equal(results.length, 1);
  assert.equal(results[0].explained, false);
  assert.deepEqual(engine.stats(), [
    {
      id: "order_delete_audit",
      kind: "derived",
      entity: "public.audit_log",
      suppressed: 0,
      overBudget: 0,
      cap: 50
    },
    {
      id: "background_jobs",
      kind: "external_writer",
      entity: "public.jobs",
      suppressed: 0,
      overBudget: 0,
      cap: 50
    },
    {
      id: "temporary_ignore",
      kind: "ignore",
      entity: "public.audit_log",
      suppressed: 0,
      overBudget: 0,
      cap: 50
    }
  ]);
});
