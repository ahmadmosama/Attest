import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { diffEntity, diffSnapshots, SNAPSHOT_BLIND_SPOTS } from "../../../src/db/capture/snapshot-diff.mjs";
import { isChangeEvent } from "../../../src/db/change-event.mjs";

const ENTITY = "shop.orders";
const KEY = Object.freeze(["id"]);

function row(id, fields = {}) {
  return { id, status: "created", total_cents: 100, ...fields };
}

function diff(before, after) {
  return diffEntity({ entity: ENTITY, keyColumns: KEY, before, after });
}

describe("snapshot diff", () => {
  test("a new row is an insert carrying the whole row", () => {
    const events = diff([], [row("order_1")]);

    assert.equal(events.length, 1);
    assert.equal(isChangeEvent(events[0]), true);
    assert.equal(events[0].op, "insert");
    assert.equal(events[0].before, null);
    assert.deepEqual(events[0].after, row("order_1"));
    assert.deepEqual(events[0].key, { id: "order_1" });
  });

  test("a missing row is a delete carrying the row that was there", () => {
    const events = diff([row("order_1")], []);

    assert.equal(events[0].op, "delete");
    assert.deepEqual(events[0].before, row("order_1"));
    assert.equal(events[0].after, null);
  });

  test("a changed column is one update, not a delete plus an insert", () => {
    const events = diff([row("order_1")], [row("order_1", { status: "paid" })]);

    // The row has the same declared key, so it is the same row. Reporting a
    // delete and an insert would be two changes where one happened, and every
    // expectation counting rows would be wrong.
    assert.equal(events.length, 1);
    assert.equal(events[0].op, "update");
    assert.deepEqual(events[0].paths, [["status"]]);
    assert.equal(events[0].before.status, "created");
    assert.equal(events[0].after.status, "paid");
  });

  test("an unchanged row produces nothing at all", () => {
    assert.deepEqual(diff([row("order_1")], [row("order_1")]), []);
  });

  test("events carry no ordering and no attribution, because a diff has neither", () => {
    const events = diff([], [row("order_1")]);

    assert.equal(events[0].seq, null);
    assert.equal(events[0].txId, null);
    assert.equal(events[0].actor.kind, "unknown");
  });

  test("output is deterministic in key order, since the engine gives no order", () => {
    const first = diff([], [row("order_3"), row("order_1"), row("order_2")]);
    const second = diff([], [row("order_1"), row("order_2"), row("order_3")]);

    assert.deepEqual(
      first.map((event) => event.key.id),
      ["order_1", "order_2", "order_3"]
    );
    assert.deepEqual(first, second);
  });

  test("a duplicate declared key is refused rather than silently collapsed", () => {
    // Two rows with one key means the declared key is not a key. Keeping one
    // would hide every change to the other.
    assert.throws(() => diff([], [row("order_1"), row("order_1", { status: "paid" })]), {
      code: "E_SNAPSHOT_DIFF_INVALID"
    });
  });

  test("a missing key column and an absent key declaration are both refused", () => {
    assert.throws(() => diffEntity({ entity: ENTITY, keyColumns: KEY, after: [{ status: "created" }] }), {
      code: "E_SNAPSHOT_DIFF_INVALID"
    });
    assert.throws(() => diffEntity({ entity: ENTITY, keyColumns: [], after: [row("order_1")] }), {
      code: "E_SNAPSHOT_DIFF_INVALID"
    });
    assert.throws(() => diffEntity({ entity: "orders", keyColumns: KEY, after: [] }), {
      code: "E_SNAPSHOT_DIFF_INVALID"
    });
  });

  test("a composite key identifies a row across all of its columns", () => {
    const events = diffEntity({
      entity: "shop.order_items",
      keyColumns: ["order_id", "line_number"],
      before: [{ order_id: "order_1", line_number: 1, sku: "lamp" }],
      after: [
        { order_id: "order_1", line_number: 1, sku: "shade" },
        { order_id: "order_1", line_number: 2, sku: "lamp" }
      ]
    });

    assert.equal(events.length, 2);
    assert.equal(events[0].op, "update");
    assert.deepEqual(events[0].paths, [["sku"]]);
    assert.equal(events[1].op, "insert");
  });

  test("the blind spot a diff cannot see is stated, and it is real", () => {
    // A row inserted and deleted inside one window is identical in both
    // snapshots, which is to say absent from both, so nothing is emitted. This
    // is exactly the case a delta engine exists to catch and the reason the
    // SQLite driver has to declare its degradation rather than imply it.
    assert.deepEqual(diff([], []), []);
    assert.equal(
      SNAPSHOT_BLIND_SPOTS.some((entry) => entry.includes("insert then delete")),
      true
    );
    assert.equal(Object.isFrozen(SNAPSHOT_BLIND_SPOTS), true);
  });

  test("diffSnapshots walks entities in declared order", () => {
    const events = diffSnapshots({
      entities: [
        { schema: "shop", table: "orders" },
        { schema: "shop", table: "customers" }
      ],
      keyColumns: { "shop.orders": ["id"], "shop.customers": ["id"] },
      before: new Map([["shop.customers", [{ id: "cust_a", name: "Ada" }]]]),
      after: new Map([
        ["shop.orders", [row("order_1")]],
        ["shop.customers", [{ id: "cust_a", name: "Ada Lovelace" }]]
      ])
    });

    assert.deepEqual(
      events.map((event) => `${event.entity}:${event.op}`),
      ["shop.orders:insert", "shop.customers:update"]
    );
  });
});
