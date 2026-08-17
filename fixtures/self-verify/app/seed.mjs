import { applySeed, seedDigest } from "../../../src/db/seed.mjs";

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function withSchema(seed, schema) {
  return deepFreeze({
    name: seed.name,
    entities: seed.entities.map((entity) => ({
      ...entity,
      schema,
      entity: `${schema}.${entity.table}`
    }))
  });
}

export const SEED = deepFreeze({
  name: "self_verify_shop",
  entities: [
    {
      schema: "public",
      table: "customers",
      entity: "public.customers",
      tenantColumn: "tenant_key",
      rows: [
        { id: "cust_a", name: "Ada Lovelace", email: "ada@attest.invalid", status: "active" },
        { id: "cust_b", name: "Grace Hopper", email: "grace@attest.invalid", status: "active" },
        { id: "cust_c", name: "Katherine Johnson", email: "katherine@attest.invalid", status: "active" }
      ]
    },
    {
      schema: "public",
      table: "orders",
      entity: "public.orders",
      tenantColumn: "tenant_key",
      rows: [
        { id: "order_100", customer_id: "cust_c", status: "paid", total_cents: 6400 },
        { id: "order_101", customer_id: "cust_c", status: "packed", total_cents: 4100 },
        { id: "order_200", customer_id: "cust_a", status: "paid", total_cents: 2200 }
      ]
    },
    {
      schema: "public",
      table: "order_items",
      entity: "public.order_items",
      tenantColumn: "tenant_key",
      rows: [
        { order_id: "order_100", line_number: 1, sku: "seed_clock", quantity: 1, unit_cents: 3200 },
        { order_id: "order_100", line_number: 2, sku: "seed_bag", quantity: 2, unit_cents: 1600 },
        { order_id: "order_101", line_number: 1, sku: "seed_pen", quantity: 3, unit_cents: 700 },
        { order_id: "order_101", line_number: 2, sku: "seed_pad", quantity: 1, unit_cents: 2000 },
        { order_id: "order_200", line_number: 1, sku: "seed_cable", quantity: 1, unit_cents: 2200 }
      ]
    },
    {
      schema: "public",
      table: "order_audit",
      entity: "public.order_audit",
      tenantColumn: "tenant_key",
      rows: [
        { id: "audit_seed_order_100", order_id: "order_100", action: "seeded", detail: "declared seed" },
        { id: "audit_seed_order_101", order_id: "order_101", action: "seeded", detail: "declared seed" },
        { id: "audit_seed_order_200", order_id: "order_200", action: "seeded", detail: "declared seed" }
      ]
    }
  ]
});

export const SEED_DIGEST = seedDigest(SEED);

export async function applyFixtureSeed(client, { schema = "public", tenantKey, seed = SEED } = {}) {
  const declared = schema === "public" ? seed : withSchema(seed, schema);
  const result = await applySeed(client, declared, { tenantKey });

  return Object.freeze({
    seedName: result.seedName,
    digest: result.digest,
    tenantKey: result.tenantKey,
    insertedRows: result.insertedRows
  });
}
