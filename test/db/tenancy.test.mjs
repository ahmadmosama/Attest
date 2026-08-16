import assert from "node:assert/strict";
import test from "node:test";

import { InfraError } from "../../src/errors.mjs";
import { withClient } from "../../src/db/drivers/postgres/connect.mjs";
import {
  RESERVED_EMAIL_DOMAIN,
  provisionTenant,
  scopeToTenant,
  sweepStaleTenants,
  teardownTenant,
  tenantPrefixFor
} from "../../src/db/tenancy.mjs";
import { skipUnlessPostgres } from "../helpers/postgres.mjs";

function fakeClient({ rows = [], failOnDelete = false } = {}) {
  return {
    queries: [],
    async query(text, values = []) {
      const sql = String(text);
      this.queries.push({ text: sql, values });
      if (failOnDelete && sql.trim().startsWith("DELETE")) {
        throw new Error("delete failed");
      }
      if (sql.includes("pg_constraint")) {
        return { rows };
      }
      if (sql.includes("SELECT tenant_key")) {
        return { rows };
      }
      return { rows: [] };
    }
  };
}

function tableSuffix(label) {
  return `${label}_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`.toLowerCase();
}

function quoteIdent(identifier) {
  return `"${identifier.replace(/"/gu, "\"\"")}"`;
}

function qname(table) {
  return `"public".${quoteIdent(table)}`;
}

