import assert from "node:assert/strict";
import test from "node:test";

import { defineDbCapabilities } from "../../src/capabilities/db-caps.mjs";
import { createChangeEvent } from "../../src/db/change-event.mjs";
import { assertDelta, DELTA_VIOLATIONS } from "../../src/delta/assert.mjs";
import { classifyChanges, createDeltaResult } from "../../src/delta/classify.mjs";
import { AttestError } from "../../src/errors.mjs";

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

function caps(overrides = {}) {
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

function emptyResult(overrides = {}) {
  return createDeltaResult({
    counts: {
      total: 0,
      expected: 0,
      explained: 0,
      suppressed_external: 0,
      unexplained: 0
    },
    ...overrides
  });
}

function expectAttestError(fn) {
  try {
    fn();
  } catch (error) {
    assert(error instanceof AttestError);
    return error;
  }

  assert.fail("expected AttestError");
}

test("DELTA_VIOLATIONS documents deterministic primary code precedence", () => {
  assert.deepEqual(DELTA_VIOLATIONS, [
    "E_DELTA_MISSING_MUTATION",
    "E_DELTA_UNEXPLAINED",
    "E_RULE_TOO_BROAD",
    "E_RULE_EXPIRED",
    "E_DELTA_FIDELITY_INSUFFICIENT"
  ]);
});

test("a balanced window returns ok with the four bucket counts", () => {
  const expectations = [{ entity: "public.orders", op: "update", count: 1 }];
  const deltaResult = classifyChanges({ events: [event()], expectations });
  const result = assertDelta({ deltaResult, expectations });

  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, {
    total: 1,
    expected: 1,
    explained: 0,
    suppressed_external: 0,
    unexplained: 0
  });
});

test("a declared mutation that produced zero matching events fails with missing mutation details", () => {
  const expectations = [{ entity: "public.orders", op: "insert", count: 1 }];
  const deltaResult = classifyChanges({ events: [], expectations });
  const error = expectAttestError(() => assertDelta({ deltaResult, expectations }));

  assert.equal(error.code, "E_DELTA_MISSING_MUTATION");
  assert.match(error.message, /public\.orders insert/);
  assert.equal(error.details.byCode.E_DELTA_MISSING_MUTATION[0].entity, "public.orders");
  assert.equal(error.details.byCode.E_DELTA_MISSING_MUTATION[0].op, "insert");
  assert.equal(error.details.byCode.E_DELTA_MISSING_MUTATION[0].expected, 1);
  assert.equal(error.details.byCode.E_DELTA_MISSING_MUTATION[0].observed, 0);
});

test("a declared mutation with expected two and observed one reports both counts", () => {
  const expectations = [{ entity: "public.orders", op: "update", count: 2 }];
  const deltaResult = classifyChanges({ events: [event()], expectations });
  const error = expectAttestError(() => assertDelta({ deltaResult, expectations }));

  assert.equal(error.code, "E_DELTA_MISSING_MUTATION");
  assert.equal(error.details.byCode.E_DELTA_MISSING_MUTATION[0].expected, 2);
  assert.equal(error.details.byCode.E_DELTA_MISSING_MUTATION[0].observed, 1);
  assert.equal(error.details.byCode.E_DELTA_MISSING_MUTATION[0].missing, 1);
});

test("one unexplained change fails by default and reports the count", () => {
  const deltaResult = classifyChanges({
    events: [event({ entity: "public.customers", key: { id: 9 } })],
    expectations: []
  });
  const error = expectAttestError(() => assertDelta({ deltaResult }));

  assert.equal(error.code, "E_DELTA_UNEXPLAINED");
  assert.equal(error.details.byCode.E_DELTA_UNEXPLAINED[0].count, 1);
});

test("rule cap violations fail as rule too broad and name every offending rule", () => {
  const deltaResult = emptyResult();
  const error = expectAttestError(() =>
    assertDelta({
      deltaResult,
      capViolations: [
        { ruleId: "wide_ignore", kind: "ignore", reason: "absolute_cap", count: 51, cap: 50 },
        { ruleId: "wide_derived", kind: "derived", reason: "declared_cardinality", count: 4, cap: 1 }
      ]
    })
  );

  assert.equal(error.code, "E_RULE_TOO_BROAD");
  assert.deepEqual(
    error.details.byCode.E_RULE_TOO_BROAD.map((violation) => violation.ruleId),
    ["wide_ignore", "wide_derived"]
  );
});

