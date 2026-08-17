import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveTarget } from "../../../../src/config/targets.mjs";
import { assertImplementsDbPort } from "../../../../src/db/port.mjs";
import { createDbDriver, DB_DRIVER_MODES } from "../../../../src/db/registry.mjs";
import { createBigQueryDriver, DEFAULT_BYTE_BUDGET } from "../../../../src/db/drivers/bigquery/driver.mjs";
import { InfraError, UnsupportedOpError, UsageError } from "../../../../src/errors.mjs";

const ALLOWLIST = Object.freeze([
  Object.freeze({ host: "analytics-project", database: "staging_dataset", nonProd: true, note: "bq staging" })
]);

const TARGET = resolveTarget({ url: "bigquery://analytics-project/staging_dataset", allowlist: ALLOWLIST });
const CREDENTIALS = Object.freeze({ GOOGLE_APPLICATION_CREDENTIALS: "C:/keys/service-account.json" });

const EXPECT = Object.freeze([
  Object.freeze({ sql: "SELECT id FROM `staging_dataset.orders` WHERE id = ?", params: ["order_300"] })
]);

function driverFor(overrides = {}, dependencies = {}) {
  return createBigQueryDriver({
    target: TARGET,
    runId: "20260817T000000Z-06050000",
    scenarioId: "bigquery.driver",
    config: { allowQuery: true, pollTimeoutMs: 300, pollIntervalMs: 10, ...overrides },
    dependencies,
    env: CREDENTIALS
  });
}

