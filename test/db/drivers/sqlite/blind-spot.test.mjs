import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, test } from "node:test";

import { resolveTarget } from "../../../../src/config/targets.mjs";
import { createSqliteDriver } from "../../../../src/db/drivers/sqlite/driver.mjs";
import { SQLITE_DEGRADED } from "../../../../src/db/drivers/sqlite/capabilities.mjs";

const ROOTS = [];
const TENANT = "tenant_one";

const ENTITIES = Object.freeze([
  Object.freeze({ schema: "main", table: "orders", tenantColumn: "tenant_key" })
]);
const KEY_COLUMNS = Object.freeze({ "main.orders": ["tenant_key", "id"] });
const FAST_WINDOW = Object.freeze({
  convergeTimeoutMs: 200,
  convergeIntervalMs: 10,
  quietPeriodMs: 20,
  quietPeriodCapMs: 150
});

after(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(process.cwd(), "test/db/drivers/sqlite/.tmp-blind-"));
  ROOTS.push(root);
  const file = path.join(root, "app.db");
  const app = new DatabaseSync(file);
  app.exec(
    "CREATE TABLE orders (tenant_key TEXT NOT NULL, id TEXT NOT NULL, status TEXT, PRIMARY KEY (tenant_key, id))"
  );
  app.prepare("INSERT INTO orders VALUES (?, ?, ?)").run(TENANT, "order_1", "created");

  const target = resolveTarget({
    url: `sqlite:${file.replaceAll("\\", "/")}`,
    allowlist: [{ host: "file", database: file.replaceAll("\\", "/"), nonProd: true, note: "blind spot test" }]
  });

  const driver = createSqliteDriver({
    target,
    runId: "20260817T000000Z-06020100",
    scenarioId: "sqlite.blind_spot",
    config: { entities: ENTITIES, keyColumns: KEY_COLUMNS, surface: "web", tenantKey: TENANT }
  });

  await driver.preflight();
  return Object.freeze({ app, driver });
}

describe("sqlite snapshot capture blind spots", () => {
  test("a row inserted and deleted inside one window is invisible", async () => {
    const { app, driver } = await fixture();
    await driver.openWindow({ op: { seq: 0 } });

    // This is the case a delta engine exists to catch. On a change stream it is
    // two events. On a snapshot pair the row is absent from both snapshots, so
    // there is nothing to compare and nothing is emitted.
    app.prepare("INSERT INTO orders VALUES (?, ?, ?)").run(TENANT, "order_ghost", "created");
    app.prepare("DELETE FROM orders WHERE tenant_key = ? AND id = ?").run(TENANT, "order_ghost");

    const result = await driver.closeWindow({ kind: "db_window_close", seq: 0, expect: [], ...FAST_WINDOW });

    assert.deepEqual(result.events, [], "a snapshot diff cannot see a round trip, and pretending otherwise would be worse");
    await driver.teardown();
    app.close();
  });

  test("a value changed and changed back is invisible", async () => {
    const { app, driver } = await fixture();
    await driver.openWindow({ op: { seq: 0 } });

    app.prepare("UPDATE orders SET status = ? WHERE id = ?").run("paid", "order_1");
    app.prepare("UPDATE orders SET status = ? WHERE id = ?").run("created", "order_1");

    const result = await driver.closeWindow({ kind: "db_window_close", seq: 0, expect: [], ...FAST_WINDOW });

    assert.deepEqual(result.events, []);
    await driver.teardown();
    app.close();
  });

  test("the run says so: every close carries the degradation, so a pass is not mistaken for a Postgres pass", async () => {
    const { app, driver } = await fixture();
    await driver.openWindow({ op: { seq: 0 } });
    const result = await driver.closeWindow({ kind: "db_window_close", seq: 0, expect: [], ...FAST_WINDOW });

    // The warnings ride along with the result, not in a footnote somewhere, and
    // they name the three things this capture strategy cannot know.
    for (const claim of ["ordering", "attribution", "insert then delete"]) {
      assert.equal(
        result.warnings.some((warning) => warning.includes(claim)),
        true,
        `the close result must state that it has no ${claim}: ${JSON.stringify(result.warnings)}`
      );
    }

    assert.deepEqual(driver.describeCapabilities().degraded.slice(0, SQLITE_DEGRADED.length), [...SQLITE_DEGRADED]);
    await driver.teardown();
    app.close();
  });

  test("what it can see, it sees exactly", async () => {
    // The blind spots above are real, and they are bounded. A net change is
    // still captured with its before and after row, which is what makes the
    // four bucket classification meaningful on SQLite at all.
    const { app, driver } = await fixture();
    await driver.openWindow({ op: { seq: 0 } });

    app.prepare("INSERT INTO orders VALUES (?, ?, ?)").run(TENANT, "order_2", "created");
    app.prepare("DELETE FROM orders WHERE tenant_key = ? AND id = ?").run(TENANT, "order_1");

    const result = await driver.closeWindow({ kind: "db_window_close", seq: 0, expect: [], ...FAST_WINDOW });

    assert.deepEqual(
      result.events.map((event) => `${event.op}:${event.key.id}`).toSorted(),
      ["delete:order_1", "insert:order_2"]
    );
    assert.equal(result.events.find((event) => event.op === "delete").before.status, "created");

    await driver.teardown();
    app.close();
  });
});

