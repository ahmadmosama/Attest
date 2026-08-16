import { createHash } from "node:crypto";

import { InfraError } from "../errors.mjs";

export const RESERVED_EMAIL_DOMAIN = "attest.invalid";

const TENANT_PREFIX = "attest";
const IDENTIFIER_LIMIT = 63;
const HASH_SEGMENT_LENGTH = 16;
const RUN_SEGMENT_LIMIT = 18;
const DEFAULT_TENANT_COLUMN = "tenant_key";
const DEFAULT_REGISTRY_TABLE = Object.freeze({
  schema: "public",
  table: "attest_tenants"
});
const SIGNAL_EXIT_CODES = Object.freeze({
  SIGINT: 130,
  SIGTERM: 143
});

const openTenants = new Map();
const processHandlers = new Map();

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function sanitizeSegment(value, fallback = "tenant") {
  const raw = String(value ?? "").toLowerCase();
  const normalized = raw.replace(/[^a-z0-9_]/gu, "_").replace(/_+/gu, "_").replace(/^_+|_+$/gu, "");
  return normalized.length > 0 ? normalized : fallback;
}

function hashSegment(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, HASH_SEGMENT_LENGTH);
}

function attestPrefixSegment(configuredPrefix) {
  const configured = sanitizeSegment(configuredPrefix, TENANT_PREFIX);
  if (configured === TENANT_PREFIX || configured.startsWith(`${TENANT_PREFIX}_`)) {
    return configured;
  }
  return `${TENANT_PREFIX}_${configured}`;
}

function tenantEmailFor(tenantKey) {
  return `${tenantKey}@${RESERVED_EMAIL_DOMAIN}`;
}

function assertClient(client) {
  if (client === null || typeof client !== "object" || typeof client.query !== "function") {
    throw new TypeError("Tenant operations require a PostgreSQL client");
  }
}

function assertTenantKey(tenantKey) {
  if (typeof tenantKey !== "string" || !/^attest_[a-z0-9_]+$/u.test(tenantKey)) {
    throw new TypeError("Tenant keys must start with attest_ and contain only lowercase letters, digits, and underscores");
  }

  if (Buffer.byteLength(tenantKey, "utf8") > IDENTIFIER_LIMIT) {
    throw new TypeError("Tenant keys must not exceed 63 bytes");
  }
}

function normalizeKeep(keep) {
  if (keep === undefined || keep === null) {
    return new Set();
  }

  if (keep instanceof Set) {
    return new Set(Array.from(keep, String));
  }

  if (Array.isArray(keep)) {
    return new Set(keep.map(String));
  }

  return new Set([String(keep)]);
}

function normalizeEntity(entity, defaultTenantColumn = DEFAULT_TENANT_COLUMN) {
  if (typeof entity === "string") {
    const [schema, table, extra] = entity.split(".");
    if (extra !== undefined) {
      throw new TypeError(`Invalid tenant entity reference: ${entity}`);
    }

    return Object.freeze({
      schema: table === undefined ? "public" : schema,
      table: table === undefined ? schema : table,
      tenantColumn: defaultTenantColumn,
      rows: Object.freeze([])
    });
  }

  if (isPlainObject(entity)) {
    const reference =
      typeof entity.entity === "string" || isPlainObject(entity.entity)
        ? normalizeEntity(entity.entity, defaultTenantColumn)
        : null;
    const schema = entity.schema ?? reference?.schema ?? "public";
    const table = entity.table ?? entity.tableName ?? entity.name ?? reference?.table;
    const tenantColumn = entity.tenantColumn ?? defaultTenantColumn;

    if (typeof schema === "string" && schema.length > 0 && typeof table === "string" && table.length > 0) {
      return deepFreeze({
        schema,
        table,
        tenantColumn,
        rows: Array.isArray(entity.rows) ? entity.rows.map((row) => ({ ...row })) : []
      });
    }
  }

  throw new TypeError("Tenant entities must name a schema and table");
}

function normalizeEntities(entities, tenantColumn) {
  if (entities === undefined || entities === null) {
    return [];
  }

  if (!Array.isArray(entities)) {
    throw new TypeError("Tenant entities must be an array");
  }

  return entities.map((entity) => normalizeEntity(entity, tenantColumn));
}

function normalizeRegistryTable(value) {
  return normalizeEntity(value ?? DEFAULT_REGISTRY_TABLE, DEFAULT_TENANT_COLUMN);
}

function quoteIdent(identifier) {
  if (typeof identifier !== "string" || identifier.length === 0 || identifier.includes("\0")) {
    throw new TypeError("PostgreSQL identifiers must be non empty strings");
  }

  return `"${identifier.replace(/"/gu, "\"\"")}"`;
}

function qualifiedName(entity) {
  return `${quoteIdent(entity.schema)}.${quoteIdent(entity.table)}`;
}