describe("bigquery driver", () => {
  test("the registry builds it and it implements the database port", () => {
    const driver = createDbDriver({
      target: TARGET,
      runId: "20260817T000000Z-06050001",
      scenarioId: "bigquery.registry"
    });

    assert.equal(DB_DRIVER_MODES.bigquery, "implemented");
    assert.doesNotThrow(() => assertImplementsDbPort(driver));
  });

  test("preflight refuses when no credentials are available, and never reads them from config", async () => {
    const driver = createBigQueryDriver({
      target: TARGET,
      runId: "20260817T000000Z-06050002",
      scenarioId: "bigquery.driver",
      env: {}
    });

    await assert.rejects(() => driver.preflight(), (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_BIGQUERY_CREDENTIALS_MISSING");
      // Key material belongs in the environment, never in config, a target or
      // an artifact.
      assert.match(error.details.remediation, /GOOGLE_APPLICATION_CREDENTIALS/u);
      assert.match(error.details.remediation, /Never put key material/u);
      return true;
    });
  });

  test("a query without an explicit opt in is refused before anything is billed", async () => {
    let queried = 0;
    const driver = driverFor({ allowQuery: false }, {
      query: () => {
        queried += 1;
        return [];
      }
    });

    await assert.rejects(
      () => driver.poll(null, { expect: EXPECT, timeoutMs: 100, intervalMs: 10 }),
      (error) => {
        assert(error instanceof UsageError);
        assert.equal(error.code, "E_BIGQUERY_QUERY_NOT_ENABLED");
        assert.match(error.details.remediation, /allowQuery/u);
        return true;
      }
    );

    assert.equal(queried, 0, "nothing may reach BigQuery before the opt in is given");
  });

  test("a query whose dry run exceeds the byte budget is refused, not warned about", async () => {
    let queried = 0;
    const driver = driverFor(
      { byteBudget: 1000 },
      {
        dryRun: async () => 5000,
        query: () => {
          queried += 1;
          return [];
        }
      }
    );

    await assert.rejects(
      () => driver.poll(null, { expect: EXPECT, timeoutMs: 100, intervalMs: 10 }),
      (error) => {
        assert.equal(error.code, "E_BIGQUERY_BYTE_BUDGET");
        assert.equal(error.details.estimatedBytes, 5000);
        assert.equal(error.details.budgetBytes, 1000);
        // The operator has to be able to see what was about to be paid for.
        assert.match(error.details.sql, /staging_dataset\.orders/u);
        return true;
      }
    );

    // A warning that is ignored still spends the money, so the refusal is hard.
    assert.equal(queried, 0);
  });

  test("a query inside the budget runs, and the default budget is finite", async () => {
    const driver = driverFor({ byteBudget: 10_000 }, {
      dryRun: async () => 500,
      query: async () => [{ id: "order_300" }]
    });

    const result = await driver.poll(null, { expect: EXPECT, timeoutMs: 500, intervalMs: 10 });

    assert.equal(result.ok, true);
    assert.deepEqual(result.rows, [{ id: "order_300" }]);
    assert.equal(Number.isSafeInteger(DEFAULT_BYTE_BUDGET), true);
    assert(DEFAULT_BYTE_BUDGET > 0);
  });

  test("poll converges rather than asking once", async () => {
    let attempts = 0;
    const driver = driverFor({}, {
      query: async () => {
        attempts += 1;
        // The streaming buffer delays queryability, which is the reason bounded
        // polling exists here at all.
        return attempts < 3 ? [] : [{ id: "order_300" }];
      }
    });

    const result = await driver.poll(null, { expect: EXPECT, timeoutMs: 2000, intervalMs: 10 });

    assert.equal(result.ok, true);
    assert(attempts >= 3, `expected repeated polling, got ${attempts}`);
    assert.equal(result.converge.attempts >= 3, true);
  });

  test("poll that never finds the rows reports the miss rather than throwing", async () => {
    const driver = driverFor({}, { query: async () => [] });

    const result = await driver.poll(null, { expect: EXPECT, timeoutMs: 100, intervalMs: 10 });

    assert.equal(result.ok, false);
    assert.deepEqual(result.rows, []);
  });

  test("drain refuses by name instead of answering with an empty change list", async () => {
    const driver = driverFor();

    await assert.rejects(() => driver.drain(), (error) => {
      assert(error instanceof UnsupportedOpError);
      assert.equal(error.code, "E_DB_CAPTURE_UNSUPPORTED");
      // An empty array here would read as "nothing else changed", which is
      // exactly the claim BigQuery cannot make.
      assert.deepEqual(error.details.supported, ["poll"]);
      return true;
    });
  });

  test("a close demanding no unexplained changes is refused even if it bypassed compilation", async () => {
    const driver = driverFor();
    await driver.openWindow({ op: { seq: 0 } });

    await assert.rejects(
      () => driver.closeWindow({ kind: "db_window_close", seq: 0, requireNoUnexplained: true, expect: [] }),
      { code: "E_DELTA_UNSUPPORTED" }
    );
  });

  test("a close with expected rows polls for them and reports no events, with the reason attached", async () => {
    const driver = driverFor({}, { query: async () => [{ id: "order_300" }] });
    await driver.openWindow({ op: { seq: 0 } });

    const result = await driver.closeWindow({ kind: "db_window_close", seq: 0, expect: EXPECT });

    assert.equal(result.ok, true);
    assert.deepEqual(result.rows, [{ id: "order_300" }]);
    assert.deepEqual(result.events, []);
    assert(result.warnings.some((warning) => warning.includes("no change capture")));
  });

  test("the window is explicitly unfenced, so nothing downstream can mistake it for a bounded one", async () => {
    const driver = driverFor();
    const window = await driver.openWindow({ op: { seq: 0 } });

    assert.equal(window.fenced, false);
    assert.equal(driver.describeCapabilities().watermarkFencing, "none");
  });

  test("a target that is not bigquery://project/dataset is refused", () => {
    assert.throws(
      () =>
        createBigQueryDriver({
          target: Object.freeze({ driver: "postgres", host: "h", database: "d", port: 5432, user: "u" }),
          runId: "20260817T000000Z-06050003",
          scenarioId: "bigquery.driver"
        }),
      { code: "E_BIGQUERY_TARGET_INVALID" }
    );
  });

  test("with no client wired in, the failure names the seam rather than pretending to query", async () => {
    const driver = driverFor({}, { dryRun: async () => 1 });

    await assert.rejects(
      () => driver.poll(null, { expect: EXPECT, timeoutMs: 100, intervalMs: 10 }),
      { code: "E_BIGQUERY_CLIENT_MISSING" }
    );
  });
});