test("expired ignores fail and name the rule and expiry date", () => {
  const deltaResult = emptyResult();
  const error = expectAttestError(() =>
    assertDelta({
      deltaResult,
      health: {
        dead: [],
        expired: [{ ruleId: "old_ignore", expires: "2026-08-15" }],
        expiringSoon: []
      }
    })
  );

  assert.equal(error.code, "E_RULE_EXPIRED");
  assert.equal(error.details.byCode.E_RULE_EXPIRED[0].ruleId, "old_ignore");
  assert.equal(error.details.byCode.E_RULE_EXPIRED[0].expires, "2026-08-15");
});

test("multiple violation classes are all reported with precedence deciding primary code", () => {
  const expectations = [{ entity: "public.orders", op: "delete", count: 1 }];
  const deltaResult = classifyChanges({
    events: [event({ entity: "public.customers", key: { id: 2 } })],
    expectations
  });
  const error = expectAttestError(() =>
    assertDelta({
      deltaResult,
      expectations,
      capViolations: [{ ruleId: "too_wide", reason: "absolute_cap", count: 3, cap: 1 }],
      health: {
        dead: [],
        expired: [{ ruleId: "expired_ignore", expires: "2026-08-15" }],
        expiringSoon: []
      }
    })
  );

  assert.equal(error.code, "E_DELTA_MISSING_MUTATION");
  assert.equal(error.details.byCode.E_DELTA_MISSING_MUTATION.length, 1);
  assert.equal(error.details.byCode.E_DELTA_UNEXPLAINED.length, 1);
  assert.equal(error.details.byCode.E_RULE_TOO_BROAD.length, 1);
  assert.equal(error.details.byCode.E_RULE_EXPIRED.length, 1);
});

test("requireNoUnexplained false relaxes only unexplained changes", () => {
  const expectations = [{ entity: "public.orders", op: "delete", count: 1 }];
  const deltaResult = classifyChanges({
    events: [event({ entity: "public.customers", key: { id: 2 } })],
    expectations
  });
  const error = expectAttestError(() =>
    assertDelta({ deltaResult, expectations, requireNoUnexplained: false })
  );

  assert.equal(error.code, "E_DELTA_MISSING_MUTATION");
  assert.equal(error.details.byCode.E_DELTA_UNEXPLAINED.length, 0);

  const unexplainedOnly = classifyChanges({
    events: [event({ entity: "public.customers", key: { id: 2 } })],
    expectations: []
  });
  assert.equal(assertDelta({ deltaResult: unexplainedOnly, requireNoUnexplained: false }).ok, true);
});

test("changed column assertions against key only fidelity are refused with a replica identity hint", () => {
  const expectations = [{ entity: "public.orders", op: "update", count: 1, changed: ["status"] }];
  const keyOnlyEvent = event({
    paths: [],
    before: null,
    after: { id: 1, status: "paid" },
    fidelity: "key_only"
  });
  const deltaResult = createDeltaResult({
    counts: {
      total: 1,
      expected: 1,
      explained: 0,
      suppressed_external: 0,
      unexplained: 0
    },
    buckets: {
      expected: [{ event: keyOnlyEvent, bucket: "expected", expectationIndex: 0 }]
    }
  });
  const error = expectAttestError(() =>
    assertDelta({
      deltaResult,
      expectations,
      capabilities: caps({
        beforeImages: "key_only",
        degraded: ["REPLICA IDENTITY FULL is missing on public.orders; before images are key only."]
      })
    })
  );

  assert.equal(error.code, "E_DELTA_FIDELITY_INSUFFICIENT");
  assert.equal(error.details.byCode.E_DELTA_FIDELITY_INSUFFICIENT[0].entity, "public.orders");
  assert.deepEqual(error.details.byCode.E_DELTA_FIDELITY_INSUFFICIENT[0].changed, ["status"]);
  assert.match(error.details.byCode.E_DELTA_FIDELITY_INSUFFICIENT[0].remediation, /REPLICA IDENTITY FULL/);
});

test("dead rules are reported but never affect the verdict", () => {
  const deltaResult = emptyResult();
  const result = assertDelta({
    deltaResult,
    health: {
      dead: [{ ruleId: "unused_rule", proposedAction: "delete_rule" }],
      expired: [],
      expiringSoon: []
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.deadRules, [{ ruleId: "unused_rule", proposedAction: "delete_rule" }]);
});
