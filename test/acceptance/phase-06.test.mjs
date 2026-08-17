import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, test } from "node:test";

import { defineSurfaceCapabilities } from "../../src/capabilities/surface-caps.mjs";
import { loadBindings } from "../../src/bindings/load.mjs";
import { resolveTarget } from "../../src/config/targets.mjs";
import { compileScenarioFile } from "../../src/ir/compile.mjs";
import { lower } from "../../src/lower/lower.mjs";
import { DB_DRIVER_MODES, createDbDriver } from "../../src/db/registry.mjs";
import { bigQueryCapabilities } from "../../src/db/drivers/bigquery/capabilities.mjs";
import { createMongoDriver } from "../../src/db/drivers/mongo/driver.mjs";
import { createMysqlDriver } from "../../src/db/drivers/mysql/driver.mjs";
import { createSqliteDriver } from "../../src/db/drivers/sqlite/driver.mjs";
import { generateFromSpecs } from "../../src/generate/spec/generate.mjs";
import { promoteScenarioFile } from "../../src/generate/promote.mjs";
import { runCommand } from "../../src/cli/commands/run.mjs";
import { InfraError } from "../../src/errors.mjs";

const ROOTS = [];

after(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(path.join(process.cwd(), `test/acceptance/.tmp-phase06-${label}-`));
  ROOTS.push(root);
  return root;
}

function allowlistFor(entries) {
  return entries.map(([host, database]) => ({ host, database, nonProd: true, note: "phase 6 acceptance" }));
}

