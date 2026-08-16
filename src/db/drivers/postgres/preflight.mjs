import { InfraError } from "../../../errors.mjs";
import { withClient } from "./connect.mjs";
import { describePostgresCapabilities } from "./capabilities.mjs";

export const PREFLIGHT_CHECKS = Object.freeze([
  "primary_target",
  "wal_level",
  "replication_privilege",
  "slot_capacity",
  "replica_identity"
]);

const REPLICA_IDENTITY_FULL = "f";
const PASS = "pass";
const REFUSE = "refuse";
const DEGRADE = "degrade";

function safeTargetDetails(target) {
  return Object.freeze({
    host: target?.host ?? null,
    database: target?.database ?? null,
    port: target?.port ?? null
  });
}

function check(name, status, details = {}) {
  return Object.freeze({
    name,
    status,
    ...details
  });
}

function degradedEntry(reason, message, details = {}) {
  return Object.freeze({
    reason,
    message,
    ...details
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw new InfraError("E_DB_PREFLIGHT_ABORTED", "PostgreSQL preflight was aborted.", {
      reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "aborted")
    });
  }
}

async function queryOne(client, text, values = [], signal) {
  throwIfAborted(signal);
  const result = await client.query(text, values);
  throwIfAborted(signal);
  return result.rows[0] ?? {};
}

function tableDisplayName(entity) {
  return `${entity.schema}.${entity.table}`;
}

function normalizeEntity(entity) {
  if (typeof entity === "string") {
    const [schema, table, extra] = entity.split(".");
    if (extra !== undefined) {
      throw new TypeError(`Invalid PostgreSQL entity reference: ${entity}`);
    }

    return Object.freeze({
      schema: table === undefined ? "public" : schema,
      table: table === undefined ? schema : table
    });
  }

  if (entity !== null && typeof entity === "object") {
    const schema = entity.schema ?? "public";
    const table = entity.table ?? entity.tableName ?? entity.name;

    if (typeof schema === "string" && schema.length > 0 && typeof table === "string" && table.length > 0) {
      return Object.freeze({ schema, table });
    }
  }

  throw new TypeError("PostgreSQL entity references must name a schema and table");
}

function normalizeEntities(entities) {
  if (entities === undefined || entities === null) {
    return [];
  }

  if (!Array.isArray(entities)) {
    throw new TypeError("PostgreSQL preflight entities must be an array");
  }

  const seen = new Set();
  const normalized = [];

  for (const entity of entities) {
    const normalizedEntity = normalizeEntity(entity);
    const key = tableDisplayName(normalizedEntity);
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(normalizedEntity);
    }
  }

  return normalized;
}

function identityMode(relreplident) {
  return relreplident === REPLICA_IDENTITY_FULL ? "full" : "key_only";
}

async function probeOneReplicaIdentity(client, entity) {
  const row = await queryOne(
    client,
    `
      SELECT c.relreplident
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2
        AND c.relkind IN ('r', 'p')
    `,
    [entity.schema, entity.table]
  );
  const relreplident = row.relreplident ?? null;

  return Object.freeze({
    schema: entity.schema,
    table: entity.table,
    name: tableDisplayName(entity),
    relreplident,
    beforeImages: identityMode(relreplident)
  });
}

export async function probeReplicaIdentity(client, entities = []) {
  const normalized = normalizeEntities(entities);
  const identities = [];

  for (const entity of normalized) {
    identities.push(await probeOneReplicaIdentity(client, entity));
  }

  return Object.freeze(identities);
}

async function checkPrimary(client, target, findings, signal) {
  const row = await queryOne(client, "SELECT pg_is_in_recovery() AS in_recovery", [], signal);
  const inRecovery = row.in_recovery === true;

  findings.inRecovery = inRecovery;
  if (!inRecovery) {
    findings.checks.push(check("primary_target", PASS, { inRecovery }));
    return;
  }

  findings.checks.push(
    check("primary_target", REFUSE, {
      inRecovery,
      reason: "assertions must run against the primary"
    })
  );

  throw new InfraError(
    "E_DB_REPLICA_TARGET",
    "PostgreSQL database assertions must run against the primary, not a read replica.",
    {
      ...safeTargetDetails(target),
      checks: findings.checks
    }
  );
}

