import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isLifecycleEvent,
  normalizeBson,
  toChangeEvent,
  toChangeEvents
} from "../../../src/db/capture/change-stream.mjs";
import { isChangeEvent } from "../../../src/db/change-event.mjs";

// A stand in for a BSON ObjectId: an object with _bsontype and a meaningful
// toString, which is the shape every BSON wrapper has.
function objectId(hex) {
  return { _bsontype: "ObjectId", toString: () => hex };
}

const NS = Object.freeze({ db: "shop", coll: "orders" });

function insertDocument(overrides = {}) {
  return {
    _id: { _data: "resume-1" },
    operationType: "insert",
    ns: NS,
    documentKey: { _id: objectId("64b7f0aa11") },
    fullDocument: { _id: objectId("64b7f0aa11"), status: "created", total: 9900 },
    ...overrides
  };
}

describe("mongo change stream to ChangeEvent", () => {
  test("an insert carries the whole document and a canonical key", () => {
    const event = toChangeEvent(insertDocument(), { seq: 0 });

    assert.equal(isChangeEvent(event), true);
    assert.equal(event.entity, "shop.orders");
    assert.equal(event.op, "insert");
    assert.deepEqual(event.key, { _id: "64b7f0aa11" });
    assert.equal(event.after.status, "created");
    assert.equal(event.before, null);
    assert.equal(event.fidelity, "full");
  });

  test("an update names exactly the fields that changed, not a whole document diff", () => {
    const event = toChangeEvent(
      {
        operationType: "update",
        ns: NS,
        documentKey: { _id: objectId("64b7f0aa11") },
        updateDescription: {
          updatedFields: { status: "paid", "shipping.city": "Cairo" },
          removedFields: ["coupon"]
        },
        fullDocument: { _id: objectId("64b7f0aa11"), status: "paid" }
      },
      { seq: 1 }
    );

    assert.equal(event.op, "update");
    // updateDescription is more precise than comparing two documents, which is
    // the reason a change stream beats polling here.
    assert.deepEqual(event.paths, [["coupon"], ["shipping", "city"], ["status"]]);
    // Without pre images the before values are unknown, and saying so stops a
    // rule comparing against a before image that does not exist.
    assert.equal(event.fidelity, "value_only");
    assert.equal(event.before, null);
  });

  test("an update with pre images enabled is full fidelity", () => {
    const event = toChangeEvent(
      {
        operationType: "update",
        ns: NS,
        documentKey: { _id: objectId("64b7f0aa11") },
        updateDescription: { updatedFields: { status: "paid" }, removedFields: [] },
        fullDocumentBeforeChange: { _id: objectId("64b7f0aa11"), status: "created" },
        fullDocument: { _id: objectId("64b7f0aa11"), status: "paid" }
      },
      { seq: 2 }
    );

    assert.equal(event.fidelity, "full");
    assert.equal(event.before.status, "created");
    assert.equal(event.after.status, "paid");
  });

  test("a replace is an update, because the document is the same document", () => {
    const event = toChangeEvent(
      {
        operationType: "replace",
        ns: NS,
        documentKey: { _id: objectId("64b7f0aa11") },
        fullDocument: { _id: objectId("64b7f0aa11"), status: "refunded" }
      },
      { seq: 3 }
    );

    assert.equal(event.op, "update");
    assert.deepEqual(event.paths, [["_id"], ["status"]]);
  });

  test("a delete is key only unless pre images are on", () => {
    const withoutPreImage = toChangeEvent(
      { operationType: "delete", ns: NS, documentKey: { _id: objectId("64b7f0aa11") } },
      { seq: 4 }
    );

    assert.equal(withoutPreImage.op, "delete");
    assert.equal(withoutPreImage.after, null);
    assert.equal(withoutPreImage.fidelity, "key_only");

    const withPreImage = toChangeEvent(
      {
        operationType: "delete",
        ns: NS,
        documentKey: { _id: objectId("64b7f0aa11") },
        fullDocumentBeforeChange: { _id: objectId("64b7f0aa11"), status: "created" }
      },
      { seq: 5 }
    );

    assert.equal(withPreImage.fidelity, "full");
    assert.equal(withPreImage.before.status, "created");
  });

  test("the transaction an event belongs to travels with it", () => {
    const event = toChangeEvent(
      insertDocument({ lsid: { id: objectId("session-9") }, txnNumber: 7 }),
      { seq: 6 }
    );

    // Without this a derived rule could not name its source mutation.
    assert.match(event.txId, /session-9/u);
    assert.match(event.txId, /:7$/u);
  });

  test("outside a transaction there is no transaction id, and none is invented", () => {
    assert.equal(toChangeEvent(insertDocument(), { seq: 7 }).txId, null);
  });

  test("an unknown operationType is refused, never dropped", () => {
    // Dropping it would silently lose a change, which is the failure mode this
    // whole project exists to prevent.
    assert.throws(
      () => toChangeEvent({ operationType: "modify", ns: NS, documentKey: { _id: 1 } }),
      (error) => {
        assert.equal(error.code, "E_CHANGE_STREAM_INVALID");
        assert.equal(error.details.reason, "unknown_operation_type");
        assert.equal(error.details.operationType, "modify");
        return true;
      }
    );
  });

  test("a collection dropped or renamed underneath the stream is refused by name", () => {
    for (const operationType of ["drop", "rename", "invalidate", "dropDatabase"]) {
      assert.equal(isLifecycleEvent({ operationType }), true);
      assert.throws(
        () => toChangeEvent({ operationType, ns: NS, documentKey: { _id: 1 } }),
        (error) => {
          assert.equal(error.details.reason, "stream_lifecycle_event");
          // A dropped collection is not "no changes".
          assert.match(error.details.remediation, /stable schema/u);
          return true;
        },
        operationType
      );
    }
  });

  test("a document with no namespace or no key is refused", () => {
    assert.throws(() => toChangeEvent({ operationType: "insert", documentKey: { _id: 1 } }), {
      code: "E_CHANGE_STREAM_INVALID"
    });
    assert.throws(() => toChangeEvent({ operationType: "insert", ns: NS }), {
      code: "E_CHANGE_STREAM_INVALID"
    });
    assert.throws(() => toChangeEvent("not a document"), { code: "E_CHANGE_STREAM_INVALID" });
  });

  test("BSON wrappers normalise, so an id compares equal to itself across reads", () => {
    assert.equal(normalizeBson(objectId("abc")), "abc");
    assert.equal(normalizeBson(new Date("2026-08-17T00:00:00.000Z")), "2026-08-17T00:00:00.000Z");
    assert.deepEqual(normalizeBson({ nested: { id: objectId("xyz") } }), { nested: { id: "xyz" } });
    assert.deepEqual(normalizeBson([objectId("a"), 2]), ["a", 2]);
    assert.equal(normalizeBson(undefined), null);
  });

  test("a batch is numbered by stream position, not by clusterTime", () => {
    // clusterTime has second granularity, so several events can share one and
    // ordering would be lost exactly where it matters.
    const events = toChangeEvents([insertDocument(), insertDocument()], { startSeq: 10 });

    assert.deepEqual(
      events.map((event) => event.seq),
      [10, 11]
    );
    assert.throws(() => toChangeEvents("nope"), { code: "E_CHANGE_STREAM_INVALID" });
  });
});
