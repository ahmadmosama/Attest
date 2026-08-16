import assert from "node:assert/strict";
import test from "node:test";

import { createChangeEvent } from "../../src/db/change-event.mjs";
import { assertDelta } from "../../src/delta/assert.mjs";
import { classifyChanges, createDeltaResult } from "../../src/delta/classify.mjs";
import { formatDeltaFailure, groupUnexplained } from "../../src/delta/failure.mjs";

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

function deltaWithUnexplained(events) {
  return createDeltaResult({
    counts: {
      total: events.length,
      expected: 0,
      explained: 0,
      suppressed_external: 0,
      unexplained: events.length
    },
    buckets: {
      unexplained: events.map((item) => ({ event: item, bucket: "unexplained" }))
    }
  });
}

function context(overrides = {}) {
  return {
    scenarioId: "checkout.guest_purchase",
    surface: "web",
    stepIndex: 7,
    requirements: ["DELTA-01", "DELTA-04"],
    artifactDir: "artifacts/run-123",
    ...overrides
  };
}

test("groupUnexplained groups by entity and operation with a per group cap", () => {
  const events = [
    event({ entity: "public.orders", key: { id: 1 }, op: "update" }),
    event({ entity: "public.orders", key: { id: 2 }, op: "update", seq: 2 }),
    event({ entity: "public.orders", key: { id: 3 }, op: "update", seq: 3 }),
    event({ entity: "public.orders", key: { id: 4 }, op: "delete", before: { id: 4 }, after: null, seq: 4 }),
    event({ entity: "public.audit_log", key: { id: 5 }, op: "insert", before: null, after: { id: 5 }, seq: 5 })
  ];
  const groups = groupUnexplained(events, { perGroup: 2 });

  assert.deepEqual(
    groups.map((group) => [group.entity, group.op, group.count, group.rows.length, group.omitted]),
    [
      ["public.orders", "update", 3, 2, 1],
      ["public.audit_log", "insert", 1, 1, 0],
      ["public.orders", "delete", 1, 1, 0]
    ]
  );
});

test("group ordering is stable by descending count then entity name", () => {
  const groups = groupUnexplained([
    event({ entity: "public.zeta", key: { id: 1 } }),
    event({ entity: "public.alpha", key: { id: 2 }, seq: 2 })
  ]);

  assert.deepEqual(
    groups.map((group) => group.entity),
    ["public.alpha", "public.zeta"]
  );
});

test("rendered unexplained rows show keys and changed columns without row dumps", () => {
  const deltaResult = deltaWithUnexplained([
    event({
      key: { id: 11 },
      paths: [["status"], ["total"]],
      before: { id: 11, status: "pending", total: 10 },
      after: { id: 11, status: "paid", total: 20 }
    })
  ]);
  const output = formatDeltaFailure({ deltaResult, context: context(), perGroup: 5 });

  assert.match(output, /row key \{"id":11\}/);
  assert.match(output, /column status, total/);
  assert.doesNotMatch(output, /pending/);
  assert.doesNotMatch(output, /paid/);
});

test("an empty key renders as unavailable with a replica identity note", () => {
  const groups = groupUnexplained([
    event({
      key: {},
      paths: [["status"]]
    })
  ]);

  assert.equal(groups[0].rows[0].key, "key unavailable");
  assert.match(groups[0].rows[0].notes[0], /REPLICA IDENTITY FULL/);
});

test("the fixed four bucket header is present even for a passing render", () => {
  const deltaResult = createDeltaResult({
    counts: {
      total: 0,
      expected: 0,
      explained: 0,
      suppressed_external: 0,
      unexplained: 0
    }
  });
  const output = formatDeltaFailure({ deltaResult, context: context() });

  assert.match(output.split("\n")[0], /^Delta counts: expected=0 explained=0 suppressed_external=0 unexplained=0$/);
});

test("formatDeltaFailure includes scenario, surface, step, requirements, and artifact directory", () => {
  const deltaResult = deltaWithUnexplained([event()]);
  const output = formatDeltaFailure({ deltaResult, context: context() });

  assert.match(output, /Scenario: checkout\.guest_purchase/);
  assert.match(output, /Surface: web/);
  assert.match(output, /Step: 7/);
  assert.match(output, /Requirements: DELTA-01, DELTA-04/);
  assert.match(output, /Artifacts: artifacts\/run-123/);
});

test("formatDeltaFailure refuses to render without mandatory context", () => {
  const deltaResult = deltaWithUnexplained([event()]);

  assert.throws(
    () => formatDeltaFailure({ deltaResult, context: context({ stepIndex: undefined }) }),
    /context\.stepIndex/
  );
});

test("redacted markers render from keys but raw row values do not", () => {
  const deltaResult = deltaWithUnexplained([
    event({
      key: { id: "[REDACTED:hash:abc]" },
      paths: [["secret_token"]],
      before: { id: "[REDACTED:hash:abc]", secret_token: "raw-token-before" },
      after: { id: "[REDACTED:hash:abc]", secret_token: "raw-token-after" }
    })
  ]);
  const output = formatDeltaFailure({ deltaResult, context: context() });

  assert.match(output, /\[REDACTED:hash:abc\]/);
  assert.match(output, /secret_token/);
  assert.doesNotMatch(output, /raw-token-before/);
  assert.doesNotMatch(output, /raw-token-after/);
  assert.equal(output.includes(String.fromCharCode(27)), false);
});

test("failure text names scenario, step, table, row key and column", () => {
  const deltaResult = classifyChanges({
    events: [
      event({
        entity: "public.orders",
        key: { id: 42 },
        paths: [["status"]],
        before: { id: 42, status: "pending" },
        after: { id: 42, status: "cancelled" }
      })
    ],
    expectations: []
  });
  let error;

  assert.throws(
    () => assertDelta({ deltaResult }),
    (thrown) => {
      error = thrown;
      return thrown.code === "E_DELTA_UNEXPLAINED";
    }
  );

  const output = formatDeltaFailure({ deltaResult, error, context: context({ stepIndex: 3 }) });

  assert.match(output, /Scenario: checkout\.guest_purchase/);
  assert.match(output, /Step: 3/);
  assert.match(output, /table public\.orders/);
  assert.match(output, /row key \{"id":42\}/);
  assert.match(output, /column status/);
});
