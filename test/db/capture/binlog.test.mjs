import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, test } from "node:test";

import {
  BINLOG_ROW_EVENT_TYPES,
  normalizeMysqlValue,
  toChangeEventBatch,
  toChangeEvents
} from "../../../src/db/capture/binlog.mjs";
import { isChangeEvent } from "../../../src/db/change-event.mjs";

const KEY_COLUMNS = Object.freeze({ "shop.orders": ["id"] });

function options(overrides = {}) {
  return { keyColumns: KEY_COLUMNS, ...overrides };
}

describe("mysql binlog row events to ChangeEvent", () => {
  test("write_rows is an insert carrying the whole row", () => {
    const [event] = toChangeEvents(
      { type: "write_rows", schema: "shop", table: "orders", rows: [{ id: "order_1", status: "created" }], xid: 42 },
      options()
    );

    assert.equal(isChangeEvent(event), true);
    assert.equal(event.entity, "shop.orders");
    assert.equal(event.op, "insert");
    assert.deepEqual(event.key, { id: "order_1" });
    assert.equal(event.after.status, "created");
    assert.equal(event.before, null);
    // Without the transaction a derived rule could not name its source mutation.
    assert.equal(event.txId, "42");
  });

  test("update_rows carries both images and names only what changed", () => {
    const [event] = toChangeEvents(
      {
        type: "update_rows",
        schema: "shop",
        table: "orders",
        rows: [
          {
            before: { id: "order_1", status: "created", total: 100 },
            after: { id: "order_1", status: "paid", total: 100 }
          }
        ]
      },
      options()
    );

    assert.equal(event.op, "update");
    assert.deepEqual(event.paths, [["status"]]);
    assert.equal(event.before.status, "created");
    assert.equal(event.after.status, "paid");
    assert.equal(event.fidelity, "full");
  });

  test("delete_rows is a delete carrying the row that was there", () => {
    const [event] = toChangeEvents(
      { type: "delete_rows", schema: "shop", table: "orders", rows: [{ id: "order_1", status: "created" }] },
      options()
    );

    assert.equal(event.op, "delete");
    assert.equal(event.before.status, "created");
    assert.equal(event.after, null);
  });

  test("one event carrying several rows becomes several events, numbered", () => {
    // A single binlog row event routinely carries a multi row statement.
    const events = toChangeEvents(
      {
        type: "write_rows",
        schema: "shop",
        table: "orders",
        rows: [{ id: "order_1" }, { id: "order_2" }, { id: "order_3" }]
      },
      options({ startSeq: 5 })
    );

    assert.deepEqual(events.map((event) => event.seq), [5, 6, 7]);
    assert.deepEqual(events.map((event) => event.key.id), ["order_1", "order_2", "order_3"]);
  });

  test("binlog_row_image MINIMAL is reported per event, not assumed away", () => {
    const [updated] = toChangeEvents(
      {
        type: "update_rows",
        schema: "shop",
        table: "orders",
        rows: [{ before: { id: "order_1" }, after: { id: "order_1", status: "paid" } }]
      },
      options({ rowImage: "minimal" })
    );

    // MINIMAL gives the key plus what changed, so the before image is partial.
    // Claiming full fidelity would let a rule compare against values the log
    // never carried.
    assert.equal(updated.fidelity, "value_only");

    const [deleted] = toChangeEvents(
      { type: "delete_rows", schema: "shop", table: "orders", rows: [{ id: "order_1" }] },
      options({ rowImage: "minimal" })
    );

    assert.equal(deleted.fidelity, "key_only");
  });

  test("a STATEMENT format event is refused with the fix, not parsed", () => {
    // Reached only if preflight was bypassed. SQL text cannot yield row images.
    assert.throws(() => toChangeEvents({ type: "query", schema: "shop", table: "orders", rows: [] }, options()), (error) => {
      assert.equal(error.code, "E_BINLOG_EVENT_INVALID");
      assert.equal(error.details.reason, "statement_format_event");
      assert.match(error.details.remediation, /binlog_format=ROW/u);
      return true;
    });
  });

  test("an unknown row event type is refused, never dropped", () => {
    assert.throws(
      () => toChangeEvents({ type: "partial_update_rows", schema: "shop", table: "orders", rows: [] }, options()),
      (error) => {
        assert.equal(error.details.reason, "unknown_event_type");
        assert.deepEqual(error.details.accepted, BINLOG_ROW_EVENT_TYPES);
        return true;
      }
    );
  });

  test("an update row missing its after image is refused rather than guessed", () => {
    assert.throws(
      () =>
        toChangeEvents(
          { type: "update_rows", schema: "shop", table: "orders", rows: [{ before: { id: "order_1" } }] },
          options()
        ),
      { code: "E_BINLOG_EVENT_INVALID" }
    );
  });

  test("a missing table map or key declaration is refused", () => {
    assert.throws(() => toChangeEvents({ type: "write_rows", rows: [{ id: 1 }] }, options()), {
      code: "E_BINLOG_EVENT_INVALID"
    });
    assert.throws(
      () => toChangeEvents({ type: "write_rows", schema: "shop", table: "unknown", rows: [{ id: 1 }] }, options()),
      { code: "E_BINLOG_EVENT_INVALID" }
    );
    assert.throws(
      () => toChangeEvents({ type: "write_rows", schema: "shop", table: "orders", rows: [{ nope: 1 }] }, options()),
      { code: "E_BINLOG_EVENT_INVALID" }
    );
  });

  test("MySQL value shapes normalise, so a row compares equal to itself", () => {
    assert.equal(normalizeMysqlValue(new Date("2026-08-17T00:00:00.000Z")), "2026-08-17T00:00:00.000Z");
    assert.equal(normalizeMysqlValue(Buffer.from("hi")), "aGk=");
    assert.equal(normalizeMysqlValue(9007199254740993n), "9007199254740993");
    assert.equal(normalizeMysqlValue(undefined), null);
    assert.deepEqual(normalizeMysqlValue({ nested: [new Date(0)] }), { nested: ["1970-01-01T00:00:00.000Z"] });
  });

  test("a batch numbers across every event in it", () => {
    const events = toChangeEventBatch(
      [
        { type: "write_rows", schema: "shop", table: "orders", rows: [{ id: "order_1" }, { id: "order_2" }] },
        { type: "delete_rows", schema: "shop", table: "orders", rows: [{ id: "order_1" }] }
      ],
      options()
    );

    assert.deepEqual(events.map((event) => event.seq), [0, 1, 2]);
    assert.deepEqual(events.map((event) => event.op), ["insert", "insert", "delete"]);
    assert.throws(() => toChangeEventBatch("nope", options()), { code: "E_BINLOG_EVENT_INVALID" });
  });
});
