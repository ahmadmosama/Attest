import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveTarget } from "../../../../src/config/targets.mjs";
import { assertImplementsDbPort } from "../../../../src/db/port.mjs";
import { createDbDriver, DB_DRIVER_MODES } from "../../../../src/db/registry.mjs";
import { createMysqlDriver, WATERMARK_TABLE, sliceByMarkers } from "../../../../src/db/drivers/mysql/driver.mjs";
import { beforeImagesFor } from "../../../../src/db/drivers/mysql/preflight.mjs";
import { InfraError } from "../../../../src/errors.mjs";

const ALLOWLIST = Object.freeze([
  Object.freeze({ host: "db.example.test", database: "shop_test", nonProd: true, note: "mysql test" })
]);

const TARGET = resolveTarget({ url: "mysql://user:secret@db.example.test/shop_test", allowlist: ALLOWLIST });

const KEY_COLUMNS = Object.freeze({
  "shop_test.orders": ["id"],
  [`shop_test.${WATERMARK_TABLE}`]: ["nonce", "boundary"]
});

const ROW_SERVER = Object.freeze({ log_bin: "ON", binlog_format: "ROW", binlog_row_image: "FULL" });
const GRANTS = Object.freeze(["GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'attest'@'%'"]);

const FAST_WINDOW = Object.freeze({
  convergeTimeoutMs: 300,
  convergeIntervalMs: 5,
  quietPeriodMs: 10,
  quietPeriodCapMs: 100
});

/**
 * A scripted server. It answers the same calls the real client would, so the
 * format refusals, the fencing, the slicing and the convergence execute for
 * real with no MySQL anywhere.
 */
function fakeServer({ variables = ROW_SERVER, grants = GRANTS, appWrites = [] } = {}) {
  const pending = [];
  const markers = [];

  return {
    markers,
    emit(...events) {
      pending.push(...events);
    },
    dependencies: {
      variables: async () => variables,
      grants: async () => grants,
      openBinlog: async () => ({ id: "reader-1" }),
      closeBinlog: async () => {},
      readBinlog: async () => pending.splice(0, pending.length),
      insertMarker: async ({ table, row }) => {
        markers.push(row);
        pending.push({ type: "write_rows", schema: "shop_test", table, rows: [row] });

        if (row.boundary === "open") {
          pending.push(...appWrites);
        }
      }
    }
  };
}

function orderInsert(id) {
  return { type: "write_rows", schema: "shop_test", table: "orders", rows: [{ id, status: "created" }], xid: 7 };
}

function driverFor(server, config = {}) {
  return createMysqlDriver({
    target: TARGET,
    runId: "20260817T000000Z-06030000",
    scenarioId: "mysql.driver",
    config: { surface: "web", keyColumns: KEY_COLUMNS, ...config },
    dependencies: server.dependencies
  });
}

