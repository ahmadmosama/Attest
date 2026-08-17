import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveTarget } from "../../../../src/config/targets.mjs";
import { assertImplementsDbPort } from "../../../../src/db/port.mjs";
import { createDbDriver, DB_DRIVER_MODES } from "../../../../src/db/registry.mjs";
import { createMongoDriver, WATERMARK_COLLECTION, sliceByMarkers } from "../../../../src/db/drivers/mongo/driver.mjs";
import { topologyFrom } from "../../../../src/db/drivers/mongo/preflight.mjs";
import { InfraError } from "../../../../src/errors.mjs";

const ALLOWLIST = Object.freeze([
  Object.freeze({ host: "db.example.test", database: "shop_test", nonProd: true, note: "mongo test" })
]);

const TARGET = resolveTarget({ url: "mongodb://user:secret@db.example.test/shop_test", allowlist: ALLOWLIST });

const REPLICA_SET_HELLO = Object.freeze({ ok: 1, setName: "rs0", isWritablePrimary: true });
const STANDALONE_HELLO = Object.freeze({ ok: 1, isWritablePrimary: true });

const FAST_WINDOW = Object.freeze({
  convergeTimeoutMs: 300,
  convergeIntervalMs: 5,
  quietPeriodMs: 10,
  quietPeriodCapMs: 100
});

/**
 * A scripted deployment. It answers the same calls the real client would, so
 * the topology refusal, the marker fencing, the slicing and the convergence all
 * execute for real with no Mongo anywhere.
 */
function fakeDeployment({ hello = REPLICA_SET_HELLO, canChangeStream = true, appWrites = [] } = {}) {
  const pending = [];
  const markers = [];
  let streamOpen = false;

  return {
    markers,
    // The app writes land in the stream only once it is open, exactly as a real
    // change stream behaves.
    emit(...documents) {
      if (streamOpen) {
        pending.push(...documents);
      }
    },
    dependencies: {
      hello: async () => hello,
      canChangeStream: async () => canChangeStream,
      openStream: async () => {
        streamOpen = true;
        return { id: "stream-1" };
      },
      closeStream: async () => {
        streamOpen = false;
      },
      readStream: async () => pending.splice(0, pending.length),
      insertMarker: async ({ collection, document }) => {
        markers.push(document);
        pending.push({
          operationType: "insert",
          ns: { db: "shop_test", coll: collection },
          documentKey: { _id: `marker-${markers.length}` },
          fullDocument: { _id: `marker-${markers.length}`, ...document }
        });

        // Everything the app wrote between the markers arrives after the open
        // marker, which is what the slice depends on.
        if (document.boundary === "open") {
          pending.push(...appWrites);
        }
      }
    }
  };
}

function orderInsert(id) {
  return {
    operationType: "insert",
    ns: { db: "shop_test", coll: "orders" },
    documentKey: { _id: id },
    fullDocument: { _id: id, status: "created" }
  };
}

function driverFor(deployment, config = {}) {
  return createMongoDriver({
    target: TARGET,
    runId: "20260817T000000Z-06040000",
    scenarioId: "mongo.driver",
    config: { surface: "web", ...config },
    dependencies: deployment.dependencies
  });
}