function entityKey(entity) {
  return `${entity.schema}.${entity.table}`;
}

function replaceTenantTokens(value, tenant) {
  if (value === "$tenantKey") {
    return tenant.tenantKey;
  }
  if (value === "$tenantPrefix") {
    return tenant.tenantPrefix;
  }
  if (value === "$tenantEmail") {
    return tenant.email;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceTenantTokens(item, tenant));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, replaceTenantTokens(child, tenant)])
    );
  }
  return value;
}

function scopedRow(row, entity, tenant) {
  if (!isPlainObject(row)) {
    throw new TypeError("Tenant rows must be plain objects");
  }

  const replaced = replaceTenantTokens(row, tenant);
  if (
    Object.hasOwn(replaced, entity.tenantColumn) &&
    replaced[entity.tenantColumn] !== tenant.tenantKey
  ) {
    throw new InfraError("E_TENANT_SCOPE", "Tenant row would be written outside the scenario tenant.", {
      entity: entityKey(entity),
      tenantColumn: entity.tenantColumn,
      tenantKey: tenant.tenantKey
    });
  }

  return {
    ...replaced,
    [entity.tenantColumn]: tenant.tenantKey
  };
}

async function queryRows(client, text, values = [], signal, abortCode, abortMessage, details = {}) {
  if (signal?.aborted === true) {
    throw new InfraError(abortCode, abortMessage, {
      ...details,
      reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "aborted")
    });
  }
  const result = await client.query(text, values);
  if (signal?.aborted === true) {
    throw new InfraError(abortCode, abortMessage, {
      ...details,
      reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "aborted")
    });
  }
  return Array.isArray(result?.rows) ? result.rows : [];
}

async function ensureRegistry(client, registryTable, signal) {
  await queryRows(
    client,
    `
      CREATE TABLE IF NOT EXISTS ${qualifiedName(registryTable)} (
        tenant_key text PRIMARY KEY,
        tenant_prefix text NOT NULL,
        created_at timestamptz NOT NULL,
        email text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `,
    [],
    signal,
    "E_TENANT_PROVISION_ABORTED",
    "Tenant provisioning was aborted."
  );
}

async function insertRow(client, entity, row, signal) {
  const entries = Object.entries(row);
  const columns = entries.map(([column]) => quoteIdent(column)).join(", ");
  const placeholders = entries.map((_, index) => `$${index + 1}`).join(", ");

  await queryRows(
    client,
    `INSERT INTO ${qualifiedName(entity)} (${columns}) VALUES (${placeholders})`,
    entries.map(([, value]) => value),
    signal,
    "E_TENANT_PROVISION_ABORTED",
    "Tenant provisioning was aborted.",
    { entity: entityKey(entity) }
  );
}

async function registryRowsFor(client, registryTable, cutoff, signal) {
  try {
    return await queryRows(
      client,
      `
        SELECT tenant_key
        FROM ${qualifiedName(registryTable)}
        WHERE tenant_key LIKE 'attest\\_%' ESCAPE '\\'
          AND created_at < $1
        ORDER BY created_at, tenant_key
      `,
      [cutoff],
      signal,
      "E_TENANT_SWEEP_ABORTED",
      "Tenant sweep was aborted."
    );
  } catch (error) {
    if (error?.code === "42P01") {
      return [];
    }
    throw error;
  }
}

function syntheticTenant({ tenantKey, tenantPrefix, now, metadata }) {
  return Object.freeze({
    tenantKey,
    tenantPrefix,
    email: tenantEmailFor(tenantKey),
    createdAt: new Date(now()).toISOString(),
    metadata: isPlainObject(metadata) ? { ...metadata } : {}
  });
}

function registerTenant(client, tenantKey, options) {
  openTenants.set(tenantKey, { client, tenantKey, options });
  installProcessHandlers();
}

function unregisterTenant(tenantKey) {
  openTenants.delete(tenantKey);
  if (openTenants.size === 0) {
    removeProcessHandlers();
  }
}

