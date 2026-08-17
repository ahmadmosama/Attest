import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, test } from "node:test";
import pg from "pg";
import { scanBundleForSecrets } from "../../src/evidence/scan.mjs";
import { postgresUrl, probePostgres, skipUnlessPostgres, withPostgresSlotLock } from "../helpers/postgres.mjs";

const { Client } = pg;
const ROOTS = [];
const SCHEMAS = [];
const RUN_TIMEOUT_MS = 300000;
const TOKEN = "Bearer attest-seeded-fake-token-phase-03";
const EXPIRED_RULE_HASH = "e".repeat(64);
const BINDINGS = `surface: web
elements: {}
screens: {}
`;
function childEnv(extra = {}) {
  return Object.fromEntries(
    ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"].map((key) => [key, process.env[key]])
      .filter(([, value]) => value !== undefined).concat(Object.entries(extra))
  );
}

async function pgAvailability() {
  const url = postgresUrl();
  const probe = await probePostgres(url);
  return Object.freeze({
    ok: probe.ok,
    reason: probe.ok ? null : `Postgres tests skipped: ${probe.reason}`
  });
}

const LIVE_STATUS = await pgAvailability();

if (LIVE_STATUS.ok) {
  await withPostgresSlotLock({ url: postgresUrl() }, sweepForeignHarnessSchemas);
}
async function tempRoot(label) {
  const root = await mkdtemp(path.join(process.cwd(), `test/acceptance/${label}-`));
  ROOTS.push(root);
  return root;
}