async function createTenantTables(client, names) {
  await client.query(`
    CREATE TABLE ${qname(names.registry)} (
      tenant_key text PRIMARY KEY,
      tenant_prefix text NOT NULL,
      created_at timestamptz NOT NULL,
      email text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await client.query(`
    CREATE TABLE ${qname(names.parent)} (
      id text PRIMARY KEY,
      tenant_key text NOT NULL,
      email text NOT NULL
    )
  `);
  await client.query(`
    CREATE TABLE ${qname(names.child)} (
      id text PRIMARY KEY,
      parent_id text NOT NULL REFERENCES ${qname(names.parent)}(id),
      tenant_key text NOT NULL
    )
  `);
}

async function dropTenantTables(client, names) {
  await client.query(`DROP TABLE IF EXISTS ${qname(names.child)}`);
  await client.query(`DROP TABLE IF EXISTS ${qname(names.parent)}`);
  await client.query(`DROP TABLE IF EXISTS ${qname(names.registry)}`);
}

async function tenantCounts(client, names, tenantKeys) {
  const rows = {};
  for (const [label, table] of Object.entries(names)) {
    const result = await client.query(
      `SELECT count(*)::int AS count FROM ${qname(table)} WHERE tenant_key = ANY($1::text[])`,
      [tenantKeys]
    );
    rows[label] = result.rows[0].count;
  }
  return rows;
}

test("tenantPrefixFor returns deterministic safe prefixes with scenario separation", () => {
  const first = tenantPrefixFor({
    runId: "Run ID 123",
    scenarioId: "checkout.guest_purchase",
    surface: "web",
    configuredPrefix: "Attest Local"
  });
  const same = tenantPrefixFor({
    runId: "Run ID 123",
    scenarioId: "checkout.guest_purchase",
    surface: "web",
    configuredPrefix: "Attest Local"
  });
  const other = tenantPrefixFor({
    runId: "Run ID 123",
    scenarioId: "checkout.refund",
    surface: "web",
    configuredPrefix: "Attest Local"
  });
  const long = tenantPrefixFor({
    runId: "RUN".repeat(80),
    scenarioId: "scenario.with.long.name",
    surface: "android",
    configuredPrefix: "attest"
  });
  const custom = tenantPrefixFor({
    runId: "Run ID 123",
    scenarioId: "checkout.guest_purchase",
    surface: "web",
    configuredPrefix: "Project One"
  });

  assert.equal(first, same);
  assert.notEqual(first, other);
  assert.match(first, /^attest_local_[a-z0-9_]+$/u);
  assert.match(custom, /^attest_project_one_[a-z0-9_]+$/u);
  assert.match(long, /^attest_[a-z0-9_]+$/u);
  assert(Buffer.byteLength(first, "utf8") <= 63);
  assert(Buffer.byteLength(long, "utf8") <= 63);
});

test("generated tenant identities use a reserved email domain", async () => {
  const client = fakeClient();
  const tenantKey = tenantPrefixFor({
    runId: "identity",
    scenarioId: "account.create",
    surface: "web"
  });

  const tenant = await provisionTenant(client, {
    tenantKey,
    now: () => Date.parse("2026-08-16T12:00:00.000Z")
  });

  try {
    assert.equal(RESERVED_EMAIL_DOMAIN, "attest.invalid");
    assert.equal(tenant.email, `${tenantKey}@${RESERVED_EMAIL_DOMAIN}`);
    assert.equal(client.queries.some((entry) => entry.text === "COMMIT"), true);
  } finally {
    await teardownTenant(client, { tenantKey });
  }
});

test("provisionTenant inserts declared tenant rows in one committed transaction", async () => {
  const client = fakeClient();
  const tenantKey = tenantPrefixFor({ runId: "seed", scenarioId: "tenant.rows" });

  try {
    await provisionTenant(client, {
      tenantKey,
      entities: [
        {
          entity: "public.accounts",
          rows: [{ id: "$tenantKey", email: "$tenantEmail", role: "buyer" }]
        }
      ],
      now: () => Date.parse("2026-08-16T12:00:00.000Z")
    });

    const commitIndex = client.queries.findIndex((entry) => entry.text === "COMMIT");
    assert.equal(client.queries[0].text, "BEGIN");
    assert(commitIndex > 0);
    const accountInsert = client.queries.find((entry) => entry.text.includes('"accounts"'));
    assert.deepEqual(accountInsert.values, [tenantKey, `${tenantKey}@${RESERVED_EMAIL_DOMAIN}`, "buyer", tenantKey]);
  } finally {
    await teardownTenant(client, {
      tenantKey,
      entities: ["public.accounts"]
    });
  }
});

test("scopeToTenant partitions inside rows and keeps ambiguous events outside", () => {
  const tenantKey = tenantPrefixFor({ runId: "scope", scenarioId: "orders.create" });
  const insideInsert = Object.freeze({
    op: "insert",
    after: Object.freeze({ id: 1, tenant_key: tenantKey })
  });
  const insideDelete = Object.freeze({
    op: "delete",
    before: Object.freeze({ id: 2, tenant_key: tenantKey }),
    after: null
  });
  const otherTenant = Object.freeze({
    op: "update",
    after: Object.freeze({ id: 3, tenant_key: "attest_other" })
  });
  const ambiguous = Object.freeze({
    op: "insert",
    after: Object.freeze({ id: 4 })
  });

  const scoped = scopeToTenant([insideInsert, insideDelete, otherTenant, ambiguous], { tenantKey });

  assert.deepEqual(scoped.inside, [insideInsert, insideDelete]);
  assert.deepEqual(scoped.outside, [otherTenant, ambiguous]);
});

test("teardownTenant reports delete failures as infrastructure errors", async () => {
  const client = fakeClient({ failOnDelete: true });
  const tenantKey = tenantPrefixFor({ runId: "teardown", scenarioId: "failure" });

  await assert.rejects(
    () =>
      teardownTenant(client, {
        tenantKey,
        entities: ["public.accounts"]
      }),
    (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_TENANT_TEARDOWN");
      assert.equal(error.details.severity, "infra_error");
      return true;
    }
  );
});

test("live Postgres teardown removes tenant rows in foreign key safe order and is idempotent", async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  const suffix = tableSuffix("tenant_teardown");
  const names = {
    registry: `${suffix}_registry`,
    parent: `${suffix}_parents`,
    child: `${suffix}_children`
  };
  const registryTable = { schema: "public", table: names.registry };
  const tenantKey = tenantPrefixFor({ runId: suffix, scenarioId: "fk.teardown" });

  await withClient(live.target, async (client) => {
    try {
      await createTenantTables(client, names);
      await provisionTenant(client, {
        tenantKey,
        registryTable,
        entities: [
          {
            entity: { schema: "public", table: names.parent },
            rows: [{ id: `${tenantKey}_parent`, email: "$tenantEmail" }]
          },
          {
            entity: { schema: "public", table: names.child },
            rows: [{ id: `${tenantKey}_child`, parent_id: `${tenantKey}_parent` }]
          }
        ],
        now: () => Date.parse("2026-08-16T12:00:00.000Z")
      });

      assert.deepEqual(await tenantCounts(client, names, [tenantKey]), {
        registry: 1,
        parent: 1,
        child: 1
      });

      await teardownTenant(client, {
        tenantKey,
        registryTable,
        entities: [
          { schema: "public", table: names.parent },
          { schema: "public", table: names.child }
        ]
      });
      await teardownTenant(client, {
        tenantKey,
        registryTable,
        entities: [
          { schema: "public", table: names.parent },
          { schema: "public", table: names.child }
        ]
      });

      assert.deepEqual(await tenantCounts(client, names, [tenantKey]), {
        registry: 0,
        parent: 0,
        child: 0
      });
    } finally {
      await dropTenantTables(client, names);
    }
  });
});

test("live Postgres stale tenant sweep removes crash leftovers and keeps live tenants", async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  const suffix = tableSuffix("tenant_sweep");
  const names = {
    registry: `${suffix}_registry`,
    parent: `${suffix}_parents`,
    child: `${suffix}_children`
  };
  const registryTable = { schema: "public", table: names.registry };
  const staleKey = tenantPrefixFor({ runId: suffix, scenarioId: "stale.leftover" });
  const liveKey = tenantPrefixFor({ runId: suffix, scenarioId: "live.keep" });

  await withClient(live.target, async (client) => {
    try {
      await createTenantTables(client, names);
      for (const tenantKey of [staleKey, liveKey]) {
        await provisionTenant(client, {
          tenantKey,
          registryTable,
          entities: [
            {
              entity: { schema: "public", table: names.parent },
              rows: [{ id: `${tenantKey}_parent`, email: "$tenantEmail" }]
            }
          ],
          now: () => Date.parse("2026-01-01T00:00:00.000Z")
        });
      }

      const swept = await sweepStaleTenants(client, {
        olderThanMs: 1,
        keep: [liveKey],
        registryTable,
        entities: [{ schema: "public", table: names.parent }],
        now: () => Date.parse("2026-01-02T00:00:00.000Z"),
        logger: null
      });

      assert.deepEqual(swept, [staleKey]);
      assert.deepEqual(await tenantCounts(client, names, [staleKey]), {
        registry: 0,
        parent: 0,
        child: 0
      });
      assert.deepEqual(await tenantCounts(client, names, [liveKey]), {
        registry: 1,
        parent: 1,
        child: 0
      });

      await teardownTenant(client, {
        tenantKey: liveKey,
        registryTable,
        entities: [{ schema: "public", table: names.parent }]
      });
      assert.deepEqual(await tenantCounts(client, names, [staleKey, liveKey]), {
        registry: 0,
        parent: 0,
        child: 0
      });
    } finally {
      await dropTenantTables(client, names);
    }
  });
});
