import { readFile } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

import pg from "pg";

import { applyFixtureSeed, SEED } from "./seed.mjs";
import { tenantPrefixFor } from "../../../src/db/tenancy.mjs";

const { Pool } = pg;
const SCHEMA_SQL = fileURLToPath(new URL("./schema.sql", import.meta.url));
const DEFAULT_TARGET_PORT = 5432;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const TEXT_HTML = "text/html; charset=utf-8";
const TEXT_PLAIN = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";

function assertPlainIdentifier(schema) {
  if (typeof schema !== "string" || !IDENTIFIER_PATTERN.test(schema)) {
    throw new TypeError("Fixture schema must be a plain lowercase PostgreSQL identifier");
  }
}

function assertTarget(target) {
  if (
    target === null ||
    typeof target !== "object" ||
    !["postgres", "postgresql"].includes(target.driver) ||
    typeof target.host !== "string" ||
    typeof target.port !== "number" ||
    typeof target.database !== "string" ||
    typeof target.user !== "string"
  ) {
    throw new TypeError("startFixtureApp requires a resolved PostgreSQL target");
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}

function quoteIdent(identifier) {
  assertPlainIdentifier(identifier);
  return `"${identifier.replace(/"/gu, "\"\"")}"`;
}

function qname(schema, table) {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

function databaseName(parsed) {
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  return database.length > 0 ? database : null;
}

function parsedPort(parsed) {
  return parsed.port === "" ? DEFAULT_TARGET_PORT : Number(parsed.port);
}

function parsedMatchesTarget(parsed, target) {
  return (
    parsed.hostname.toLowerCase() === target.host.toLowerCase() &&
    parsedPort(parsed) === target.port &&
    databaseName(parsed) === target.database &&
    decodeURIComponent(parsed.username) === target.user
  );
}

function passwordFromEnvironment(target, env) {
  for (const key of ["ATTEST_DB_URL", "ATTEST_PG_URL"]) {
    const value = env?.[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    const parsed = new URL(value);
    if (parsedMatchesTarget(parsed, target)) {
      return decodeURIComponent(parsed.password);
    }
  }
  return undefined;
}

function poolConfig(target, env) {
  const config = {
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    application_name: "attest_self_verify_fixture",
    max: 4,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 5000
  };
  const password = passwordFromEnvironment(target, env);
  if (password !== undefined) {
    Object.defineProperty(config, "password", {
      value: password,
      enumerable: false,
      configurable: true,
      writable: false
    });
  }
  return config;
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function send(response, statusCode, body, contentType = TEXT_HTML) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": contentType
  });
  response.end(body);
}

function notFound(response) {
  send(response, 404, "not found", TEXT_PLAIN);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function formValue(data, key) {
  const value = data.get(key);
  return typeof value === "string" ? value : null;
}

function parseItems(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new TypeError("items must be an array");
  }
  return parsed.map((item, index) => Object.freeze({
    lineNumber: index + 1,
    sku: String(item.sku),
    quantity: Number(item.quantity),
    unitCents: Number(item.unitCents)
  }));
}

async function parseOrderRequest(request) {
  const body = await readBody(request);
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(body);
    return Object.freeze({
      customerId: String(parsed.customerId),
      orderId: String(parsed.orderId),
      status: String(parsed.status ?? "created"),
      totalCents: Number(parsed.totalCents),
      items: parseItems(JSON.stringify(parsed.items ?? []))
    });
  }
  const data = new URLSearchParams(body);
  return Object.freeze({
    customerId: formValue(data, "customer_id"),
    orderId: formValue(data, "order_id"),
    status: formValue(data, "status") ?? "created",
    totalCents: Number(formValue(data, "total_cents")),
    items: parseItems(formValue(data, "items"))
  });
}

function assertOrderInput(input) {
  if (
    typeof input.customerId !== "string" ||
    typeof input.orderId !== "string" ||
    !Number.isSafeInteger(input.totalCents) ||
    input.items.length === 0
  ) {
    throw new TypeError("order input is invalid");
  }
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.quantity) || !Number.isSafeInteger(item.unitCents)) {
      throw new TypeError("order item input is invalid");
    }
  }
}

