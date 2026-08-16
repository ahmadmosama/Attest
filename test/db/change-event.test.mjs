import assert from "node:assert/strict";
import test from "node:test";

import { AttestError } from "../../src/errors.mjs";
import {
  ACTOR_KINDS,
  CHANGE_OPS,
  FIDELITY_LEVELS,
  changedPaths,
  createChangeEvent,
  isChangeEvent
} from "../../src/db/change-event.mjs";

function baseEvent(overrides = {}) {
  return {
    entity: "public.orders",
    key: { id: 4711 },
    op: "update",
    paths: [["status"], ["total_cents"]],
    before: { status: "pending", total_cents: 1000 },
    after: { total_cents: 1500, status: "paid" },
    txId: "1284712",
    seq: 37,
    actor: { kind: "app_session", applicationName: "shopdemo" },
    fidelity: "full",
    ...overrides
  };
}

test("a well formed insert constructs as a deeply frozen ChangeEvent", () => {
  const event = createChangeEvent(
    baseEvent({
      op: "insert",
      paths: [["id"], ["status"]],
      before: null,
      after: { status: "pending", id: 4711 }
    })
  );

  assert.equal(isChangeEvent(event), true);
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.key), true);
  assert.equal(Object.isFrozen(event.paths), true);
  assert.equal(Object.isFrozen(event.paths[0]), true);
  assert.equal(Object.isFrozen(event.after), true);
  assert.throws(() => {
    event.after.status = "paid";
  });
});

test("closed vocabularies are frozen", () => {
  assert.equal(Object.isFrozen(CHANGE_OPS), true);
  assert.equal(Object.isFrozen(ACTOR_KINDS), true);
  assert.equal(Object.isFrozen(FIDELITY_LEVELS), true);
});

test("invalid op is refused by field with accepted values", () => {
  assert.throws(
    () => createChangeEvent(baseEvent({ op: "replace" })),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_CHANGE_EVENT_INVALID" &&
      error.details.field === "op" &&
      error.details.accepted.includes("insert")
  );
});

test("entity must be schema qualified", () => {
  assert.throws(
    () => createChangeEvent(baseEvent({ entity: "orders" })),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_CHANGE_EVENT_INVALID" &&
      error.details.field === "entity"
  );
});

test("key must be a plain object", () => {
  assert.throws(
    () => createChangeEvent(baseEvent({ key: "4711" })),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_CHANGE_EVENT_INVALID" &&
      error.details.field === "key"
  );
});

test("paths entries must be arrays of strings", () => {
  assert.throws(
    () => createChangeEvent(baseEvent({ paths: [["status"], "total_cents"] })),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_CHANGE_EVENT_INVALID" &&
      error.details.field === "paths[1]"
  );
  assert.throws(
    () => createChangeEvent(baseEvent({ paths: [["status", 1]] })),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_CHANGE_EVENT_INVALID" &&
      error.details.field === "paths[0]"
  );
});

test("actor kind and fidelity are closed vocabularies", () => {
  assert.throws(
    () => createChangeEvent(baseEvent({ actor: { kind: "browser" } })),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_CHANGE_EVENT_INVALID" &&
      error.details.field === "actor.kind" &&
      error.details.accepted.includes("unknown")
  );
  assert.throws(
    () => createChangeEvent(baseEvent({ fidelity: "partial" })),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_CHANGE_EVENT_INVALID" &&
      error.details.field === "fidelity" &&
      error.details.accepted.includes("key_only")
  );
});

test("txId and seq accept null for snapshot capture", () => {
  const event = createChangeEvent(baseEvent({ txId: null, seq: null }));

  assert.equal(event.txId, null);
  assert.equal(event.seq, null);
});

test("before and after are canonicalised at construction", () => {
  const left = createChangeEvent(
    baseEvent({
      before: { b: 2, a: 1 },
      after: { b: 3, a: 1 }
    })
  );
  const right = createChangeEvent(
    baseEvent({
      before: { a: 1, b: 2 },
      after: { a: 1, b: 3 }
    })
  );

  assert.deepEqual(left.before, right.before);
  assert.deepEqual(left.after, right.after);
});

test("key only delete with null after constructs", () => {
  const event = createChangeEvent(
    baseEvent({
      op: "delete",
      paths: [],
      before: { id: 4711 },
      after: null,
      fidelity: "key_only"
    })
  );

  assert.equal(isChangeEvent(event), true);
  assert.equal(event.after, null);
});

test("changedPaths returns every after column for insert", () => {
  const event = createChangeEvent(
    baseEvent({
      op: "insert",
      paths: [],
      before: null,
      after: { b: 2, a: 1 }
    })
  );

  assert.deepEqual(changedPaths(event), [["a"], ["b"]]);
});

test("changedPaths returns only canonical differences for update and delete", () => {
  const update = createChangeEvent(
    baseEvent({
      paths: [["status"], ["total_cents"], ["note"]],
      before: { status: "pending", total_cents: 1000, note: undefined },
      after: { status: "paid", total_cents: 1000, note: null }
    })
  );
  const deletion = createChangeEvent(
    baseEvent({
      op: "delete",
      paths: [["status"]],
      before: { status: "paid" },
      after: null
    })
  );

  assert.deepEqual(changedPaths(update), [["status"]]);
  assert.deepEqual(changedPaths(deletion), [["status"]]);
});