async function checkWalLevel(client, findings, signal) {
  const row = await queryOne(client, "SHOW wal_level", [], signal);
  const walLevel = row.wal_level;

  findings.walLevel = walLevel;
  if (walLevel === "logical") {
    findings.checks.push(check("wal_level", PASS, { walLevel }));
    return;
  }

  const degraded = degradedEntry(
    "wal_level",
    `wal_level is ${walLevel ?? "unknown"}, not logical; logical slot capture is unavailable.`,
    { walLevel }
  );
  findings.degraded.push(degraded);
  findings.checks.push(check("wal_level", DEGRADE, { walLevel, degraded: degraded.message }));
}

async function checkReplicationPrivilege(client, findings, signal) {
  const row = await queryOne(
    client,
    `
      SELECT rolreplication, rolsuper
      FROM pg_roles
      WHERE rolname = current_user
    `,
    [],
    signal
  );
  const rolreplication = row.rolreplication === true;
  const rolsuper = row.rolsuper === true;
  const allowed = rolreplication || rolsuper;

  findings.replicationPrivilege = Object.freeze({ rolreplication, rolsuper, allowed });
  if (allowed) {
    findings.checks.push(check("replication_privilege", PASS, { rolreplication, rolsuper }));
    return;
  }

  const degraded = degradedEntry(
    "replication_privilege",
    "current role lacks rolreplication and rolsuper; logical slot capture is unavailable.",
    { rolreplication, rolsuper }
  );
  findings.degraded.push(degraded);
  findings.checks.push(
    check("replication_privilege", DEGRADE, {
      rolreplication,
      rolsuper,
      degraded: degraded.message
    })
  );
}

async function checkSlotCapacity(client, target, findings, signal) {
  const row = await queryOne(
    client,
    `
      SELECT
        current_setting('max_replication_slots')::int AS maximum,
        count(*)::int AS used
      FROM pg_replication_slots
    `,
    [],
    signal
  );
  const used = Number(row.used);
  const maximum = Number(row.maximum);

  findings.slotCapacity = Object.freeze({ used, maximum });
  if (Number.isFinite(maximum) && maximum > used) {
    findings.checks.push(check("slot_capacity", PASS, { used, maximum }));
    return;
  }

  findings.checks.push(
    check("slot_capacity", REFUSE, {
      used,
      maximum,
      reason: "no logical replication slot capacity remains"
    })
  );

  throw new InfraError(
    "E_DB_SLOT_LIMIT",
    "PostgreSQL has no free logical replication slot capacity.",
    {
      ...safeTargetDetails(target),
      used,
      maximum,
      checks: findings.checks
    }
  );
}

async function checkReplicaIdentity(client, findings, entities, signal) {
  throwIfAborted(signal);
  const identities = await probeReplicaIdentity(client, entities);
  throwIfAborted(signal);
  const affected = identities.filter((entry) => entry.beforeImages !== "full");

  findings.replicaIdentity = identities;
  if (affected.length === 0) {
    findings.checks.push(check("replica_identity", PASS, { tables: identities.map((entry) => entry.name) }));
    return;
  }

  const tables = affected.map((entry) => entry.name);
  const degraded = degradedEntry(
    "replica_identity",
    `REPLICA IDENTITY FULL is missing on ${tables.join(", ")}; before images are key only.`,
    { tables }
  );
  findings.degraded.push(degraded);
  findings.checks.push(check("replica_identity", DEGRADE, { tables, degraded: degraded.message }));
}

function initialFindings(target) {
  return {
    target: safeTargetDetails(target),
    checks: [],
    degraded: [],
    inRecovery: null,
    walLevel: null,
    replicationPrivilege: null,
    slotCapacity: null,
    replicaIdentity: []
  };
}

async function runChecks(client, target, entities, signal) {
  const findings = initialFindings(target);

  await checkPrimary(client, target, findings, signal);
  await checkWalLevel(client, findings, signal);
  await checkReplicationPrivilege(client, findings, signal);
  await checkSlotCapacity(client, target, findings, signal);
  await checkReplicaIdentity(client, findings, entities, signal);

  const immutableFindings = Object.freeze({
    ...findings,
    checks: Object.freeze(findings.checks),
    degraded: Object.freeze(findings.degraded),
    replicaIdentity: Object.freeze(findings.replicaIdentity)
  });

  return Object.freeze({
    ok: true,
    findings: immutableFindings,
    checks: immutableFindings.checks,
    capabilities: describePostgresCapabilities(immutableFindings)
  });
}

export async function runPreflight({ target, entities = [], signal, client } = {}) {
  const normalizedEntities = normalizeEntities(entities);

  if (client !== undefined) {
    return runChecks(client, target, normalizedEntities, signal);
  }

  return withClient(target, (connectedClient) =>
    runChecks(connectedClient, target, normalizedEntities, signal)
  );
}