async function applySchemaAndSeed(pool, { schema, seed, tenantKey, signal }) {
  throwIfAborted(signal);
  const client = await pool.connect();
  try {
    const schemaSql = await readFile(SCHEMA_SQL, "utf8");
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    await client.query(`SET search_path TO ${quoteIdent(schema)}`);
    await client.query(schemaSql);
    return await applyFixtureSeed(client, { schema, tenantKey, seed });
  } finally {
    client.release();
  }
}

async function rows(pool, sql, values) {
  const result = await pool.query(sql, values);
  return result.rows;
}

async function customerRows(pool, schema, tenantKey) {
  return rows(
    pool,
    `SELECT id, name, email, status FROM ${qname(schema, "customers")} WHERE tenant_key = $1 ORDER BY name, id`,
    [tenantKey]
  );
}

async function orderRows(pool, schema, tenantKey, customerId) {
  return rows(
    pool,
    `SELECT id, customer_id, status, total_cents FROM ${qname(schema, "orders")}
     WHERE tenant_key = $1 AND customer_id = $2 ORDER BY id`,
    [tenantKey, customerId]
  );
}

async function itemRows(pool, schema, tenantKey, orderIds) {
  if (orderIds.length === 0) {
    return [];
  }
  return rows(
    pool,
    `SELECT order_id, line_number, sku, quantity, unit_cents FROM ${qname(schema, "order_items")}
     WHERE tenant_key = $1 AND order_id = ANY($2::text[]) ORDER BY order_id, line_number`,
    [tenantKey, orderIds]
  );
}

function renderCustomerList(customers) {
  const items = customers.map((customer) =>
    `<li data-testid="customer-row"><a data-testid="customer-link-${htmlEscape(customer.id)}" href="/customers/${htmlEscape(customer.id)}">${htmlEscape(customer.name)}</a></li>`
  );
  return `<!doctype html><html><body><main data-testid="customer-list"><h1>Customers</h1><ul>${items.join("")}</ul></main></body></html>`;
}

function renderCustomerDetail(customer, orders, items) {
  const itemGroups = new Map(items.map((item) => [item.order_id, []]));
  for (const item of items) {
    itemGroups.get(item.order_id).push(item);
  }
  const renderedOrders = orders.map((order) => {
    const renderedItems = (itemGroups.get(order.id) ?? []).map((item) =>
      `<li data-testid="item-row">${htmlEscape(item.sku)} ${item.quantity} ${item.unit_cents}</li>`
    );
    return `<section data-testid="order-row"><h2>${htmlEscape(order.id)}</h2><p>${htmlEscape(order.status)}</p><ul>${renderedItems.join("")}</ul></section>`;
  });
  return `<!doctype html><html><body><main data-testid="customer-detail"><h1>${htmlEscape(customer.name)}</h1>${renderedOrders.join("")}</main></body></html>`;
}

async function handleList(context, response) {
  send(response, 200, renderCustomerList(await customerRows(context.pool, context.schema, context.tenantKey)));
}

async function handleCustomer(context, response, customerId) {
  const customers = await rows(
    context.pool,
    `SELECT id, name, email, status FROM ${qname(context.schema, "customers")} WHERE tenant_key = $1 AND id = $2`,
    [context.tenantKey, customerId]
  );
  if (customers.length === 0) {
    notFound(response);
    return;
  }
  const orders = await orderRows(context.pool, context.schema, context.tenantKey, customerId);
  const items = await itemRows(context.pool, context.schema, context.tenantKey, orders.map((order) => order.id));
  send(response, 200, renderCustomerDetail(customers[0], orders, items));
}

