import assert from "node:assert/strict";
import test from "node:test";

import { AttestError, InfraError } from "../../src/errors.mjs";
import { withClient } from "../../src/db/drivers/postgres/connect.mjs";
import {
  applySeed,
  assertPreState,
  loadSeed,
  seedDigest
} from "../../src/db/seed.mjs";
import { teardownTenant, tenantPrefixFor } from "../../src/db/tenancy.mjs";
import { skipUnlessPostgres } from "../helpers/postgres.mjs";

const SEED_DIR = "test/fixtures/db/seeds";

function enoent() {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function seedText(overrides = "") {
  return `
name: catalog
entities:
  - entity: public.products
    rows:
      - sku: one
        name: Widget
        price_cents: 1200
${overrides}
`;
}

function fakeSeedReader(files) {
  return async (path) => {
    const match = Object.entries(files).find(([suffix]) => path.replace(/\\/gu, "/").endsWith(suffix));
    if (match === undefined) {
      throw enoent();
    }
    return match[1];
  };
}

function fakeClient({ selectRows = [], failInsert = false } = {}) {
  return {
    queries: [],
    async query(text, values = []) {
      const sql = String(text);
      this.queries.push({ text: sql, values });
      if (failInsert && sql.trim().startsWith("INSERT")) {
        throw new Error("insert failed");
      }
      if (/^\s*SELECT/u.test(sql)) {
        return { rows: selectRows };
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

function productSeed(table) {
  return Object.freeze({
    name: "catalog",
    entities: Object.freeze([
      Object.freeze({
        entity: `public.${table}`,
        rows: Object.freeze([
          Object.freeze({ sku: "one", name: "Widget", price_cents: 1200 }),
          Object.freeze({ sku: "two", name: "Gadget", price_cents: 900 })
        ])
      })
    ])
  });
}

async function createProductTable(client, table) {
  await client.query(`
    CREATE TABLE ${qname(table)} (
      tenant_key text NOT NULL,
      sku text NOT NULL,
      name text NOT NULL,
      price_cents integer NOT NULL,
      PRIMARY KEY (tenant_key, sku)
    )
  `);
}

async function productRows(client, table, tenantKey) {
  const result = await client.query(
    `
      SELECT tenant_key, sku, name, price_cents
      FROM ${qname(table)}
      WHERE tenant_key = $1
      ORDER BY sku
    `,
    [tenantKey]
  );
  return result.rows;
}

test("loadSeed loads a declared YAML seed by scenario seed name", async () => {
  const loaded = await loadSeed({
    dir: SEED_DIR,
    name: "catalog",
    readFileImpl: fakeSeedReader({
      "catalog.seed.yaml": seedText()
    })
  });

  assert.equal(loaded.name, "catalog");
  assert.equal(loaded.entities[0].entity, "public.products");
  assert.equal(loaded.entities[0].rows[0].sku, "one");
  assert.match(loaded.digest, /^[0-9a-f]{64}$/u);
});

test("loadSeed raises E_SEED_NOT_FOUND with the seed name and directory", async () => {
  await assert.rejects(
    () =>
      loadSeed({
        dir: SEED_DIR,
        name: "missing",
        readFileImpl: async () => {
          throw enoent();
        }
      }),
    (error) => {
      assert(error instanceof AttestError);
      assert.equal(error.code, "E_SEED_NOT_FOUND");
      assert.equal(error.details.seedName, "missing");
      assert.equal(error.details.directory, SEED_DIR);
      return true;
    }
  );
});

test("loadSeed refuses free SQL and non deterministic markers", async () => {
  await assert.rejects(
    () =>
      loadSeed({
        dir: SEED_DIR,
        name: "unsafe",
        readFileImpl: fakeSeedReader({
          "unsafe.seed.yaml": "name: unsafe\nsql: DELETE FROM users\nentities: []\n"
        })
      }),
    (error) => error instanceof AttestError && error.code === "E_SEED_UNSAFE"
  );

  await assert.rejects(
    () =>
      loadSeed({
        dir: SEED_DIR,
        name: "random",
        readFileImpl: fakeSeedReader({
          "random.seed.yaml": seedText("        token: $random\n")
        })
      }),
    (error) => error instanceof AttestError && error.code === "E_SEED_NON_DETERMINISTIC"
  );
});

test("seedDigest is canonical across key order and changes when a value changes", () => {
  const left = {
    name: "catalog",
    entities: [
      {
        entity: "public.products",
        rows: [{ sku: "one", name: "Widget", price_cents: 1200 }]
      }
    ]
  };
  const right = {
    entities: [
      {
        rows: [{ price_cents: 1200, name: "Widget", sku: "one" }],
        entity: "public.products"
      }
    ],
    name: "catalog"
  };
  const changed = {
    name: "catalog",
    entities: [
      {
        entity: "public.products",
        rows: [{ sku: "one", name: "Widget", price_cents: 1201 }]
      }
    ]
  };

  assert.equal(seedDigest(left), seedDigest(right));
  assert.notEqual(seedDigest(left), seedDigest(changed));
});

test("applySeed inserts rows through parameters inside one tenant transaction", async () => {
  const client = fakeClient();
  const seed = {
    name: "catalog",
    entities: [
      {
        entity: "public.products",
        rows: [{ sku: "one", name: "Widget" }]
      }
    ]
  };
  const tenantKey = tenantPrefixFor({ runId: "seed", scenarioId: "apply" });

  const result = await applySeed(client, seed, { tenantKey });

  assert.equal(result.digest, seedDigest(seed));
  assert.equal(result.insertedRows, 1);
  assert.equal(client.queries[0].text, "BEGIN");
  assert.equal(client.queries.at(-1).text, "COMMIT");
  const insert = client.queries.find((entry) => entry.text.includes("INSERT INTO"));
  assert.match(insert.text, /\$1/u);
  assert.equal(insert.text.includes("Widget"), false);
  assert.deepEqual(insert.values, ["one", "Widget", tenantKey]);
});

test("applySeed refuses rows scoped to another tenant and rolls back failures", async () => {
  const tenantKey = tenantPrefixFor({ runId: "seed", scenarioId: "scope" });
  const client = fakeClient();

  await assert.rejects(
    () =>
      applySeed(
        client,
        {
          name: "bad",
          entities: [
            {
              entity: "public.products",
              rows: [{ sku: "one", tenant_key: "attest_other" }]
            }
          ]
        },
        { tenantKey }
      ),
    (error) => error instanceof InfraError && error.code === "E_SEED_TENANT_SCOPE"
  );
  assert.equal(client.queries.at(-1).text, "ROLLBACK");
});

test("assertPreState raises E_SEED_DIGEST_MISMATCH with the entity name", async () => {
  const tenantKey = tenantPrefixFor({ runId: "seed", scenarioId: "mismatch" });
  const client = fakeClient({
    selectRows: [{ tenant_key: tenantKey, sku: "one", name: "Changed", price_cents: 1200 }]
  });

  await assert.rejects(
    () =>
      assertPreState(
        client,
        {
          name: "catalog",
          entities: [
            {
              entity: "public.products",
              rows: [{ sku: "one", name: "Widget", price_cents: 1200 }]
            }
          ]
        },
        { tenantKey }
      ),
    (error) => {
      assert(error instanceof AttestError);
      assert.equal(error.code, "E_SEED_DIGEST_MISMATCH");
      assert.equal(error.details.entity, "public.products");
      assert.notEqual(error.details.expectedDigest, error.details.observedDigest);
      return true;
    }
  );
});

test("live Postgres seeds apply deterministically, stay tenant scoped, and verify pre state", async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  const table = tableSuffix("seed_products");
  const firstTenant = tenantPrefixFor({ runId: table, scenarioId: "first.seed" });
  const secondTenant = tenantPrefixFor({ runId: table, scenarioId: "second.seed" });
  const outsideTenant = tenantPrefixFor({ runId: table, scenarioId: "outside.seed" });
  const seed = productSeed(table);

  await withClient(live.target, async (client) => {
    try {
      await createProductTable(client, table);
      await client.query(
        `INSERT INTO ${qname(table)} (tenant_key, sku, name, price_cents) VALUES ($1, $2, $3, $4)`,
        [outsideTenant, "outside", "Existing", 1]
      );

      const first = await applySeed(client, seed, { tenantKey: firstTenant });
      const second = await applySeed(client, seed, { tenantKey: secondTenant });
      assert.equal(first.digest, second.digest);
      assert.deepEqual(
        (await productRows(client, table, firstTenant)).map(({ sku, name, price_cents }) => ({ sku, name, price_cents })),
        (await productRows(client, table, secondTenant)).map(({ sku, name, price_cents }) => ({ sku, name, price_cents }))
      );

      await assertPreState(client, seed, { tenantKey: firstTenant });
      assert.equal((await productRows(client, table, outsideTenant)).length, 1);

      await client.query(
        `UPDATE ${qname(table)} SET name = $1 WHERE tenant_key = $2 AND sku = $3`,
        ["Drifted", firstTenant, "one"]
      );
      await assert.rejects(
        () => assertPreState(client, seed, { tenantKey: firstTenant }),
        (error) => error instanceof AttestError && error.code === "E_SEED_DIGEST_MISMATCH"
      );

      await teardownTenant(client, {
        tenantKey: firstTenant,
        registryTable: { schema: "public", table },
        ensureRegistry: false,
        entities: [{ schema: "public", table }]
      }).catch(async () => {
        await client.query(`DELETE FROM ${qname(table)} WHERE tenant_key = $1`, [firstTenant]);
      });
      await client.query(`DELETE FROM ${qname(table)} WHERE tenant_key = $1`, [secondTenant]);
      await client.query(`DELETE FROM ${qname(table)} WHERE tenant_key = $1`, [outsideTenant]);

      const remaining = await client.query(`SELECT count(*)::int AS count FROM ${qname(table)}`);
      assert.equal(remaining.rows[0].count, 0);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${qname(table)}`);
    }
  });
});
