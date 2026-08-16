import assert from "node:assert/strict";
import test from "node:test";

import { createChangeEvent } from "../../../src/db/change-event.mjs";
import { createDerivedMatcher } from "../../../src/delta/rules/derived.mjs";
import { createIgnoreMatcher } from "../../../src/delta/rules/ignore.mjs";
import { createVolatileMatcher } from "../../../src/delta/rules/volatile.mjs";

function event(overrides = {}) {
  return createChangeEvent({
    entity: "public.orders",
    key: { id: 1 },
    op: "update",
    paths: [["status"], ["updated_at"]],
    before: { id: 1, status: "pending", updated_at: "2026-01-01T00:00:00Z" },
    after: { id: 1, status: "paid", updated_at: "2026-01-01T00:01:00Z" },
    txId: "tx_app",
    seq: 1,
    actor: { kind: "app_session", applicationName: "shopdemo" },
    fidelity: "full",
    ...overrides
  });
}

function volatileRule(overrides = {}) {
  return {
    id: "volatile_order_dates",
    kind: "volatile_columns",
    entity: "public.orders",
    paths: ["updated_at"],
    cap: 50,
    ...overrides
  };
}

function ignoreRule(overrides = {}) {
  return {
    id: "temporary_ignore",
    kind: "ignore",
    entity: "public.orders",
    op: "update",
    reason: "Temporary known write.",
    expires: "2026-08-16",
    cap: 50,
    ...overrides
  };
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

function orderDelete(seq = 1, overrides = {}) {
  return event({
    op: "delete",
    paths: [["id"]],
    before: { id: seq },
    after: null,
    txId: `tx_delete_${seq}`,
    seq,
    ...overrides
  });
}

function auditInsert(seq, overrides = {}) {
  return event({
    entity: "public.audit_log",
    key: { id: seq },
    op: "insert",
    paths: [],
    before: null,
    after: { id: seq, order_id: 1, action: "delete" },
    txId: `tx_audit_${seq}`,
    seq,
    ...overrides
  });
}

test("volatile strips matching update paths without explaining the row", () => {
  const matcher = createVolatileMatcher(volatileRule());
  const result = matcher.match(event());

  assert.equal(result.explained, false);
  assert.equal(result.touched, true);
  assert.deepEqual(result.event.paths, [["status"]]);
  assert.deepEqual(result.event.volatileStripped, ["updated_at"]);
  assert.deepEqual(matcher.stats(), {
    id: "volatile_order_dates",
    kind: "volatile_columns",
    entity: "public.orders",
    suppressed: 1,
    overBudget: 0,
    cap: 50
  });
});

test("a row with only volatile movement remains touched and unexplained", () => {
  const matcher = createVolatileMatcher(volatileRule());
  const result = matcher.match(
    event({
      paths: [["updated_at"]],
      before: { id: 1, updated_at: "2026-01-01T00:00:00Z" },
      after: { id: 1, updated_at: "2026-01-01T00:01:00Z" }
    })
  );

  assert.equal(result.explained, false);
  assert.equal(result.touched, true);
  assert.deepEqual(result.event.paths, []);
});

test("volatile glob matches a single path segment by prefix and suffix", () => {
  const matcher = createVolatileMatcher(volatileRule({ paths: ["*_at"] }));
  const result = matcher.match(
    event({
      paths: [["created_at"], ["updated_at"], ["at_risk"]],
      before: { created_at: "a", updated_at: "a", at_risk: "a" },
      after: { created_at: "b", updated_at: "b", at_risk: "b" }
    })
  );

  assert.deepEqual(result.event.paths, [["at_risk"]]);
  assert.deepEqual(result.volatileStripped, ["created_at", "updated_at"]);
});

test("volatile never applies to inserts or deletes", () => {
  const matcher = createVolatileMatcher(volatileRule());
  const insert = matcher.match(
    event({
      op: "insert",
      paths: [],
      before: null,
      after: { id: 1, updated_at: "2026-01-01T00:00:00Z" }
    })
  );
  const deletion = matcher.match(orderDelete());

  assert.equal(insert.touched, false);
  assert.equal(deletion.touched, false);
  assert.deepEqual(insert.event.paths, []);
  assert.deepEqual(deletion.event.paths, [["id"]]);
  assert.equal(matcher.stats().suppressed, 0);
});

test("ignore matches entity and op and uses an injected inclusive expiry date", () => {
  const matcher = createIgnoreMatcher(ignoreRule(), {
    now: () => new Date("2026-08-16T23:59:59Z")
  });

  assert.equal(matcher.isExpired(new Date("2026-08-16T23:59:59Z")), false);
  assert.deepEqual(matcher.match(event()), {
    explained: true,
    ruleId: "temporary_ignore",
    kind: "ignore"
  });
  assert.equal(matcher.match(event({ op: "delete" })).explained, false);
  assert.equal(matcher.stats().suppressed, 1);
});

test("ignore reports expiry without throwing from the match loop", () => {
  const matcher = createIgnoreMatcher(ignoreRule({ expires: "2026-08-15" }), {
    now: () => new Date("2026-08-16T00:00:00Z")
  });

  assert.equal(matcher.isExpired(), true);
  assert.equal(matcher.match(event()).explained, false);
  assert.equal(matcher.stats().suppressed, 0);
});

test("derived explains one audit row for one observed source delete", () => {
  const matcher = createDerivedMatcher(derivedRule());
  const source = orderDelete(1);
  const audit = auditInsert(2);

  matcher.prime([source, audit]);

  assert.equal(matcher.match(audit).explained, true);
  assert.deepEqual(matcher.stats(), {
    id: "order_delete_audit",
    kind: "derived",
    entity: "public.audit_log",
    suppressed: 1,
    overBudget: 0,
    cap: 50
  });
});

test("derived leaves forty six audit rows unexplained from one source delete and forty seven audit rows", () => {
  const matcher = createDerivedMatcher(derivedRule());
  const source = orderDelete(1);
  const audits = Array.from({ length: 47 }, (_, index) => auditInsert(index + 2));

  matcher.prime([source, ...audits]);
  const results = audits.map((audit) => matcher.match(audit));

  assert.equal(results.filter((result) => result.explained).length, 1);
  assert.equal(results.filter((result) => !result.explained).length, 46);
  assert.equal(matcher.stats().suppressed, 1);
  assert.equal(matcher.stats().overBudget, 46);
});

test("derived budget is based on observed sources, not declared scenario counts", () => {
  const matcher = createDerivedMatcher(derivedRule({ per_source: 1 }));
  const source = orderDelete(1);
  const audits = [auditInsert(2), auditInsert(3), auditInsert(4)];

  matcher.prime([source, ...audits]);
  const results = audits.map((audit) => matcher.match(audit));

  assert.deepEqual(
    results.map((result) => result.explained),
    [true, false, false]
  );
  assert.equal(matcher.stats().overBudget, 2);
});

test("derived explains three targets for three observed source deletes", () => {
  const matcher = createDerivedMatcher(derivedRule());
  const sources = [orderDelete(1), orderDelete(2), orderDelete(3)];
  const audits = [auditInsert(4), auditInsert(5), auditInsert(6)];

  matcher.prime([...sources, ...audits]);

  assert.equal(audits.filter((audit) => matcher.match(audit).explained).length, 3);
  assert.equal(matcher.stats().suppressed, 3);
});

test("derived with no observed source has zero budget and explains nothing", () => {
  const matcher = createDerivedMatcher(derivedRule());
  const audit = auditInsert(10);

  matcher.prime([audit]);

  assert.equal(matcher.match(audit).explained, false);
  assert.equal(matcher.stats().suppressed, 0);
  assert.equal(matcher.stats().overBudget, 1);
});

test("derived budget consumption is deterministic by seq order", () => {
  const matcher = createDerivedMatcher(derivedRule());
  const source = orderDelete(1);
  const late = auditInsert(20);
  const early = auditInsert(2);

  matcher.prime([source, late, early]);

  assert.equal(matcher.match(late).explained, false);
  assert.equal(matcher.match(early).explained, true);
  assert.equal(matcher.stats().overBudget, 1);
});