async function handleDelete(context, response, customerId) {
  const client = await context.pool.connect();
  try {
    await client.query("BEGIN");
    const orders = await client.query(
      `SELECT id FROM ${qname(context.schema, "orders")} WHERE tenant_key = $1 AND customer_id = $2 ORDER BY id`,
      [context.tenantKey, customerId]
    );
    const orderIds = orders.rows.map((row) => row.id);
    await client.query(`DELETE FROM ${qname(context.schema, "order_items")} WHERE tenant_key = $1 AND order_id = ANY($2::text[])`, [context.tenantKey, orderIds]);
    await client.query(`DELETE FROM ${qname(context.schema, "orders")} WHERE tenant_key = $1 AND customer_id = $2`, [context.tenantKey, customerId]);
    await client.query(`DELETE FROM ${qname(context.schema, "customers")} WHERE tenant_key = $1 AND id = $2`, [context.tenantKey, customerId]);
    for (const orderId of orderIds) {
      await client.query(
        `INSERT INTO ${qname(context.schema, "order_audit")} (tenant_key, id, order_id, action, detail) VALUES ($1, $2, $3, $4, $5)`,
        [context.tenantKey, `audit_deleted_${orderId}`, orderId, "deleted", `deleted with customer ${customerId}`]
      );
    }
    await client.query("COMMIT");
    send(response, 303, "", TEXT_PLAIN);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handleCreateOrder(context, request, response) {
  const input = await parseOrderRequest(request);
  assertOrderInput(input);
  const client = await context.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO ${qname(context.schema, "orders")} (tenant_key, id, customer_id, status, total_cents) VALUES ($1, $2, $3, $4, $5)`,
      [context.tenantKey, input.orderId, input.customerId, input.status, input.totalCents]
    );
    for (const item of input.items) {
      await client.query(
        `INSERT INTO ${qname(context.schema, "order_items")} (tenant_key, order_id, line_number, sku, quantity, unit_cents) VALUES ($1, $2, $3, $4, $5, $6)`,
        [context.tenantKey, input.orderId, item.lineNumber, item.sku, item.quantity, item.unitCents]
      );
    }
    await client.query(
      `INSERT INTO ${qname(context.schema, "order_audit")} (tenant_key, id, order_id, action, detail) VALUES ($1, $2, $3, $4, $5)`,
      [context.tenantKey, `audit_created_${input.orderId}`, input.orderId, "created", "order created"]
    );
    await client.query("COMMIT");
    send(response, 201, JSON.stringify({ ok: true, orderId: input.orderId }), JSON_TYPE);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handleRequest(context, request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const deleteMatch = /^\/customers\/([^/]+)\/delete$/u.exec(url.pathname);
  const customerMatch = /^\/customers\/([^/]+)$/u.exec(url.pathname);
  if (request.method === "GET" && url.pathname === "/") {
    await handleList(context, response);
  } else if (request.method === "GET" && customerMatch !== null) {
    await handleCustomer(context, response, decodeURIComponent(customerMatch[1]));
  } else if (request.method === "POST" && deleteMatch !== null) {
    await handleDelete(context, response, decodeURIComponent(deleteMatch[1]));
  } else if (request.method === "POST" && url.pathname === "/orders") {
    await handleCreateOrder(context, request, response);
  } else {
    notFound(response);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address());
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

export async function startFixtureApp({ target, schema, seed = SEED, signal, env = process.env, tenantKey } = {}) {
  assertTarget(target);
  assertPlainIdentifier(schema);
  const pool = new Pool(poolConfig(target, env));
  const resolvedTenantKey = tenantKey ?? tenantPrefixFor({ runId: schema, scenarioId: "self_verify_fixture", surface: "web" });
  const seedResult = await applySchemaAndSeed(pool, { schema, seed, tenantKey: resolvedTenantKey, signal });
  const context = Object.freeze({ pool, schema, tenantKey: resolvedTenantKey });
  const server = http.createServer((request, response) => {
    handleRequest(context, request, response).catch(() => {
      if (response.headersSent) {
        response.destroy();
      } else {
        send(response, 500, "server error", TEXT_PLAIN);
      }
    });
  });
  const address = await listen(server);
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}`,
    tenantKey: resolvedTenantKey,
    seedDigest: seedResult.digest,
    async close() {
      await closeServer(server);
      await pool.end();
      return Object.freeze({ ok: true });
    }
  });
}