describe("mysql driver", () => {
  test("the registry builds it and it implements the database port", () => {
    const driver = createDbDriver({
      target: TARGET,
      runId: "20260817T000000Z-06030001",
      scenarioId: "mysql.registry"
    });

    assert.equal(DB_DRIVER_MODES.mysql, "implemented");
    assert.doesNotThrow(() => assertImplementsDbPort(driver));
  });

  test("a STATEMENT format server is refused at preflight with the SET GLOBAL fix", async () => {
    for (const format of ["STATEMENT", "MIXED"]) {
      const driver = driverFor(fakeServer({ variables: { ...ROW_SERVER, binlog_format: format } }));

      await assert.rejects(() => driver.preflight(), (error) => {
        assert(error instanceof InfraError);
        assert.equal(error.code, "E_MYSQL_BINLOG_FORMAT");
        assert.equal(error.details.binlogFormat, format);
        assert.match(error.details.remediation, /binlog_format=ROW/u);
        // SQL text cannot yield per row before and after images.
        assert.match(error.details.remediation, /SQL text/u);
        return true;
      }, format);
    }
  });

  test("a server with the binary log off is refused, because it would capture nothing", async () => {
    const driver = driverFor(fakeServer({ variables: { ...ROW_SERVER, log_bin: "OFF" } }));

    await assert.rejects(() => driver.preflight(), (error) => {
      assert.equal(error.code, "E_MYSQL_BINLOG_DISABLED");
      // A run that captures nothing reports no unexplained changes, which reads
      // as a pass. That is the failure mode this refusal exists to prevent.
      assert.match(error.details.remediation, /no unexplained changes because it saw none/u);
      return true;
    });
  });

  test("a user without replication privilege is refused before the run starts", async () => {
    const driver = driverFor(fakeServer({ grants: ["GRANT SELECT ON shop_test.* TO 'attest'@'%'"] }));

    await assert.rejects(() => driver.preflight(), { code: "E_MYSQL_REPLICATION_PRIVILEGE" });
  });

  test("a ROW format server declares binlog capture with ordering and attribution", async () => {
    const driver = driverFor(fakeServer());
    const result = await driver.preflight();

    assert.equal(result.binlogFormat, "ROW");
    const capabilities = driver.describeCapabilities();
    assert.equal(capabilities.capture, "binlog");
    assert.equal(capabilities.ordering, true);
    assert.equal(capabilities.txAttribution, true);
    assert.equal(capabilities.beforeImages, "full");
    assert.deepEqual(capabilities.degraded, []);
  });

  test("binlog_row_image MINIMAL is a degradation that prints, not a refusal", async () => {
    const driver = driverFor(fakeServer({ variables: { ...ROW_SERVER, binlog_row_image: "MINIMAL" } }));
    await driver.preflight();

    // The classifier can still work, it just has less to compare, and it must
    // be told rather than left to assume.
    const capabilities = driver.describeCapabilities();
    assert.equal(capabilities.beforeImages, "key_only");
    assert(capabilities.degraded.some((line) => line.includes("binlog_row_image is MINIMAL")));
    assert.equal(beforeImagesFor("FULL"), "full");
    assert.equal(beforeImagesFor("minimal"), "key_only");
  });

  test("the window is fenced by marker rows the binlog itself carries", async () => {
    const server = fakeServer({ appWrites: [orderInsert("order_1"), orderInsert("order_2")] });
    const driver = driverFor(server);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0 } });

    const result = await driver.closeWindow({
      kind: "db_window_close",
      seq: 0,
      expect: [{ entity: "shop_test.orders", op: "insert", count: 2 }],
      ...FAST_WINDOW
    });

    assert.deepEqual(result.events.map((event) => event.key.id), ["order_1", "order_2"]);
    assert.equal(result.events.some((event) => event.entity.endsWith(WATERMARK_TABLE)), false);
    assert.deepEqual(server.markers.map((marker) => marker.boundary), ["open", "close"]);
  });

  test("a window missing a marker is a harness fault, not a scenario failure", () => {
    const identity = { runId: "r", scenarioId: "s", surface: "web", seq: 0, nonce: "n" };

    assert.throws(() => sliceByMarkers([], "shop_test", identity), (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_MYSQL_WINDOW_UNFENCED");
      assert.match(error.details.remediation, /harness faults, not scenario failures/u);
      return true;
    });
  });

  test("an unparseable event surfaces instead of timing out into an empty delta", async () => {
    const server = fakeServer({
      appWrites: [{ type: "partial_update_rows", schema: "shop_test", table: "orders", rows: [] }]
    });
    const driver = driverFor(server);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0 } });

    const started = Date.now();
    await assert.rejects(
      () => driver.closeWindow({ kind: "db_window_close", seq: 0, expect: [], ...FAST_WINDOW }),
      { code: "E_BINLOG_EVENT_INVALID" }
    );
    assert(Date.now() - started < FAST_WINDOW.convergeTimeoutMs);
  });

  test("close converges on the expected rows rather than reading once", async () => {
    const server = fakeServer();
    const driver = driverFor(server);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0 } });

    setTimeout(() => server.emit(orderInsert("late")), 20).unref();

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
    assert.deepEqual(result.events.map((event) => event.key.id), ["late"]);
  });

  test("capabilities and windows are refused before preflight has run", async () => {
    const driver = driverFor(fakeServer());

    assert.throws(() => driver.describeCapabilities(), { code: "E_DB_CAPABILITIES_NOT_READY" });
    await assert.rejects(() => driver.openWindow({}), { code: "E_DB_DRIVER_NOT_READY" });
  });

  test("with no client wired in, preflight names the seam rather than pretending", async () => {
    const driver = createMysqlDriver({
      target: TARGET,
      runId: "20260817T000000Z-06030002",
      scenarioId: "mysql.driver",
      dependencies: {}
    });

    await assert.rejects(() => driver.preflight(), { code: "E_MYSQL_CLIENT_MISSING" });
  });

  test("a target that is not mysql is refused", () => {
    assert.throws(
      () =>
        createMysqlDriver({
          target: Object.freeze({ driver: "postgres", host: "h", database: "d", port: 5432, user: "u" }),
          runId: "r",
          scenarioId: "s"
        }),
      { code: "E_MYSQL_TARGET_INVALID" }
    );
  });

  test("teardown closes the reader and is safe twice", async () => {
    const driver = driverFor(fakeServer());
    await driver.preflight();

    assert.deepEqual(await driver.teardown(), { ok: true });
    assert.deepEqual(await driver.teardown(), { ok: true });
  });
});
