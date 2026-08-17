import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

import { applyFixtureSeed, SEED, SEED_DIGEST } from "../../../fixtures/self-verify/app/seed.mjs";
import { startFixtureApp } from "../../../fixtures/self-verify/app/server.mjs";
import { seedDigest } from "../../../src/db/seed.mjs";
import { skipUnlessPostgres, withPostgresSlotLock } from "../../helpers/postgres.mjs";

const { Client } = pg;
const SCHEMA = "attest_self_verify_app_test";
const TENANT_ONE = "attest_self_verify_one";
const TENANT_TWO = "attest_self_verify_two";
const EXPECTED_SEED_DIGEST = "cdb979c34e26a7007843a11bdf7ec19e9918e286802c6d694063d8c256bcf024";

function q(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qname(schema, table) {
  return `${q(schema)}.${q(table)}`;
}

async function withPg(url, fn) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function dropSchema(url) {
  await withPg(url, (client) => client.query(`DROP SCHEMA IF EXISTS ${q(SCHEMA)} CASCADE`));
}

async function tableCounts(url, tenantKey) {
  return withPg(url, async (client) => {
    const entries = await Promise.all(
      ["customers", "orders", "order_items", "order_audit"].map(async (table) => {
        const result = await client.query(
          `SELECT count(*)::int AS count FROM ${qname(SCHEMA, table)} WHERE tenant_key = $1`,
          [tenantKey]
        );
        return [table, result.rows[0].count];
      })
    );
    return Object.freeze(Object.fromEntries(entries));
  });
}

async function customerOrderRows(url, tenantKey, customerId) {
  return withPg(url, async (client) => {
    const result = await client.query(
      `SELECT id FROM ${qname(SCHEMA, "orders")} WHERE tenant_key = $1 AND customer_id = $2 ORDER BY id`,
      [tenantKey, customerId]
    );
    return Object.freeze(result.rows.map((row) => row.id));
  });
}

async function auditRows(url, tenantKey, action) {
  return withPg(url, async (client) => {
    const result = await client.query(
      `SELECT id, order_id, action, detail FROM ${qname(SCHEMA, "order_audit")}
       WHERE tenant_key = $1 AND action = $2 ORDER BY id`,
      [tenantKey, action]
    );
    return Object.freeze(result.rows.map((row) => Object.freeze({ ...row })));
  });
}

async function seedRowsWithoutTenant(url, tenantKey) {
  return withPg(url, async (client) => {
    const customers = await client.query(
      `SELECT id, name, email, status FROM ${qname(SCHEMA, "customers")} WHERE tenant_key = $1 ORDER BY id`,
      [tenantKey]
    );
    const orders = await client.query(
      `SELECT id, customer_id, status, total_cents FROM ${qname(SCHEMA, "orders")} WHERE tenant_key = $1 ORDER BY id`,
      [tenantKey]
    );
    const items = await client.query(
      `SELECT order_id, line_number, sku, quantity, unit_cents FROM ${qname(SCHEMA, "order_items")} WHERE tenant_key = $1 ORDER BY order_id, line_number`,
      [tenantKey]
    );
    return JSON.stringify({ customers: customers.rows, orders: orders.rows, items: items.rows });
  });
}

async function prepare(live, fn) {
  return withPostgresSlotLock(live, async () => {
    await dropSchema(live.url);
    try {
      return await fn();
    } finally {
      await dropSchema(live.url);
    }
  });
}

test("fixture seed digest is declared and stable across fresh tenants", async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  await prepare(live, async () => {
    await withPg(live.url, async (client) => {
      const schemaSql = await readFile("fixtures/self-verify/app/schema.sql", "utf8");
      await client.query(`CREATE SCHEMA ${q(SCHEMA)}`);
      await client.query(`SET search_path TO ${q(SCHEMA)}`);
      await client.query(schemaSql);
      const first = await applyFixtureSeed(client, { schema: SCHEMA, tenantKey: TENANT_ONE });
      const second = await applyFixtureSeed(client, { schema: SCHEMA, tenantKey: TENANT_TWO });
      assert.equal(SEED_DIGEST, seedDigest(SEED));
      assert.equal(first.digest, EXPECTED_SEED_DIGEST);
      assert.equal(second.digest, EXPECTED_SEED_DIGEST);
      assert.equal(first.insertedRows, 14);
      assert.equal(await seedRowsWithoutTenant(live.url, TENANT_ONE), await seedRowsWithoutTenant(live.url, TENANT_TWO));
    });
  });
});