describe("mongo driver", () => {
  test("the registry builds it and it implements the database port", () => {
    const driver = createDbDriver({
      target: TARGET,
      runId: "20260817T000000Z-06040001",
      scenarioId: "mongo.registry"
    });

    assert.equal(DB_DRIVER_MODES.mongo, "implemented");
    assert.doesNotThrow(() => assertImplementsDbPort(driver));
  });

  test("a standalone deployment is refused by name, with --replSet as the fix", async () => {
    const driver = driverFor(fakeDeployment({ hello: STANDALONE_HELLO }));

    await assert.rejects(() => driver.preflight(), (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_MONGO_STANDALONE");
      assert.match(error.details.remediation, /--replSet/u);
      // Degrading to polling would give a green run whose delta assertions were
      // never actually watched.
      assert.match(error.details.remediation, /refuses rather than degrading/u);
      return true;
    });
  });

  test("topology detection reads hello the way the server answers it", () => {
    assert.equal(topologyFrom(REPLICA_SET_HELLO), "replicaSet");
    assert.equal(topologyFrom(STANDALONE_HELLO), "standalone");
    assert.equal(topologyFrom({ msg: "isdbgrid", ok: 1 }), "sharded");
    assert.equal(topologyFrom(null), "unknown");
  });

  test("a replica set passes preflight and declares change stream capture", async () => {
    const driver = driverFor(fakeDeployment());
    const result = await driver.preflight();

    assert.equal(result.topology, "replicaSet");
    const capabilities = driver.describeCapabilities();
    assert.equal(capabilities.capture, "change_stream");
    // The strongest of the non Postgres drivers, and for the same reason:
    // the source is an event log.
    assert.equal(capabilities.ordering, true);
    assert.equal(capabilities.txAttribution, true);
    assert.equal(capabilities.watermarkFencing, "inline");
  });

  test("pre images off is reported as a degradation rather than hidden", async () => {
    const withoutPreImages = driverFor(fakeDeployment());
    await withoutPreImages.preflight();
    assert.equal(withoutPreImages.describeCapabilities().beforeImages, "key_only");
    assert(withoutPreImages.describeCapabilities().degraded.some((line) => line.includes("pre images are off")));

    const withPreImages = driverFor(fakeDeployment({ hello: { ...REPLICA_SET_HELLO, preImagesEnabled: true } }));
    await withPreImages.preflight();
    assert.equal(withPreImages.describeCapabilities().beforeImages, "full");
    assert.deepEqual(withPreImages.describeCapabilities().degraded, []);
  });

  test("a missing change stream privilege is refused before the run starts", async () => {
    const driver = driverFor(fakeDeployment({ canChangeStream: false }));

    await assert.rejects(() => driver.preflight(), { code: "E_MONGO_CHANGE_STREAM_PRIVILEGE" });
  });

  test("the window is fenced by marker documents the stream itself sees", async () => {
    const deployment = fakeDeployment({ appWrites: [orderInsert("order_1"), orderInsert("order_2")] });
    const driver = driverFor(deployment);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0 } });

    const result = await driver.closeWindow({
      kind: "db_window_close",
      seq: 0,
      expect: [{ entity: "shop_test.orders", op: "insert", count: 2 }],
      ...FAST_WINDOW
    });

    assert.deepEqual(
      result.events.map((event) => `${event.op}:${event.key._id}`),
      ["insert:order_1", "insert:order_2"]
    );
    // The markers are the boundary and never appear as changes themselves.
    assert.equal(result.events.some((event) => event.entity.endsWith(WATERMARK_COLLECTION)), false);
    assert.deepEqual(
      deployment.markers.map((marker) => marker.boundary),
      ["open", "close"]
    );
  });

  test("the stream opens before the marker is written, so the marker cannot be missed", async () => {
    const deployment = fakeDeployment();
    const driver = driverFor(deployment);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0 } });

    // Opening the stream after writing the marker would race, and a window that
    // lost its own open marker cannot be sliced at all.
    const result = await driver.closeWindow({ kind: "db_window_close", seq: 0, expect: [], ...FAST_WINDOW });
    assert.deepEqual(result.events, []);
  });

  test("a window missing a marker is a harness fault, not a scenario failure", () => {
    const identity = { runId: "r", scenarioId: "s", surface: "web", seq: 0, nonce: "n" };

    assert.throws(() => sliceByMarkers([], "shop_test", identity), (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_MONGO_WINDOW_UNFENCED");
      assert.match(error.details.remediation, /harness faults, not scenario failures/u);
      return true;
    });
  });

  test("events outside the markers are outside the window", async () => {
    const deployment = fakeDeployment({ appWrites: [orderInsert("inside")] });
    const driver = driverFor(deployment);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0 } });

    const result = await driver.closeWindow({ kind: "db_window_close", seq: 0, expect: [], ...FAST_WINDOW });
    assert.deepEqual(result.events.map((event) => event.key._id), ["inside"]);

    // A write that arrives after the close marker belongs to whatever comes
    // next, not to this window.
    deployment.emit(orderInsert("after_close"));
    assert.equal(result.events.some((event) => event.key._id === "after_close"), false);
  });

  test("a collection dropped mid window surfaces instead of timing out into an empty delta", async () => {
    const deployment = fakeDeployment({
      appWrites: [{ operationType: "drop", ns: { db: "shop_test", coll: "orders" }, documentKey: { _id: 1 } }]
    });
    const driver = driverFor(deployment);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0 } });

    const started = Date.now();
    await assert.rejects(
      () => driver.closeWindow({ kind: "db_window_close", seq: 0, expect: [], ...FAST_WINDOW }),
      { code: "E_CHANGE_STREAM_INVALID" }
    );
    assert(Date.now() - started < FAST_WINDOW.convergeTimeoutMs, "a fatal stream event must not wait out the timeout");
  });

  test("close converges on the expected events rather than reading once", async () => {
    const deployment = fakeDeployment();
    const driver = driverFor(deployment);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0 } });

    // The write lands after the close has already started, which is the race
    // DB-08 exists to survive.
    setTimeout(() => deployment.emit(orderInsert("late")), 20).unref();

    const result = await driver.closeWindow({
      kind: "db_window_close",
      seq: 0,
      expect: [{ entity: "shop_test.orders", op: "insert", count: 1 }],
      convergeTimeoutMs: 2000,
      convergeIntervalMs: 5,
      quietPeriodMs: 10,
      quietPeriodCapMs: 100
    });

    assert.equal(result.converge.ok, true);
    assert.deepEqual(result.events.map((event) => event.key._id), ["late"]);
  });

  test("capabilities and windows are refused before preflight has run", async () => {
    const driver = driverFor(fakeDeployment());

    assert.throws(() => driver.describeCapabilities(), { code: "E_DB_CAPABILITIES_NOT_READY" });
    await assert.rejects(() => driver.openWindow({}), { code: "E_DB_DRIVER_NOT_READY" });
  });

  test("with no client wired in, preflight names the seam rather than pretending", async () => {
    const driver = createMongoDriver({
      target: TARGET,
      runId: "20260817T000000Z-06040002",
      scenarioId: "mongo.driver",
      dependencies: {}
    });

    await assert.rejects(() => driver.preflight(), { code: "E_MONGO_CLIENT_MISSING" });
  });

  test("a target that is not mongodb is refused", () => {
    assert.throws(
      () =>
        createMongoDriver({
          target: Object.freeze({ driver: "postgres", host: "h", database: "d", port: 5432, user: "u" }),
          runId: "r",
          scenarioId: "s"
        }),
      { code: "E_MONGO_TARGET_INVALID" }
    );
  });

  test("teardown closes the stream and is safe twice", async () => {
    const deployment = fakeDeployment();
    const driver = driverFor(deployment);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0 } });

    assert.deepEqual(await driver.teardown(), { ok: true });
    assert.deepEqual(await driver.teardown(), { ok: true });
  });
});