async function teardownRegisteredTenants(reason) {
  const failures = [];
  for (const entry of Array.from(openTenants.values())) {
    try {
      await teardownTenant(entry.client, {
        ...entry.options,
        tenantKey: entry.tenantKey,
        reason
      });
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function processSignalHandler(signalName) {
  return () => {
    const exitCode = SIGNAL_EXIT_CODES[signalName] ?? 1;
    void teardownRegisteredTenants(signalName).finally(() => {
      process.exit(exitCode);
    });
  };
}

function beforeExitHandler() {
  void teardownRegisteredTenants("beforeExit");
}

function installProcessHandlers() {
  if (processHandlers.size > 0) {
    return;
  }

  for (const signalName of Object.keys(SIGNAL_EXIT_CODES)) {
    const handler = processSignalHandler(signalName);
    processHandlers.set(signalName, handler);
    process.on(signalName, handler);
  }

  processHandlers.set("beforeExit", beforeExitHandler);
  process.on("beforeExit", beforeExitHandler);
}

function removeProcessHandlers() {
  for (const [eventName, handler] of processHandlers) {
    process.off(eventName, handler);
  }
  processHandlers.clear();
}

async function foreignKeyEdges(client, entities) {
  if (entities.length <= 1) {
    return [];
  }

  const requested = entities.map((entity) => ({
    schema_name: entity.schema,
    table_name: entity.table
  }));
  const rows = await queryRows(
    client,
    `
      WITH requested AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(schema_name text, table_name text)
      )
      SELECT
        child_ns.nspname AS child_schema,
        child.relname AS child_table,
        parent_ns.nspname AS parent_schema,
        parent.relname AS parent_table
      FROM pg_constraint constraint_row
      JOIN pg_class child ON child.oid = constraint_row.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = constraint_row.confrelid
      JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
      JOIN requested requested_child
        ON requested_child.schema_name = child_ns.nspname
       AND requested_child.table_name = child.relname
      JOIN requested requested_parent
        ON requested_parent.schema_name = parent_ns.nspname
       AND requested_parent.table_name = parent.relname
      WHERE constraint_row.contype = 'f'
    `,
    [JSON.stringify(requested)]
  );

  return rows.map((row) => Object.freeze({
    child: `${row.child_schema}.${row.child_table}`,
    parent: `${row.parent_schema}.${row.parent_table}`
  }));
}

function deleteOrder(entities, edges) {
  const byKey = new Map(entities.map((entity) => [entityKey(entity), entity]));
  const childrenByParent = new Map();

  for (const edge of edges) {
    const children = childrenByParent.get(edge.parent) ?? new Set();
    children.add(edge.child);
    childrenByParent.set(edge.parent, children);
  }

  const visiting = new Set();
  const visited = new Set();
  const ordered = [];

  function visit(key) {
    if (visited.has(key)) {
      return;
    }
    if (visiting.has(key)) {
      ordered.push(byKey.get(key));
      visited.add(key);
      return;
    }

    visiting.add(key);
    for (const child of childrenByParent.get(key) ?? []) {
      visit(child);
    }
    visiting.delete(key);
    visited.add(key);
    ordered.push(byKey.get(key));
  }

  for (const key of byKey.keys()) {
    visit(key);
  }

  return ordered.filter(Boolean);
}

async function deleteTenantRows(client, entity, tenantKey, signal) {
  await queryRows(
    client,
    `DELETE FROM ${qualifiedName(entity)} WHERE ${quoteIdent(entity.tenantColumn)} = $1`,
    [tenantKey],
    signal,
    "E_TENANT_TEARDOWN_ABORTED",
    "Tenant teardown was aborted.",
    { entity: entityKey(entity), tenantKey }
  );
}

function logSweep(logger, action, tenantKey, details = {}) {
  const entry = Object.freeze({ action, tenantKey, ...details });
  if (typeof logger === "function") {
    logger(entry);
    return;
  }
  if (logger !== null && logger !== false) {
    console.warn(`[attest:postgres:tenants] ${action} ${tenantKey}`);
  }
}

export function tenantPrefixFor({
  runId,
  scenarioId,
  surface = "db",
  configuredPrefix = TENANT_PREFIX
} = {}) {
  const configured = attestPrefixSegment(configuredPrefix);
  const runSegment = sanitizeSegment(runId, "run").slice(0, RUN_SEGMENT_LIMIT);
  const hash = hashSegment(`${String(runId ?? "")}\0${String(scenarioId ?? "")}\0${String(surface ?? "")}`);
  const prefix = `${configured}_${runSegment}_${hash}`;

  if (Buffer.byteLength(prefix, "utf8") <= IDENTIFIER_LIMIT) {
    return prefix;
  }

  const budget = IDENTIFIER_LIMIT - configured.length - 1 - HASH_SEGMENT_LENGTH;
  return `${configured}_${runSegment.slice(0, Math.max(1, budget))}_${hash}`;
}

export async function provisionTenant(client, options = {}) {
  assertClient(client);
  const tenantKey = options.tenantKey ?? tenantPrefixFor(options);
  assertTenantKey(tenantKey);

  const tenantPrefix = options.tenantPrefix ?? tenantKey;
  const tenantColumn = options.tenantColumn ?? DEFAULT_TENANT_COLUMN;
  const registryTable = normalizeRegistryTable(options.registryTable);
  const entities = normalizeEntities(options.entities, tenantColumn);
  const tenant = syntheticTenant({
    tenantKey,
    tenantPrefix,
    now: options.now ?? Date.now,
    metadata: options.metadata
  });

  await queryRows(client, "BEGIN", [], options.signal, "E_TENANT_PROVISION_ABORTED", "Tenant provisioning was aborted.");
  try {
    if (options.ensureRegistry !== false) {
      await ensureRegistry(client, registryTable, options.signal);
    }
    await insertRow(client, registryTable, {
      tenant_key: tenant.tenantKey,
      tenant_prefix: tenant.tenantPrefix,
      created_at: tenant.createdAt,
      email: tenant.email,
      metadata: JSON.stringify(tenant.metadata)
    }, options.signal);

    for (const entity of entities) {
      for (const row of entity.rows) {
        await insertRow(client, entity, scopedRow(row, entity, tenant), options.signal);
      }
    }

    await queryRows(client, "COMMIT", [], options.signal, "E_TENANT_PROVISION_ABORTED", "Tenant provisioning was aborted.");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the provisioning failure that determines the run result.
    }
    if (error instanceof InfraError) {
      throw error;
    }
    throw new InfraError("E_TENANT_PROVISION", "Failed to provision scenario tenant.", {
      tenantKey,
      causeCode: error?.code ?? null,
      causeMessage: error instanceof Error ? error.message : String(error)
    });
  }

  registerTenant(client, tenantKey, {
    entities,
    registryTable,
    tenantColumn,
    signal: options.signal
  });
  return deepFreeze(tenant);
}

export function scopeToTenant(events, { tenantKey, tenantColumn = DEFAULT_TENANT_COLUMN } = {}) {
  assertTenantKey(tenantKey);
  if (!Array.isArray(events)) {
    throw new TypeError("Captured events must be an array");
  }

  const inside = [];
  const outside = [];

  for (const event of events) {
    const rows = [event?.key, event?.before, event?.after].filter(isPlainObject);
    const hasTenantColumn = rows.some((row) => Object.hasOwn(row, tenantColumn));
    const matchesTenant = rows.some((row) => row[tenantColumn] === tenantKey);

    if (hasTenantColumn && matchesTenant) {
      inside.push(event);
    } else {
      outside.push(event);
    }
  }

  return deepFreeze({
    tenantKey,
    tenantColumn,
    inside,
    outside
  });
}

export async function teardownTenant(client, options = {}) {
  assertClient(client);
  const tenantKey = options.tenantKey;
  assertTenantKey(tenantKey);

  const tenantColumn = options.tenantColumn ?? DEFAULT_TENANT_COLUMN;
  const registryTable = normalizeRegistryTable(options.registryTable);
  const entities = normalizeEntities(options.entities, tenantColumn);

  try {
    const ordered = deleteOrder(entities, await foreignKeyEdges(client, entities));
    await queryRows(client, "BEGIN", [], options.signal, "E_TENANT_TEARDOWN_ABORTED", "Tenant teardown was aborted.");
    try {
      for (const entity of ordered) {
        await deleteTenantRows(client, entity, tenantKey, options.signal);
      }
      await deleteTenantRows(client, registryTable, tenantKey, options.signal);
      await queryRows(client, "COMMIT", [], options.signal, "E_TENANT_TEARDOWN_ABORTED", "Tenant teardown was aborted.");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the teardown failure for infrastructure reporting.
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof InfraError) {
      throw error;
    }
    throw new InfraError("E_TENANT_TEARDOWN", "Failed to tear down scenario tenant.", {
      tenantKey,
      severity: "infra_error",
      causeCode: error?.code ?? null,
      causeMessage: error instanceof Error ? error.message : String(error)
    });
  } finally {
    unregisterTenant(tenantKey);
  }

  return Object.freeze({
    tenantKey,
    ok: true
  });
}

export async function sweepStaleTenants(client, options = {}) {
  assertClient(client);
  const olderThanMs = options.olderThanMs ?? 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) {
    throw new TypeError("olderThanMs must be a non negative safe integer");
  }

  const registryTable = normalizeRegistryTable(options.registryTable);
  const keep = normalizeKeep(options.keep);
  const logger = Object.hasOwn(options, "logger") ? options.logger : console.warn;
  const cutoff = new Date((options.now ?? Date.now)() - olderThanMs);
  const rows = await registryRowsFor(client, registryTable, cutoff, options.signal);
  const swept = [];

  for (const row of rows) {
    const tenantKey = String(row.tenant_key ?? row.tenantKey ?? "");
    if (!tenantKey.startsWith(`${TENANT_PREFIX}_`)) {
      logSweep(logger, "skip_non_attest", tenantKey);
      continue;
    }
    if (keep.has(tenantKey)) {
      logSweep(logger, "skip_keep", tenantKey);
      continue;
    }

    logSweep(logger, "drop_stale", tenantKey);
    await teardownTenant(client, {
      ...options,
      tenantKey,
      registryTable,
      logger
    });
    swept.push(tenantKey);
  }

  return Object.freeze(swept);
}
