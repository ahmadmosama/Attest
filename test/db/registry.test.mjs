import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveTarget } from "../../src/config/targets.mjs";
import { UsageError } from "../../src/errors.mjs";
import { createDbDriver, DB_DRIVER_MODES } from "../../src/db/registry.mjs";
import { assertImplementsDbPort } from "../../src/db/port.mjs";

const ALLOWLIST = Object.freeze([
  Object.freeze({ host: "db.example.test", database: "app_test", nonProd: true, note: "registry test" }),
  Object.freeze({ host: "file", database: "./fixtures/local.db", nonProd: true, note: "sqlite fixture" }),
  Object.freeze({ host: "analytics-project", database: "staging_dataset", nonProd: true, note: "bq staging" })
]);

function target(url) {
  return resolveTarget({ url, allowlist: ALLOWLIST });
}

function driverFor(url) {
  return createDbDriver({
    target: target(url),
    runId: "20260817T000000Z-06010000",
    scenarioId: "registry.test",
    config: { entities: [], keyColumns: {}, surface: "web", logger: false }
  });
}

describe("database driver registry", () => {
  test("every declared engine has a mode, and the modes are the only two", () => {
    assert.deepEqual(Object.keys(DB_DRIVER_MODES).toSorted(), [
      "bigquery",
      "mongo",
      "mysql",
      "postgres",
      "sqlite"
    ]);

    for (const [driver, mode] of Object.entries(DB_DRIVER_MODES)) {
      assert.equal(["implemented", "planned"].includes(mode), true, `${driver} has mode ${mode}`);
    }
  });

  test("postgres builds a driver that implements the database port", () => {
    const driver = driverFor("postgres://user:secret@db.example.test:5432/app_test");
    assert.doesNotThrow(() => assertImplementsDbPort(driver));
  });

  test("the postgresql alias builds the same driver", () => {
    const driver = driverFor("postgresql://user:secret@db.example.test/app_test");
    assert.doesNotThrow(() => assertImplementsDbPort(driver));
  });

  test("a declared but unimplemented driver is refused by name, never substituted", () => {
    // Substituting Postgres for a MySQL target would produce a green run that
    // verified a database nobody asked about.
    for (const [url, driver] of [
      ["mysql://user:secret@db.example.test/app_test", "mysql"],
      ["mongodb://user:secret@db.example.test/app_test", "mongo"],
      ["sqlite:./fixtures/local.db", "sqlite"],
      ["bigquery://analytics-project/staging_dataset", "bigquery"]
    ]) {
      assert.throws(
        () => driverFor(url),
        (error) => {
          assert(error instanceof UsageError);
          assert.equal(error.code, "E_DB_DRIVER_NOT_IMPLEMENTED");
          assert.equal(error.details.driver, driver);
          assert.match(error.details.remediation, /Phase 6/u);
          return true;
        },
        url
      );
    }
  });

  test("an unknown driver names the accepted set", () => {
    assert.throws(
      () =>
        createDbDriver({
          target: Object.freeze({ driver: "cassandra", host: "h", database: "d", port: null, user: "" }),
          runId: "20260817T000000Z-06010001",
          scenarioId: "registry.test"
        }),
      (error) => {
        assert.equal(error.code, "E_DB_DRIVER_UNKNOWN");
        assert.deepEqual(error.details.accepted, ["postgres", "sqlite", "mysql", "mongo", "bigquery"]);
        return true;
      }
    );
  });

  test("a target that is not an object is a type error, not a silent default", () => {
    assert.throws(() => createDbDriver({ target: null }), TypeError);
    assert.throws(() => createDbDriver({ target: "postgres" }), TypeError);
  });
});