describe("sqlite degradation reaches the operator", () => {
  test("the run record carries what the driver could observe", async () => {
    const { createRunRecord } = await import("../../../../src/report/run-record.mjs");
    const { sqliteCapabilities } = await import("../../../../src/db/drivers/sqlite/capabilities.mjs");

    const record = createRunRecord({
      runId: "20260817T000000Z-06020200",
      startedAt: "2026-08-17T00:00:00.000Z",
      finishedAt: "2026-08-17T00:00:01.000Z",
      durationMs: 1000,
      attestVersion: "0.1.0",
      filters: { ids: [], tags: [], surfaces: ["web"], headed: false, dryRun: false },
      artifactDir: ".attest/runs/20260817T000000Z-06020200",
      hashes: { bindings: {}, ruleset: null },
      dbCapabilities: sqliteCapabilities({ journalMode: "delete" }),
      telemetry: { timeouts: 0, retries: 0, convergeMs: [], deltaScheduling: { forcedSerial: 0, reason: null } },
      scenarios: [],
      escapeHatch: { rawOpUses: 0, uses: [] },
      failOnSkip: true
    });

    // Two green runs on two engines are not the same evidence, and run.json is
    // where a reader finds out which one they are looking at.
    assert.equal(record.database.driver, "sqlite");
    assert.equal(record.database.capture, "snapshot");
    assert.equal(record.database.ordering, false);
    assert.equal(record.database.txAttribution, false);
    assert.equal(
      record.database.degraded.some((line) => line.includes("insert then delete")),
      true
    );
    assert.equal(
      record.database.degraded.some((line) => line.includes("journal_mode is delete")),
      true
    );
  });

  test("a run with no database at all records none, rather than an empty claim", async () => {
    const { createRunRecord } = await import("../../../../src/report/run-record.mjs");

    const record = createRunRecord({
      runId: "20260817T000000Z-06020201",
      startedAt: "2026-08-17T00:00:00.000Z",
      finishedAt: "2026-08-17T00:00:01.000Z",
      durationMs: 1000,
      attestVersion: "0.1.0",
      filters: { ids: [], tags: [], surfaces: ["web"], headed: false, dryRun: false },
      artifactDir: ".attest/runs/20260817T000000Z-06020201",
      hashes: { bindings: {}, ruleset: null },
      telemetry: { timeouts: 0, retries: 0, convergeMs: [], deltaScheduling: { forcedSerial: 0, reason: null } },
      scenarios: [],
      escapeHatch: { rawOpUses: 0, uses: [] },
      failOnSkip: true
    });

    assert.equal(record.database, null);
  });
});