describe("Phase 6 acceptance", () => {
  test(
    "Criterion 1: SQLite runs through snapshot diff, its degraded mode prints, and its defaults are pinned",
    async () => {
      const root = await tempRoot("c1");
      const file = path.join(root, "app.db");
      const app = new DatabaseSync(file);
      app.exec("CREATE TABLE orders (tenant_key TEXT, id TEXT, status TEXT, PRIMARY KEY (tenant_key, id))");

      const target = resolveTarget({
        url: `sqlite:${file.replaceAll("\\", "/")}`,
        allowlist: allowlistFor([["file", file.replaceAll("\\", "/")]])
      });
      const entities = [{ schema: "main", table: "orders", tenantColumn: "tenant_key" }];
      const driver = createSqliteDriver({
        target,
        runId: "20260817T000000Z-06080001",
        scenarioId: "phase06.sqlite",
        config: { entities, keyColumns: { "main.orders": ["tenant_key", "id"] }, tenantKey: "t1" }
      });

      await driver.preflight();
      const capabilities = driver.describeCapabilities();

      // No server needed, so this criterion always runs.
      assert.equal(capabilities.capture, "snapshot");
      assert.equal(capabilities.ordering, false);
      assert.equal(capabilities.txAttribution, false);

      // The degraded mode is printed, not inferred by the reader.
      const degraded = capabilities.degraded.join(" ");
      assert.match(degraded, /no ordering/u);
      assert.match(degraded, /no attribution/u);
      assert.match(degraded, /insert then delete/u);

      await driver.openWindow({ op: { seq: 0 } });
      app.prepare("INSERT INTO orders VALUES (?, ?, ?)").run("t1", "order_1", "created");
      const closed = await driver.closeWindow({
        kind: "db_window_close",
        seq: 0,
        expect: [{ entity: "main.orders", op: "insert", count: 1 }],
        convergeTimeoutMs: 500,
        convergeIntervalMs: 10,
        quietPeriodMs: 20,
        quietPeriodCapMs: 200
      });

      assert.equal(closed.events.length, 1);
      // Every close carries the degradation, so a SQLite pass cannot be
      // mistaken for a Postgres pass.
      assert.equal(closed.warnings.length > 0, true);

      await driver.teardown();
      app.close();
    }
  );

  test("Criterion 2: MySQL refuses a STATEMENT server and Mongo refuses a standalone, both by name", async () => {
    // Both refusals are provable against a fake server response, so this
    // criterion runs with no MySQL and no Mongo anywhere.
    const mysql = createMysqlDriver({
      target: resolveTarget({
        url: "mysql://user:secret@db.example.test/shop_test",
        allowlist: allowlistFor([["db.example.test", "shop_test"]])
      }),
      runId: "20260817T000000Z-06080002",
      scenarioId: "phase06.mysql",
      dependencies: {
        variables: async () => ({ log_bin: "ON", binlog_format: "STATEMENT", binlog_row_image: "FULL" })
      }
    });

    await assert.rejects(() => mysql.preflight(), (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_MYSQL_BINLOG_FORMAT");
      assert.match(error.details.remediation, /binlog_format=ROW/u);
      return true;
    });

    const mongo = createMongoDriver({
      target: resolveTarget({
        url: "mongodb://user:secret@db.example.test/shop_test",
        allowlist: allowlistFor([["db.example.test", "shop_test"]])
      }),
      runId: "20260817T000000Z-06080003",
      scenarioId: "phase06.mongo",
      dependencies: { hello: async () => ({ ok: 1, isWritablePrimary: true }) }
    });

    await assert.rejects(() => mongo.preflight(), (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_MONGO_STANDALONE");
      assert.match(error.details.remediation, /--replSet/u);
      // Neither degrades quietly, which is the point of both refusals.
      assert.match(error.details.remediation, /refuses rather than degrading/u);
      return true;
    });
  });

  test("Criterion 3: a delta assertion against BigQuery is refused at compile time", async () => {
    const compiled = await compileScenarioFile("test/fixtures/scenarios/checkout_guest_purchase.attest.yaml");
    const result = lower(compiled.ir, {
      surface: "web",
      bindings: await loadBindings({ dir: "test/fixtures/bindings", app: "shopdemo", surface: "web" }),
      surfaceCaps: defineSurfaceCapabilities({
        surface: "web",
        supports: ["file_upload", "network_control", "permission_control", "clipboard_control", "clock_control", "raw_escape"]
      }),
      dbCaps: bigQueryCapabilities(),
      app: "shopdemo"
    });

    // No credentials, no network. The refusal is a property of the capability
    // system rather than a runtime check.
    assert.equal(result.kind, "error");
    assert.equal(result.error.code, "E_DELTA_UNSUPPORTED");
    assert.equal(result.error.details.driver, "bigquery");
  });

  test("Criterion 4: scenarios generate from a spec, each linked, and the gap is reported", () => {
    const spec = [
      "- [ ] **ACC-001**: A guest can place an order",
      "- [ ] **ACC-002**: The cart badge counts items",
      "",
      "```attest",
      "# requirement: ACC-001",
      "steps:",
      "  - open: screen:checkout",
      "  - tap: button:place_order",
      "```"
    ].join("\n");

    const result = generateFromSpecs([{ file: "ACC.md", text: spec }]);

    assert.equal(result.scenarios.length, 1);
    assert.deepEqual(result.scenarios[0].ir.requirements, ["ACC-001"]);
    // The uncovered list is the actual product of generation.
    assert.deepEqual(result.coverage.uncovered.map((entry) => entry.id), ["ACC-002"]);
    assert.equal(result.coverage.counts.covered, 1);
    // ACC-002 is stated only in prose, and prose never becomes steps.
    assert.equal(
      result.ungrounded.some((entry) => entry.requirement === "ACC-002" && entry.reason === "no_declared_scenario"),
      true
    );
  });

  test("Criterion 5: a proposal cannot run, and only gates after an explicit promotion", async () => {
    const root = await tempRoot("c5");
    const proposedDir = path.join(root, "scenarios", "proposed");
    await mkdtemp(path.join(root, "keep-"));
    await rm(proposedDir, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(proposedDir, { recursive: true });
    await mkdir(path.join(root, "bindings", "app"), { recursive: true });
    await writeFile(
      path.join(root, "bindings", "app", "web.yaml"),
      ["surface: web", "screens:", '  screen:checkout: { path: "/checkout", ready: { testId: checkout } }'].join("\n"),
      "utf8"
    );

    const proposal = [
      "id: spec.acc_001",
      "requirement: [ACC-001]",
      "proposed: true",
      "steps:",
      "  - open: screen:checkout",
      ""
    ].join("\n");
    // Deliberately in the ordinary scenarios directory: quarantine by path
    // alone is quarantine somebody can undo with a copy.
    const file = path.join(root, "scenarios", "spec.acc_001.attest.yaml");
    await writeFile(file, proposal, "utf8");

    const err = [];
    const code = await runCommand(
      {
        configFile: {
          scenariosGlob: ["scenarios/*.attest.yaml"],
          bindingsDir: "bindings",
          app: "https://example.test",
          artifactRoot: path.join(root, "artifacts")
        }
      },
      {
        cwd: root,
        env: {},
        stdout: { write: () => {} },
        stderr: { write: (text) => err.push(text) },
        now: () => new Date("2026-08-17T00:00:00.000Z")
      }
    );

    assert.notEqual(code, 0);
    assert.match(err.join(""), /E_SCENARIO_PROPOSED/u);

    // And after an explicit promotion it is an ordinary scenario.
    const promoted = await promoteScenarioFile(file, { move: false });
    assert.deepEqual(promoted.requirements, ["ACC-001"]);

    const secondErr = [];
    const secondCode = await runCommand(
      {
        dryRun: true,
        configFile: {
          scenariosGlob: ["scenarios/*.attest.yaml"],
          bindingsDir: "bindings",
          app: "https://example.test",
          artifactRoot: path.join(root, "artifacts")
        }
      },
      {
        cwd: root,
        env: {},
        stdout: { write: () => {} },
        stderr: { write: (text) => secondErr.push(text) },
        now: () => new Date("2026-08-17T00:00:00.000Z")
      }
    );

    assert.doesNotMatch(secondErr.join(""), /E_SCENARIO_PROPOSED/u);
    assert.equal(secondCode, 0, secondErr.join(""));
  });

  test("every declared engine is implemented and honest about what it cannot do", () => {
    assert.deepEqual(Object.values(DB_DRIVER_MODES).toSorted(), [
      "implemented",
      "implemented",
      "implemented",
      "implemented",
      "implemented"
    ]);

    // The capability table an operator reads is the descriptor the driver
    // actually returns, not a document that can drift from it.
    const bigQuery = bigQueryCapabilities();
    assert.equal(bigQuery.deltaAssertion, false);
    assert.equal(bigQuery.capture, "none");

    const driver = createDbDriver({
      target: resolveTarget({
        url: "bigquery://analytics-project/staging_dataset",
        allowlist: allowlistFor([["analytics-project", "staging_dataset"]])
      }),
      runId: "20260817T000000Z-06080004",
      scenarioId: "phase06.bigquery"
    });
    // Compared field by field: two descriptors carry their own `has` closure,
    // so identity comparison would fail for a reason that has nothing to do
    // with what they claim.
    const described = driver.describeCapabilities();
    for (const field of ["driver", "capture", "deltaAssertion", "boundedPolling", "ordering", "txAttribution", "watermarkFencing", "beforeImages"]) {
      assert.equal(described[field], bigQuery[field], field);
    }
    assert.deepEqual([...described.degraded], [...bigQuery.degraded]);
  });
});