test("startFixtureApp rejects schema names that are not plain identifiers", async () => {
  await assert.rejects(
    () => startFixtureApp({ target: { driver: "postgres", host: "127.0.0.1", port: 5432, database: "postgres", user: "postgres" }, schema: "bad-name" }),
    /plain lowercase PostgreSQL identifier/u
  );
});

test("fixture app listens on assigned ports and serves deterministic pages", async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  await prepare(live, async () => {
    const first = await startFixtureApp({ target: live.target, schema: SCHEMA, tenantKey: TENANT_ONE });
    const second = await startFixtureApp({ target: live.target, schema: SCHEMA, tenantKey: TENANT_TWO });
    try {
      assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
      assert.match(second.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
      assert.notEqual(first.url, second.url);
      const firstPage = await fetch(first.url).then((response) => response.text());
      const secondPage = await fetch(first.url).then((response) => response.text());
      assert.equal(firstPage, secondPage);
      assert.match(firstPage, /data-testid="customer-list"/u);
      assert.match(firstPage, /customer-link-cust_c/u);
    } finally {
      await first.close();
      await second.close();
    }
    await assert.rejects(() => fetch(first.url));
  });
});

test("delete customer removes child rows and writes one audit row per deleted order", async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  await prepare(live, async () => {
    const app = await startFixtureApp({ target: live.target, schema: SCHEMA, tenantKey: TENANT_ONE });
    try {
      assert.deepEqual(await customerOrderRows(live.url, TENANT_ONE, "cust_c"), ["order_100", "order_101"]);
      const response = await fetch(`${app.url}/customers/cust_c/delete`, { method: "POST", redirect: "manual" });
      assert.equal(response.status, 303);
      const counts = await tableCounts(live.url, TENANT_ONE);
      assert.deepEqual(counts, { customers: 2, orders: 1, order_items: 1, order_audit: 5 });
      assert.deepEqual(await customerOrderRows(live.url, TENANT_ONE, "cust_c"), []);
      assert.deepEqual(
        await auditRows(live.url, TENANT_ONE, "deleted"),
        [
          { id: "audit_deleted_order_100", order_id: "order_100", action: "deleted", detail: "deleted with customer cust_c" },
          { id: "audit_deleted_order_101", order_id: "order_101", action: "deleted", detail: "deleted with customer cust_c" }
        ]
      );
    } finally {
      await app.close();
    }
  });
});

test("create order inserts order items and exactly one audit row", async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  await prepare(live, async () => {
    const app = await startFixtureApp({ target: live.target, schema: SCHEMA, tenantKey: TENANT_ONE });
    try {
      const response = await fetch(`${app.url}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: "cust_a",
          orderId: "order_new",
          status: "created",
          totalCents: 5300,
          items: [
            { sku: "new_lamp", quantity: 1, unitCents: 3300 },
            { sku: "new_shade", quantity: 2, unitCents: 1000 }
          ]
        })
      });
      assert.equal(response.status, 201);
      assert.deepEqual(await customerOrderRows(live.url, TENANT_ONE, "cust_a"), ["order_200", "order_new"]);
      assert.deepEqual(await auditRows(live.url, TENANT_ONE, "created"), [
        { id: "audit_created_order_new", order_id: "order_new", action: "created", detail: "order created" }
      ]);
    } finally {
      await app.close();
    }
  });
});

test("fixture app test cleanup leaves no schema behind", async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  await withPostgresSlotLock(live, async () => {
    await dropSchema(live.url);
    const exists = await withPg(live.url, async (client) => {
      const result = await client.query("SELECT to_regnamespace($1) AS oid", [SCHEMA]);
      return result.rows[0].oid !== null;
    });
    assert.equal(exists, false);
  });
});
