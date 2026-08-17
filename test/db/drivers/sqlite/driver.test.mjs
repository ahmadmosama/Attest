import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, test } from "node:test";

import { resolveTarget } from "../../../../src/config/targets.mjs";
import { assertImplementsDbPort } from "../../../../src/db/port.mjs";
import { createDbDriver, DB_DRIVER_MODES } from "../../../../src/db/registry.mjs";
import { createSqliteDriver } from "../../../../src/db/drivers/sqlite/driver.mjs";
import { SQLITE_PINNED_PRAGMAS, openSqliteDatabase } from "../../../../src/db/drivers/sqlite/connect.mjs";
import { InfraError } from "../../../../src/errors.mjs";

const ROOTS = [];
const TENANT = "tenant_one";

const ENTITIES = Object.freeze([
  Object.freeze({ schema: "main", table: "orders", tenantColumn: "tenant_key" }),
  Object.freeze({ schema: "main", table: "order_items", tenantColumn: "tenant_key" })
]);

const KEY_COLUMNS = Object.freeze({
  "main.orders": ["tenant_key", "id"],
  "main.order_items": ["tenant_key", "order_id", "line_number"]
});

after(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureDatabase() {
  const root = await mkdtemp(path.join(process.cwd(), "test/db/drivers/sqlite/.tmp-"));
  ROOTS.push(root);
  const file = path.join(root, "app.db");
  const app = new DatabaseSync(file);

  app.exec(`
    CREATE TABLE orders (tenant_key TEXT NOT NULL, id TEXT NOT NULL, status TEXT, total_cents INTEGER, PRIMARY KEY (tenant_key, id));
    CREATE TABLE order_items (tenant_key TEXT NOT NULL, order_id TEXT NOT NULL, line_number INTEGER NOT NULL, sku TEXT, PRIMARY KEY (tenant_key, order_id, line_number));
  `);
  app.prepare("INSERT INTO orders VALUES (?, ?, ?, ?)").run(TENANT, "order_1", "created", 100);
  app.prepare("INSERT INTO orders VALUES (?, ?, ?, ?)").run("other_tenant", "order_9", "created", 900);

  return Object.freeze({
    file,
    app,
    target: resolveTarget({
      url: `sqlite:${file.replaceAll("\\", "/")}`,
      allowlist: [
        { host: "file", database: file.replaceAll("\\", "/"), nonProd: true, note: "sqlite driver test" }
      ]
    })
  });
}

function driverFor(fixture, overrides = {}) {
  return createSqliteDriver({
    target: fixture.target,
    runId: "20260817T000000Z-06020000",
    scenarioId: "sqlite.driver",
    config: {
      entities: ENTITIES,
      keyColumns: KEY_COLUMNS,
      surface: "web",
      tenantKey: TENANT,
      ...overrides
    }
  });
}

// On Windows a file with an open handle cannot be removed, so an attempted
// delete is a direct probe for a leaked connection.
async function assertNoOpenHandle(fixture) {
  fixture.app.close();
  await rm(fixture.file, { force: true });
  assert.equal(existsSync(fixture.file), false, "a leaked SQLite handle would keep this file locked");
}

const FAST_WINDOW = Object.freeze({
  convergeTimeoutMs: 300,
  convergeIntervalMs: 10,
  quietPeriodMs: 20,
  quietPeriodCapMs: 200
});

describe("sqlite driver", () => {
  test("the registry builds it and it implements the database port", async () => {
    const fixture = await fixtureDatabase();
    const driver = createDbDriver({
      target: fixture.target,
      runId: "20260817T000000Z-06020001",
      scenarioId: "sqlite.registry",
      config: { entities: ENTITIES, keyColumns: KEY_COLUMNS }
    });

    assert.equal(DB_DRIVER_MODES.sqlite, "implemented");
    assert.doesNotThrow(() => assertImplementsDbPort(driver));
    await driver.teardown();
    fixture.app.close();
  });

  test("the descriptor declares snapshot capture with no ordering and no attribution", async () => {
    const fixture = await fixtureDatabase();
    const driver = driverFor(fixture);
    await driver.preflight();

    const capabilities = driver.describeCapabilities();
    assert.equal(capabilities.driver, "sqlite");
    assert.equal(capabilities.capture, "snapshot");
    // The classifier and the rule engine still run, so an unexplained change
    // still fails the run.
    assert.equal(capabilities.deltaAssertion, true);
    assert.equal(capabilities.has("db.delta_assertion"), true);
    // What a diff cannot know is declared false rather than left implied.
    assert.equal(capabilities.ordering, false);
    assert.equal(capabilities.txAttribution, false);
    assert.equal(capabilities.watermarkFencing, "external");
    assert(capabilities.degraded.length >= 4, JSON.stringify(capabilities.degraded));

    await driver.teardown();
    fixture.app.close();
  });

  test("driver defaults are pinned explicitly rather than inherited", async () => {
    const fixture = await fixtureDatabase();
    const handle = openSqliteDatabase(fixture.target);

    // node:sqlite is a release candidate, so an inherited default can move
    // under a Node patch release with nothing in the diff.
    assert.equal(handle.database.prepare("PRAGMA query_only").get().query_only, 1);
    assert.equal(handle.database.prepare("PRAGMA busy_timeout").get().timeout, 5000);
    assert.equal(handle.database.prepare("PRAGMA read_uncommitted").get().read_uncommitted, 0);
    assert.deepEqual(Object.keys(SQLITE_PINNED_PRAGMAS).toSorted(), [
      "busy_timeout",
      "foreign_keys",
      "query_only",
      "read_uncommitted"
    ]);

    // journal_mode is read, never set: changing it would be the observer
    // altering the thing it observes, and it persists in the file.
    assert.equal(typeof handle.observed.journal_mode, "string");

    handle.close();
    fixture.app.close();
  });

  test("the observer connection cannot write to the database it watches", async () => {
    const fixture = await fixtureDatabase();
    const handle = openSqliteDatabase(fixture.target);

    assert.throws(() => handle.database.exec("INSERT INTO orders VALUES ('x','y','z',1)"));

    handle.close();
    fixture.app.close();
  });

  test("a window captures inserts, updates and deletes the app made", async () => {
    const fixture = await fixtureDatabase();
    const driver = driverFor(fixture);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0, scenarioId: "sqlite.driver", surface: "web" } });

    fixture.app.prepare("INSERT INTO orders VALUES (?, ?, ?, ?)").run(TENANT, "order_2", "created", 250);
    fixture.app.prepare("UPDATE orders SET status = ? WHERE tenant_key = ? AND id = ?").run("paid", TENANT, "order_1");
    fixture.app.prepare("INSERT INTO order_items VALUES (?, ?, ?, ?)").run(TENANT, "order_2", 1, "lamp");

    const result = await driver.closeWindow({
      kind: "db_window_close",
      seq: 0,
      expect: [{ entity: "main.orders", op: "insert", count: 1 }],
      ...FAST_WINDOW
    });

    const summary = result.events.map((event) => `${event.entity}:${event.op}:${event.key.id ?? event.key.order_id}`);
    assert.deepEqual(summary.toSorted(), [
      "main.order_items:insert:order_2",
      "main.orders:insert:order_2",
      "main.orders:update:order_1"
    ]);

    // A diff has no transactions, so none are reported. A synthetic id would
    // let a derived rule claim attribution this strategy never observed.
    assert.deepEqual(result.harnessTxIds, []);
    assert.deepEqual(result.transactions, {});
    assert(result.warnings.length > 0, "the degradation must ride along with every close");

    await driver.teardown();
    fixture.app.close();
  });

  test("another tenant's writes are outside the window", async () => {
    const fixture = await fixtureDatabase();
    const driver = driverFor(fixture);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0 } });

    fixture.app.prepare("INSERT INTO orders VALUES (?, ?, ?, ?)").run("other_tenant", "order_8", "created", 800);

    const result = await driver.closeWindow({ kind: "db_window_close", seq: 0, expect: [], ...FAST_WINDOW });
    assert.deepEqual(result.events, []);

    await driver.teardown();
    fixture.app.close();
  });

  test("close converges on the expected mutation instead of guessing a duration", async () => {
    const fixture = await fixtureDatabase();
    const driver = driverFor(fixture);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0 } });

    // The write lands after the close has already started, which is the race
    // DB-08 exists to survive.
    const pending = driver.closeWindow({
      kind: "db_window_close",
      seq: 0,
      expect: [{ entity: "main.orders", op: "insert", count: 1 }],
      convergeTimeoutMs: 2000,
      convergeIntervalMs: 10,
      quietPeriodMs: 20,
      quietPeriodCapMs: 200
    });

    fixture.app.prepare("INSERT INTO orders VALUES (?, ?, ?, ?)").run(TENANT, "order_3", "created", 300);

    const result = await pending;
    assert.equal(result.converge.ok, true);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].key.id, "order_3");

    await driver.teardown();
    fixture.app.close();
  });

  test("a missing expectation still closes and reports what it saw", async () => {
    const fixture = await fixtureDatabase();
    const driver = driverFor(fixture);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0 } });

    const result = await driver.closeWindow({
      kind: "db_window_close",
      seq: 0,
      expect: [{ entity: "main.orders", op: "insert", count: 1 }],
      ...FAST_WINDOW
    });

    // The driver reports; the classifier decides. Failing here would move the
    // verdict into the driver, where a rule cannot see it.
    assert.equal(result.converge.ok, false);
    assert.deepEqual(result.events, []);

    await driver.teardown();
    fixture.app.close();
  });

  test("drain recomputes without consuming, unlike a stream", async () => {
    const fixture = await fixtureDatabase();
    const driver = driverFor(fixture);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0 } });

    fixture.app.prepare("INSERT INTO orders VALUES (?, ?, ?, ?)").run(TENANT, "order_4", "created", 400);

    assert.equal((await driver.drain()).length, 1);
    assert.equal((await driver.drain()).length, 1);

    await driver.teardown();
    fixture.app.close();
  });

  test("poll waits for expected rows, which is the bounded polling capability", async () => {
    const fixture = await fixtureDatabase();
    const driver = driverFor(fixture);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0 } });

    const pending = driver.poll(
      null,
      { expect: [{ entity: "main.orders", op: "insert", count: 1 }], timeoutMs: 2000, intervalMs: 10 },
      {}
    );
    fixture.app.prepare("INSERT INTO orders VALUES (?, ?, ?, ?)").run(TENANT, "order_5", "created", 500);

    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.events.length, 1);

    await driver.teardown();
    fixture.app.close();
  });

  test("a missing file and an unknown entity are infrastructure errors with a fix", async () => {
    const missing = createSqliteDriver({
      target: Object.freeze({ driver: "sqlite", host: "file", database: "./does-not-exist.db", port: null, user: "" }),
      runId: "20260817T000000Z-06020002",
      scenarioId: "sqlite.missing",
      config: { entities: [], keyColumns: {} }
    });

    await assert.rejects(() => missing.preflight(), (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_SQLITE_FILE_MISSING");
      assert.match(error.details.remediation, /db\.url/u);
      return true;
    });

    const fixture = await fixtureDatabase();
    const wrongEntity = driverFor(fixture, {
      entities: [{ schema: "main", table: "not_a_table", tenantColumn: "tenant_key" }]
    });

    // Caught at preflight, so a misspelled table is an infrastructure error
    // before the scenario runs rather than a confusing empty delta after it.
    await assert.rejects(() => wrongEntity.preflight(), { code: "E_SQLITE_SNAPSHOT_FAILED" });

    // And the failed preflight left no connection behind. On Windows an open
    // handle locks the file, so a leak here would make the database
    // undeletable for the life of the process.
    await assertNoOpenHandle(fixture);
  });

  test("an entity name that is not a plain identifier never reaches SQL", async () => {
    const fixture = await fixtureDatabase();
    const injected = driverFor(fixture, {
      entities: [{ schema: "main", table: "orders; DROP TABLE orders", tenantColumn: "tenant_key" }]
    });

    await assert.rejects(() => injected.preflight(), { code: "E_SQLITE_IDENTIFIER_INVALID" });

    // And the table is still there.
    assert.equal(fixture.app.prepare("SELECT count(*) AS n FROM orders").get().n, 2);
    await assertNoOpenHandle(fixture);
  });

  test("a snapshot that fails mid window surfaces, instead of timing out into an empty delta", async () => {
    const fixture = await fixtureDatabase();
    const driver = driverFor(fixture);
    await driver.preflight();
    await driver.openWindow({ op: { seq: 0 } });

    // The table goes away underneath the window. Convergence treats a throwing
    // probe as "not yet", so without the guard this would retry for the whole
    // timeout and then report no events at all, which reads as a clean pass.
    fixture.app.exec("DROP TABLE order_items");

    const started = Date.now();
    await assert.rejects(
      () => driver.closeWindow({ kind: "db_window_close", seq: 0, expect: [], ...FAST_WINDOW }),
      (error) => {
        assert.equal(error.code, "E_SQLITE_SNAPSHOT_FAILED");
        assert.equal(error.details.entity, "main.order_items");
        return true;
      }
    );

    // And it gave up immediately rather than spending the convergence budget on
    // a condition that could never become true.
    assert(Date.now() - started < FAST_WINDOW.convergeTimeoutMs, "a fatal snapshot error must not wait out the timeout");

    await driver.teardown();
    fixture.app.close();
  });

  test("closing with no open window is an infrastructure error, not an empty pass", async () => {
    const fixture = await fixtureDatabase();
    const driver = driverFor(fixture);
    await driver.preflight();

    await assert.rejects(() => driver.closeWindow(null, {}), { code: "E_DB_WINDOW_NOT_OPEN" });

    await driver.teardown();
    fixture.app.close();
  });

  test("capabilities and windows are refused before preflight has run", async () => {
    const fixture = await fixtureDatabase();
    const driver = driverFor(fixture);

    assert.throws(() => driver.describeCapabilities(), { code: "E_DB_CAPABILITIES_NOT_READY" });
    await assert.rejects(() => driver.openWindow({}), { code: "E_DB_DRIVER_NOT_READY" });
    fixture.app.close();
  });

  test("teardown is safe to call twice", async () => {
    const fixture = await fixtureDatabase();
    const driver = driverFor(fixture);
    await driver.preflight();

    assert.deepEqual(await driver.teardown(), { ok: true });
    assert.deepEqual(await driver.teardown(), { ok: true });
    fixture.app.close();
  });
});