function q(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qname(schema, table) {
  return `${q(schema)}.${q(table)}`;
}

function rel(file) {
  return path.relative(process.cwd(), file).replaceAll("\\", "/");
}

function schemaName(label) {
  const safe = label.replaceAll(/[^a-z0-9_]/giu, "_").toLowerCase();
  return `attest_phase03_${safe}_${process.pid}_${Date.now()}`;
}

async function withPg(fn) {
  const client = new Client({ connectionString: postgresUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createTables(client, schema) {
  await client.query(`CREATE SCHEMA ${q(schema)}`);
  await client.query(`
    CREATE TABLE ${qname(schema, "orders")} (
      tenant_key text NOT NULL,
      id text NOT NULL,
      status text,
      amount integer,
      token text,
      note text,
      PRIMARY KEY (tenant_key, id)
    )
  `);
  await client.query(`
    CREATE TABLE ${qname(schema, "audit")} (
      tenant_key text NOT NULL,
      id text NOT NULL,
      order_id text,
      action text,
      note text,
      PRIMARY KEY (tenant_key, id)
    )
  `);
  await client.query(`
    CREATE TABLE ${qname(schema, "external_events")} (
      tenant_key text NOT NULL,
      id text NOT NULL,
      payload text,
      PRIMARY KEY (tenant_key, id)
    )
  `);
  for (const table of ["orders", "audit", "external_events"]) {
    await client.query(`ALTER TABLE ${qname(schema, table)} REPLICA IDENTITY FULL`);
  }
}

async function dropSchema(schema) {
  await withPg((client) => client.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`));
}

async function dropAttestSlots() {
  await withPg((client) =>
    client.query(`
      SELECT pg_drop_replication_slot(slot_name)
      FROM pg_replication_slots
      WHERE slot_name LIKE 'attest\\_%' ESCAPE '\\'
        AND active = false
    `)
  );
}

async function slotNames() {
  return withPg(async (client) => {
    const result = await client.query(`
      SELECT slot_name
      FROM pg_replication_slots
      WHERE slot_name LIKE 'attest\\_%' ESCAPE '\\'
      ORDER BY slot_name
    `);
    return result.rows.map((row) => row.slot_name);
  });
}

// Scoped to this process on purpose. A global count over every
// attest_phase03_% schema would also see debris left by a previous run that
// was killed mid test, which would make this assertion permanently red through
// no fault of the current run. Foreign debris is swept separately, below.
async function harnessTenantCount() {
  return withPg(async (client) => {
    const result = await client.query(
      `
      SELECT count(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema LIKE $1 ESCAPE '\\'
    `,
      [`attest\\_phase03\\_%\\_${process.pid}\\_%`]
    );
    return Number(result.rows[0].count);
  });
}

// Self healing: a run killed mid test leaves its scratch schemas behind, and
// they would otherwise accumulate in the developer database forever. Drop the
// ones that cannot belong to this process before the suite starts.
async function sweepForeignHarnessSchemas() {
  await withPg(async (client) => {
    const result = await client.query(
      `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name LIKE 'attest\\_phase03\\_%' ESCAPE '\\'
        AND schema_name NOT LIKE $1 ESCAPE '\\'
    `,
      [`attest\\_phase03\\_%\\_${process.pid}\\_%`]
    );

    for (const row of result.rows) {
      await client.query(`DROP SCHEMA IF EXISTS ${q(row.schema_name)} CASCADE`);
    }
  });
}

async function prepareSchema(label) {
  const schema = schemaName(label);
  SCHEMAS.push(schema);
  await withPg((client) => createTables(client, schema));
  return schema;
}

function sqlItem(text, values = [], delayMs = 0) {
  return { text, values, delayMs };
}

function expectJson(value) {
  return JSON.stringify(value);
}

function rawStep(items) {
  const rendered = items
    .map((item) => {
      const delayLine = item.delayMs > 0 ? `          delayMs: ${item.delayMs}\n` : "";
      return `        - text: ${JSON.stringify(item.text)}
          values: ${JSON.stringify(item.values)}
${delayLine}`.trimEnd();
    })
    .join("\n");
  return `  - raw:
      reason: app writes through a second connection
      web:
        sql:
${rendered}
`;
}

function scenario(id, body, seed = null) {
  const data = seed === null ? "" : `data:
  seed: ${seed}
`;
  return `id: ${id}
requirement: [REQ-PHASE-03]
${data}steps:
${body}`;
}

function closeStep({ expect = [], requireNoUnexplained = true } = {}) {
  const expected = expect.length === 0
    ? ""
    : `    expect_mutations:
${expect.map((item) => `      - ${item}`).join("\n")}
`;
  const requireLine = requireNoUnexplained ? "    require_no_unexplained: true\n" : "    require_no_unexplained: false\n";
  return `  - delta_window: close
${expected}${requireLine}`;
}

function insertOrderSql(schema) {
  return `INSERT INTO ${qname(schema, "orders")} (tenant_key, id, status, amount, token, note) VALUES ($1, $2, $3, $4, $5, $6)`;
}

function updateOrderSql(schema) {
  return `UPDATE ${qname(schema, "orders")} SET status = $3, note = $4 WHERE tenant_key = $1 AND id = $2`;
}

function insertAuditSql(schema) {
  return `INSERT INTO ${qname(schema, "audit")} (tenant_key, id, order_id, action, note) VALUES ($1, $2, $3, $4, $5)`;
}

function insertExternalSql(schema) {
  return `INSERT INTO ${qname(schema, "external_events")} (tenant_key, id, payload) VALUES ($1, $2, $3)`;
}

function rulesetText(rules) {
  return `version: 1
rules:
${rules.join("\n")}
`;
}

function derivedRule(id = "audit_from_orders") {
  return `  - kind: derived
    id: ${id}
    entity: audit
    caused_by: { entity: orders, op: insert }
    mechanism: audit trigger
    per_source: 1`;
}

function externalRule(id = "external_writer_rule") {
  return `  - kind: external_writer
    id: ${id}
    entity: external_events
    identity: { by: transaction, not_in: scenario_transactions }`;
}

function ignoreRule(id, entity = "orders", expires = "2099-01-01") {
  return `  - kind: ignore
    id: ${id}
    entity: ${entity}
    reason: acceptance suppression
    expires: ${expires}`;
}

function childScript() {
  return `
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { runCommand } from "./src/cli/commands/run.mjs";
import { tenantPrefixFor } from "./src/db/tenancy.mjs";
import { createFakeSurface } from "./src/surfaces/fake/adapter.mjs";
import { defineScript } from "./src/surfaces/fake/script.mjs";

const spec = JSON.parse(await readFile(process.argv[1], "utf8"));
const { Client } = pg;

function rewrite(value, ctx) {
  if (value === "$tenantKey") {
    return tenantPrefixFor({
      runId: ctx.runId,
      scenarioId: ctx.scenarioId,
      surface: ctx.surface,
      configuredPrefix: spec.tenantPrefix
    });
  }
  if (value === "$fakeToken") {
    return spec.token;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewrite(item, ctx));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, ctx)]));
  }
  return value;
}

function adapterForSql(url) {
  const base = createFakeSurface(defineScript({ surface: "web", supports: ["raw_escape"] }));
  return {
    describeCapabilities: () => base.describeCapabilities(),
    preflight: (...args) => base.preflight(...args),
    open(ctx) {
      return { inner: base.open(ctx), ctx };
    },
    async execute(session, op, options) {
      if (op.kind === "raw" && Array.isArray(op.block?.sql)) {
        const client = new Client({ connectionString: url, application_name: op.block.applicationName ?? "phase03_app" });
        await client.connect();
        try {
          for (const item of op.block.sql) {
            if (Number.isInteger(item.delayMs) && item.delayMs > 0) {
              await delay(item.delayMs, undefined, { signal: options?.signal });
            }
            await client.query(item.text, rewrite(item.values ?? [], session.ctx));
          }
        } finally {
          await client.end();
        }
      }
      return base.execute(session.inner, op, options);
    },
    collectEvidence: (session, kind, options) => base.collectEvidence(session.inner, kind, options),
    close: (session, options) => base.close(session?.inner ?? null, options)
  };
}

const out = { write: (text) => process.stdout.write(text) };
const err = { write: (text) => process.stderr.write(text) };
const code = await runCommand(spec.flags, {
  cwd: process.cwd(),
  env: process.env,
  stdout: out,
  stderr: err,
  adapterFor: () => adapterForSql(spec.url),
  dbLoadRuleset: spec.loadedRuleset === undefined ? undefined : () => spec.loadedRuleset,
  now: () => new Date(spec.now ?? Date.now())
});
process.exit(code);
`;
}

function runtimeFor(schema, extra = {}) {
  const entities = [`${schema}.orders`, `${schema}.audit`, `${schema}.external_events`];
  return {
    entities,
    tenant: {
      registryTable: { schema, table: "attest_tenants" },
      entities
    },
    keyColumns: {
      [`${schema}.orders`]: ["tenant_key", "id"],
      [`${schema}.audit`]: ["tenant_key", "id"],
      [`${schema}.external_events`]: ["tenant_key", "id"]
    },
    ruleHealthPath: path.join(extra.root, "rule-health.json"),
    seeds: extra.seeds ?? {}
  };
}

async function writeRunFixture({ root, schema, text, rules, live, runtime, concurrency = 1, now }) {
  const scenarios = path.join(root, "scenarios");
  const bindings = path.join(root, "bindings", "shop");
  const rulesPath = path.join(root, "rules.yaml");
  await mkdir(scenarios, { recursive: true });
  await mkdir(bindings, { recursive: true });
  await writeFile(path.join(scenarios, "case.attest.yaml"), text);
  await writeFile(path.join(bindings, "web.yaml"), BINDINGS);
  await writeFile(rulesPath, rules ?? "version: 1\nrules: []\n");
  return {
    url: live.url,
    token: TOKEN,
    tenantPrefix: "attest_phase03",
    now,
    flags: {
      configFile: {
        app: "https://example.test",
        scenariosGlob: [rel(path.join(scenarios, "case.attest.yaml"))],
        bindingsDir: path.join(root, "bindings"),
        surfaces: ["web"],
        concurrency,
        failOnSkip: true,
        db: {
          allowlist: live.allowlist,
          rulesFile: rulesPath,
          tenantPrefix: "attest_phase03",
          redaction: { sensitive: [`${schema}.orders.token`], mode: "hash" }
        }
      },
      artifactRoot: path.join(root, "artifacts"),
      dbRuntime: runtime
    }
  };
}

function runChild(specPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript(), specPath], {
      cwd: process.cwd(),
      env: childEnv({
        ATTEST_PG_URL: postgresUrl(),
        ATTEST_DB_URL: postgresUrl(),
        ATTEST_SURFACE_ADAPTER: "fake"
      }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function runSpec(spec, root) {
  const specPath = path.join(root, "spec.json");
  await writeFile(specPath, JSON.stringify(spec, null, 2));
  return runChild(specPath);
}

async function onlyRunDir(root) {
  const entries = await readdir(path.join(root, "artifacts"));
  assert.equal(entries.length, 1);
  return path.join(root, "artifacts", entries[0]);
}

async function readRun(root) {
  const runDir = await onlyRunDir(root);
  const record = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  return { runDir, record };
}

async function runCase(t, label, build) {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return null;
  }

  return withPostgresSlotLock(live, async () => {
    const root = await tempRoot(label);
    const schema = await prepareSchema(label);
    try {
      const spec = await build({ root, schema, live });
      const result = await runSpec(spec, root);
      await dropAttestSlots();
      try {
        return { root, schema, result, ...(await readRun(root)) };
      } catch {
        return { root, schema, result, runDir: null, record: null };
      }
    } finally {
      await dropSchema(schema);
    }
  });
}

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}
after(async () => {
  await withPostgresSlotLock({ url: postgresUrl() }, async () => {
    for (const schema of SCHEMAS) {
      await dropSchema(schema).catch(() => {});
    }
    await dropAttestSlots().catch(() => {});
    await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
  });
});

describe("Phase 3 database acceptance", LIVE_STATUS.ok ? {} : { skip: LIVE_STATUS.reason }, () => {
  test("Criterion 1: a scenario declaring expected mutations passes when a second connection performs them, and fails with E_DELTA_MISSING_MUTATION when one is withheld", async (t) => {
    const pass = await runCase(t, "phase03-c1-pass", async ({ root, schema, live }) => {
      const text = scenario(
        "phase3.expected_pass",
        `  - delta_window: open
${rawStep([sqlItem(insertOrderSql(schema), ["$tenantKey", "ok", "paid", 100, null, "created"])])}${closeStep({
          expect: [expectJson({ entity: "orders", op: "insert", count: 1, where: { id: "ok" } })]
        })}`
      );
      return writeRunFixture({ root, schema, text, live, runtime: runtimeFor(schema, { root }) });
    });
    assert.equal(pass.result.status, 0, output(pass.result));

    const fail = await runCase(t, "phase03-c1-fail", async ({ root, schema, live }) => {
      const text = scenario(
        "phase3.missing_mutation",
        `  - delta_window: open
${rawStep([sqlItem(insertOrderSql(schema), ["$tenantKey", "withheld", "new", 100, null, "created"])])}${closeStep({
          expect: [expectJson({ entity: "orders", op: "update", count: 1, where: { id: "withheld" }, changed: ["status"] })]
        })}`
      );
      return writeRunFixture({ root, schema, text, live, runtime: runtimeFor(schema, { root }) });
    });
    const text = output(fail.result);
    assert.equal(fail.result.status, 1, text);
    assert.match(text, /E_DELTA_MISSING_MUTATION/);
    assert.match(text, /phase3\.missing_mutation/);
    assert.match(text, /step 2/);
    assert.match(text, /table orders/);
    assert.match(text, /row key .*withheld/);
    assert.match(text, /column status/);
  });

  test("Criterion 2: every captured change lands in one of the four buckets and unexplained fails by default", async (t) => {
    const item = await runCase(t, "phase03-c2", async ({ root, schema, live }) => {
      const rules = rulesetText([derivedRule(), externalRule()]);
      const text = scenario(
        "phase3.four_buckets",
        `  - delta_window: open
${rawStep([
          sqlItem(insertOrderSql(schema), ["$tenantKey", "bucket", "new", 100, null, "created"]),
          sqlItem(insertAuditSql(schema), ["$tenantKey", "audit-one", "bucket", "created", "derived"]),
          sqlItem(insertExternalSql(schema), ["$tenantKey", "external-one", "writer"]),
          sqlItem(updateOrderSql(schema), ["$tenantKey", "bucket", "paid", "stray"])
        ])}${closeStep({
          expect: [expectJson({ entity: "orders", op: "insert", count: 1, where: { id: "bucket" } })]
        })}`
      );
      return writeRunFixture({ root, schema, text, rules, live, runtime: runtimeFor(schema, { root }) });
    });
    assert.equal(item.result.status, 1, output(item.result));
    assert.match(item.result.stdout, /expected 1, explained 1, suppressed external 1, unexplained 1/);
    assert.deepEqual(item.record.delta.counts, {
      expected: 1,
      explained: 1,
      suppressed_external: 1,
      unexplained: 1
    });
  });

  test("Criterion 3a: an expired ignore rule fails the run by rule name", async (t) => {
    const item = await runCase(t, "phase03-c3a", async ({ root, schema, live }) => {
      const rules = rulesetText([ignoreRule("expired_ignore", "orders", "2099-01-01")]);
      const text = scenario(
        "phase3.expired_rule",
        `  - delta_window: open
${rawStep([sqlItem(insertOrderSql(schema), ["$tenantKey", "expired", "new", 100, null, "created"])])}${closeStep()}`
      );
      const spec = await writeRunFixture({
        root,
        schema,
        text,
        rules,
        live,
        runtime: runtimeFor(schema, { root })
      });
      spec.loadedRuleset = { path: path.join(root, "rules.yaml"), hash: EXPIRED_RULE_HASH, byId: {}, ruleset: {
        version: 1,
        rules: [{
          kind: "ignore",
          id: "expired_ignore",
          entity: "orders",
          reason: "acceptance suppression",
          expires: "2026-08-16",
          cap: 50
        }]
      } };
      return spec;
    });
    assert.equal(item.result.status, 1, output(item.result));
    assert.match(output(item.result), /expired_ignore/);
    const fileItem = await runCase(t, "phase03-c3a-file", async ({ root, schema, live }) => {
      const rules = rulesetText([ignoreRule("expired_file_ignore", "orders", "2026-08-16")]);
      const text = scenario("phase3.expired_file_rule", `${closeStep({ requireNoUnexplained: false })}`);
      const spec = await writeRunFixture({ root, schema, text, live, runtime: runtimeFor(schema, { root }) });
      const rulesPath = path.join(root, "expired_file_ignore.rules.yaml");
      await writeFile(rulesPath, rules);
      spec.flags.configFile.db.rulesFile = rulesPath;
      return spec;
    });
    assert.equal(fileItem.result.status, 3, output(fileItem.result));
    assert.match(fileItem.result.stderr, /expired_file_ignore\.rules\.yaml:\d+:\d+  E_RULESET_SCHEMA/u);
    assert.match(fileItem.result.stderr, /ignore rule expires must not be expired/u);
  });

  test("Criterion 3b: derived per source one leaves excess audit rows unexplained and fails", async (t) => {
    const item = await runCase(t, "phase03-c3b", async ({ root, schema, live }) => {
      const rules = rulesetText([`  - kind: derived
    id: audit_delete
    entity: audit
    caused_by: { entity: orders, op: delete }
    mechanism: delete audit
    per_source: 1`]);
      const text = scenario(
        "phase3.derived_cap",
        `  - delta_window: open
${rawStep([
          sqlItem(insertOrderSql(schema), ["$tenantKey", "gone", "new", 100, null, "created"]),
          sqlItem(`DELETE FROM ${qname(schema, "orders")} WHERE tenant_key = $1 AND id = $2`, ["$tenantKey", "gone"]),
          sqlItem(insertAuditSql(schema), ["$tenantKey", "audit-one", "gone", "deleted", "derived"]),
          sqlItem(insertAuditSql(schema), ["$tenantKey", "audit-two", "gone", "deleted", "excess"])
        ])}${closeStep({
          expect: [expectJson({ entity: "orders", op: "delete", count: 1, where: { id: "gone" } })]
        })}`
      );
      return writeRunFixture({ root, schema, text, rules, live, runtime: runtimeFor(schema, { root }) });
    });
    assert.equal(item.result.status, 1, output(item.result));
    assert.equal(item.record.delta.counts.explained >= 1, true);
    assert.equal(item.record.delta.counts.unexplained >= 1, true);
  });

  test("Criterion 3c: a ruleset with a wildcard in an ignore entity fails to load", async (t) => {
    const item = await runCase(t, "phase03-c3c", async ({ root, schema, live }) => {
      const rules = rulesetText([ignoreRule("wild_ignore", "orders*", "2099-01-01")]);
      const text = scenario("phase3.wildcard_rule", `${closeStep({ requireNoUnexplained: false })}`);
      return writeRunFixture({ root, schema, text, rules, live, runtime: runtimeFor(schema, { root }) });
    });
    assert.equal(item.result.status, 3, output(item.result));
    assert.match(item.result.stderr, /E_RULESET_SCHEMA/);
  });

  test("Criterion 3d: per rule suppression lines print for every rule and the ruleset hash appears in run.json", async (t) => {
    const item = await runCase(t, "phase03-c3d", async ({ root, schema, live }) => {
      const rules = rulesetText([
        ignoreRule("ignore_orders", "orders", "2099-01-01"),
        ignoreRule("unused_ignore", "audit", "2099-01-01")
      ]);
      const text = scenario(
        "phase3.rule_accounting",
        `  - delta_window: open
${rawStep([sqlItem(insertOrderSql(schema), ["$tenantKey", "ignored", "new", 100, null, "created"])])}${closeStep()}`
      );
      return writeRunFixture({ root, schema, text, rules, live, runtime: runtimeFor(schema, { root }) });
    });
    assert.equal(item.result.status, 0, output(item.result));
    assert.match(item.result.stdout, /ignore_orders/);
    assert.match(item.result.stdout, /unused_ignore/);
    assert.match(item.record.hashes.ruleset, /^[0-9a-f]{64}$/);
  });

  test("Criterion 4a: two runs of the same scenario against the same seed produce the same seed digest and verdict", async (t) => {
    const live = await skipUnlessPostgres(t);
    if (live === null) {
      return;
    }
    await withPostgresSlotLock(live, async () => {
      const schema = await prepareSchema("phase03-c4a");
      const seed = {
        name: "catalog",
        entities: [{ entity: `${schema}.orders`, rows: [{ id: "seeded", status: "seed", amount: 5 }] }]
      };
      async function one(label) {
        const root = await tempRoot(label);
        const text = scenario(
          "phase3.seed_repeat",
          `  - delta_window: open
${rawStep([sqlItem(updateOrderSql(schema), ["$tenantKey", "seeded", "paid", "from seed"])])}${closeStep({
            expect: [expectJson({ entity: "orders", op: "update", count: 1, where: { id: "seeded" }, changed: ["status", "note"] })]
          })}`,
          "catalog"
        );
        const spec = await writeRunFixture({
          root,
          schema,
          text,
          live,
          runtime: runtimeFor(schema, { root, seeds: { catalog: seed } })
        });
        const result = await runSpec(spec, root);
        await dropAttestSlots();
        return { result, ...(await readRun(root)) };
      }
      try {
        const first = await one("phase03-c4a-one");
        const second = await one("phase03-c4a-two");
        const firstPlan = JSON.parse(await readFile(path.join(first.runDir, first.record.scenarios[0].planPath), "utf8"));
        const secondPlan = JSON.parse(await readFile(path.join(second.runDir, second.record.scenarios[0].planPath), "utf8"));
        assert.equal(first.record.scenarios[0].result, second.record.scenarios[0].result);
        assert.equal(firstPlan.seedDigest, secondPlan.seedDigest);
      } finally {
        await dropSchema(schema);
      }
    });
  });

  test("Criterion 4b: a write issued 800ms after expected mutations is attributed to the open window", async (t) => {
    const item = await runCase(t, "phase03-c4b", async ({ root, schema, live }) => {
      const text = scenario(
        "phase3.late_write",
        `  - delta_window: open
${rawStep([
          sqlItem(insertOrderSql(schema), ["$tenantKey", "late", "new", 100, null, "created"]),
          sqlItem(updateOrderSql(schema), ["$tenantKey", "late", "paid", "late update"], 800)
        ])}${closeStep({
          expect: [expectJson({ entity: "orders", op: "insert", count: 1, where: { id: "late" } })],
          requireNoUnexplained: false
        })}`
      );
      const next = scenario(
        "phase3.next_window",
        `  - delta_window: open
${closeStep()}`
      );
      const spec = await writeRunFixture({ root, schema, text, live, runtime: runtimeFor(schema, { root }) });
      const nextPath = path.join(root, "scenarios", "next.attest.yaml");
      await writeFile(nextPath, next);
      spec.flags.configFile.scenariosGlob.push(rel(nextPath));
      return spec;
    });
    assert.equal(item.result.status, 0, output(item.result));
    const first = item.record.scenarios.find((entry) => entry.id === "phase3.late_write");
    const second = item.record.scenarios.find((entry) => entry.id === "phase3.next_window");
    const firstClose = first.steps.find((step) => step.kind === "db_window_close");
    const secondClose = second.steps.find((step) => step.kind === "db_window_close");
    assert.equal(firstClose.delta.counts.expected, 1);
    assert.equal(firstClose.delta.counts.unexplained, 1);
    assert.equal(secondClose.delta.counts.unexplained, 0);
  });

  test("Criterion 4c: two delta scenarios at concurrency 4 never overlap", async (t) => {
    const item = await runCase(t, "phase03-c4c", async ({ root, schema, live }) => {
      const first = scenario(
        "phase3.serial_one",
        `  - delta_window: open
${rawStep([sqlItem(insertOrderSql(schema), ["$tenantKey", "one", "new", 100, null, "created"])])}${closeStep({
          expect: [expectJson({ entity: "orders", op: "insert", count: 1, where: { id: "one" } })]
        })}`
      );
      const second = scenario(
        "phase3.serial_two",
        `  - delta_window: open
${rawStep([sqlItem(insertOrderSql(schema), ["$tenantKey", "two", "new", 100, null, "created"])])}${closeStep({
          expect: [expectJson({ entity: "orders", op: "insert", count: 1, where: { id: "two" } })]
        })}`
      );
      const spec = await writeRunFixture({
        root,
        schema,
        text: first,
        live,
        concurrency: 4,
        runtime: runtimeFor(schema, { root })
      });
      const secondPath = path.join(root, "scenarios", "case-two.attest.yaml");
      await writeFile(secondPath, second);
      spec.flags.configFile.scenariosGlob.push(rel(secondPath));
      return spec;
    });
    assert.equal(item.result.status, 0, output(item.result));
    assert.equal(item.record.telemetry.deltaScheduling.forcedSerial, 2);
    assert.equal(item.record.scenarios.length, 2);
    const [first, second] = ["phase3.serial_one", "phase3.serial_two"].map((id) =>
      item.record.scenarios.find((entry) => entry.id === id)
    );
    const span = [first.startedAt, first.finishedAt, second.startedAt, second.finishedAt].map(Date.parse);
    assert.equal(span.every(Number.isFinite), true);
    assert.equal(span[0] >= span[3] || span[2] >= span[1], true);
  });

  test("Criterion 5a: an unmarked target is refused before any connection", async (t) => {
    const live = await skipUnlessPostgres(t);
    if (live === null) {
      return;
    }
    await withPostgresSlotLock(live, async () => {
      const root = await tempRoot("phase03-c5a");
      const schema = await prepareSchema("phase03-c5a");
      try {
        const text = scenario("phase3.unmarked", `${closeStep({ requireNoUnexplained: false })}`);
        const spec = await writeRunFixture({ root, schema, text, live, runtime: runtimeFor(schema, { root }) });
        spec.flags.configFile.db.allowlist = [{ host: live.target.host, database: live.target.database, note: "missing marker" }];
        const result = await runSpec(spec, root);
        assert.equal(result.status, 3, output(result));
      } finally {
        await dropSchema(schema);
      }
    });
  });

  test("Criterion 5b: a seeded fake token stored in a captured column does not appear anywhere in the run directory", async (t) => {
    const item = await runCase(t, "phase03-c5b", async ({ root, schema, live }) => {
      const text = scenario(
        "phase3.redacted_token",
        `  - delta_window: open
${rawStep([sqlItem(insertOrderSql(schema), ["$tenantKey", "secret", "new", 100, "$fakeToken", "created"])])}${closeStep({
          requireNoUnexplained: false
        })}`
      );
      return writeRunFixture({ root, schema, text, live, runtime: runtimeFor(schema, { root }) });
    });
    assert.equal(item.result.status, 0, output(item.result));
    const findings = await scanBundleForSecrets(item.runDir, { literals: [TOKEN] });
    assert.deepEqual(findings, []);
  });

  test("Criterion 5c: the generated report.html contains the classified delta for the failed scenario", async (t) => {
    const item = await runCase(t, "phase03-c5c", async ({ root, schema, live }) => {
      const text = scenario(
        "phase3.report_delta",
        `  - delta_window: open
${rawStep([sqlItem(insertOrderSql(schema), ["$tenantKey", "report", "new", 100, null, "created"])])}${closeStep()}`
      );
      return writeRunFixture({ root, schema, text, live, runtime: runtimeFor(schema, { root }) });
    });
    assert.equal(item.result.status, 1, output(item.result));
    const report = await readFile(path.join(item.runDir, "report.html"), "utf8");
    assert.match(report, /classified-database-delta/);
    assert.match(report, /phase3\.report_delta/);
    assert.match(report, /unexplained/);
  });

  test("cleanup: no Phase 3 replication slots or harness tenants remain", async () => {
    await withPostgresSlotLock({ url: postgresUrl() }, async () => {
      assert.deepEqual(await slotNames(), []);
      assert.equal(await harnessTenantCount(), 0);
    });
  });
});
