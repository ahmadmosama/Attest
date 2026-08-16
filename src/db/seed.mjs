import { extname, isAbsolute, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

import { AttestError, InfraError } from "../errors.mjs";
import { canonicalRow, fingerprintRow } from "./normalize/canonical.mjs";

const DEFAULT_TENANT_COLUMN = "tenant_key";
const SEED_EXTENSIONS = Object.freeze([".seed.yaml", ".seed.yml", ".yaml", ".yml", ".json"]);
const NON_DETERMINISTIC_TOKEN = /^(?:\$(?:now|random|uuid)|\{\{\s*(?:now|random|uuid|date\.now|crypto\.randomuuid)\s*\}\})$/iu;
const UNSAFE_KEYS = Object.freeze(["sql", "query", "script", "execute", "raw"]);

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

function seedError(code, message, details = {}) {
  return new AttestError(code, message, details);
}

function invalidSeed(reason, details = {}) {
  return seedError("E_SEED_INVALID", "Seed declaration is invalid.", {
    reason,
    ...details
  });
}

function assertTenantKey(tenantKey) {
  if (typeof tenantKey !== "string" || tenantKey.length === 0) {
    throw new TypeError("tenantKey must be a non empty string");
  }
}

function normalizeEntityRef(entity) {
  if (typeof entity === "string") {
    const [schema, table, extra] = entity.split(".");
    if (extra !== undefined) {
      throw invalidSeed(`Invalid entity reference ${entity}`, { entity });
    }

    return {
      schema: table === undefined ? "public" : schema,
      table: table === undefined ? schema : table
    };
  }

  if (isPlainObject(entity)) {
    const schema = entity.schema ?? "public";
    const table = entity.table ?? entity.tableName ?? entity.name;
    if (typeof schema === "string" && schema.length > 0 && typeof table === "string" && table.length > 0) {
      return { schema, table };
    }
  }

  throw invalidSeed("Entity must name a schema and table");
}

function normalizeEntity(entry, index) {
  if (!isPlainObject(entry)) {
    throw invalidSeed("Seed entities must be objects", { index });
  }

  const entityRef = normalizeEntityRef(entry.entity ?? entry);
  const tenantColumn = entry.tenantColumn ?? DEFAULT_TENANT_COLUMN;
  if (typeof tenantColumn !== "string" || tenantColumn.length === 0) {
    throw invalidSeed("Seed entity tenantColumn must be a non empty string", {
      entity: `${entityRef.schema}.${entityRef.table}`
    });
  }
  if (!Array.isArray(entry.rows)) {
    throw invalidSeed("Seed entity rows must be an array", {
      entity: `${entityRef.schema}.${entityRef.table}`
    });
  }

  const rows = entry.rows.map((row, rowIndex) => {
    if (!isPlainObject(row)) {
      throw invalidSeed("Seed rows must be plain objects", {
        entity: `${entityRef.schema}.${entityRef.table}`,
        rowIndex
      });
    }
    return { ...row };
  });

  return deepFreeze({
    ...entityRef,
    entity: `${entityRef.schema}.${entityRef.table}`,
    tenantColumn,
    rows
  });
}

function normalizeSeedDocument(value, { name, file } = {}) {
  if (!isPlainObject(value)) {
    throw invalidSeed("Seed root must be an object", { seedName: name });
  }

  rejectUnsafeSeed(value, []);
  rejectNonDeterministic(value, []);

  const rawEntities = value.entities ?? value.tables;
  if (!Array.isArray(rawEntities) || rawEntities.length === 0) {
    throw invalidSeed("Seed must declare at least one entity", { seedName: name });
  }

  const seed = {
    name: value.name ?? name,
    file: file ?? null,
    entities: rawEntities.map((entity, index) => normalizeEntity(entity, index))
  };
  if (typeof seed.name !== "string" || seed.name.length === 0) {
    throw invalidSeed("Seed name must be a non empty string");
  }

  return deepFreeze({
    ...seed,
    digest: seedDigest(seed)
  });
}

function rejectUnsafeSeed(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectUnsafeSeed(item, [...path, index]));
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }

  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.includes(key.toLowerCase())) {
      throw seedError("E_SEED_UNSAFE", "Seeds must declare rows, not executable SQL or scripts.", {
        path: [...path, key]
      });
    }
    rejectUnsafeSeed(value[key], [...path, key]);
  }
}

function rejectNonDeterministic(value, path) {
  if (typeof value === "string") {
    if (NON_DETERMINISTIC_TOKEN.test(value.trim())) {
      throw seedError("E_SEED_NON_DETERMINISTIC", "Seed contains a non deterministic marker.", {
        path,
        marker: value
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectNonDeterministic(item, [...path, index]));
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (/^\$(?:now|random|uuid)$/iu.test(key)) {
      throw seedError("E_SEED_NON_DETERMINISTIC", "Seed contains a non deterministic marker.", {
        path: [...path, key],
        marker: key
      });
    }
    rejectNonDeterministic(child, [...path, key]);
  }
}

function scanUnsupportedYaml(node, path = []) {
  if (node === null || node === undefined) {
    return;
  }
  if (node.anchor !== undefined || isAlias(node)) {
    throw seedError("E_SEED_UNSAFE", "Seed YAML anchors and aliases are not supported.", {
      path
    });
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      const segment = isScalar(pair.key) ? String(pair.key.value) : String(pair.key?.toString?.() ?? "");
      scanUnsupportedYaml(pair.key, path);
      scanUnsupportedYaml(pair.value, [...path, segment]);
    }
    return;
  }
  if (isSeq(node)) {
    for (const [index, item] of node.items.entries()) {
      scanUnsupportedYaml(item, [...path, index]);
    }
  }
}

function parseSeedText(text, file) {
  if (extname(file).toLowerCase() === ".json") {
    return JSON.parse(text);
  }

  const doc = parseDocument(text, {
    uniqueKeys: true,
    merge: false
  });
  if (doc.errors.length > 0) {
    throw seedError("E_SEED_PARSE", "Seed YAML could not be parsed.", {
      file,
      reason: doc.errors[0].message
    });
  }
  scanUnsupportedYaml(doc.contents);
  return doc.toJS({ maxAliasCount: 0 });
}

function candidatePaths(dir, name) {
  const base = resolve(dir);
  const requested = resolve(base, name);
  const relativePath = relative(base, requested);

  if (isAbsolute(name) || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw seedError("E_SEED_NOT_FOUND", "Seed was not found.", {
      seedName: name,
      directory: dir
    });
  }

  if (extname(name) !== "") {
    return [requested];
  }

  return [requested, ...SEED_EXTENSIONS.map((extension) => resolve(base, `${name}${extension}`))];
}

async function readFirstSeed(candidates, readFileImpl) {
  let lastMissing = null;
  for (const candidate of candidates) {
    try {
      return {
        file: candidate,
        text: await readFileImpl(candidate, "utf8")
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        lastMissing = error;
        continue;
      }
      throw error;
    }
  }

  throw lastMissing ?? Object.assign(new Error("Seed was not found."), { code: "ENOENT" });
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

function entityName(entity) {
  return `${entity.schema}.${entity.table}`;
}

function replaceTenantTokens(value, tenantKey) {
  if (value === "$tenantKey") {
    return tenantKey;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceTenantTokens(item, tenantKey));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, replaceTenantTokens(child, tenantKey)])
    );
  }
  return value;
}

function tenantScopedRow(row, entity, tenantKey) {
  const replaced = replaceTenantTokens(row, tenantKey);
  if (Object.hasOwn(replaced, entity.tenantColumn) && replaced[entity.tenantColumn] !== tenantKey) {
    throw new InfraError("E_SEED_TENANT_SCOPE", "Seed row would be written outside the scenario tenant.", {
      entity: entityName(entity),
      tenantColumn: entity.tenantColumn,
      tenantKey
    });
  }

  return {
    ...replaced,
    [entity.tenantColumn]: tenantKey
  };
}

function digestRow(row, tenantColumn) {
  const withoutTenant = Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== tenantColumn)
  );
  return canonicalRow(withoutTenant);
}

function digestForRows(rows, tenantColumn) {
  return rows
    .map((row) => digestRow(row, tenantColumn))
    .toSorted((left, right) => fingerprintRow(left).localeCompare(fingerprintRow(right)));
}

function digestForEntity(entity) {
  return fingerprintRow({
    entity: entityName(entity),
    rows: digestForRows(entity.rows, entity.tenantColumn)
  });
}

function seedDigestPayload(seed) {
  const normalized = normalizeSeedInput(seed);
  return {
    name: normalized.name,
    entities: normalized.entities.map((entity) => ({
      entity: entityName(entity),
      tenantColumn: entity.tenantColumn,
      rows: digestForRows(entity.rows, entity.tenantColumn)
    }))
  };
}

function normalizeSeedInput(seed) {
  if (seed?.entities !== undefined && Array.isArray(seed.entities)) {
    return {
      name: seed.name ?? "seed",
      entities: seed.entities.map((entity, index) => normalizeEntity(entity, index))
    };
  }
  return normalizeSeedDocument(seed);
}

async function queryRows(client, text, values = []) {
  const result = await client.query(text, values);
  return Array.isArray(result?.rows) ? result.rows : [];
}

async function insertSeedRow(client, entity, row) {
  const entries = Object.entries(row);
  const columns = entries.map(([column]) => quoteIdent(column)).join(", ");
  const placeholders = entries.map((_, index) => `$${index + 1}`).join(", ");

  await queryRows(
    client,
    `INSERT INTO ${qualifiedName(entity)} (${columns}) VALUES (${placeholders})`,
    entries.map(([, value]) => value)
  );
}

function observedColumns(entity) {
  const columns = new Set([entity.tenantColumn]);
  for (const row of entity.rows) {
    for (const column of Object.keys(row)) {
      columns.add(column);
    }
  }
  return [...columns].toSorted((left, right) => left.localeCompare(right));
}

async function observedRowsFor(client, entity, tenantKey) {
  const columns = observedColumns(entity);
  const result = await queryRows(
    client,
    `
      SELECT ${columns.map(quoteIdent).join(", ")}
      FROM ${qualifiedName(entity)}
      WHERE ${quoteIdent(entity.tenantColumn)} = $1
    `,
    [tenantKey]
  );

  return result.map((row) => Object.fromEntries(
    columns.map((column) => [column, row[column]])
  ));
}

function mismatchError(entity, expectedRows, observedRows) {
  const expectedDigest = digestForEntity({ ...entity, rows: expectedRows });
  const observedDigest = digestForEntity({ ...entity, rows: observedRows });
  return seedError("E_SEED_DIGEST_MISMATCH", "Observed pre state does not match the declared seed digest.", {
    entity: entityName(entity),
    expectedDigest,
    observedDigest,
    expectedRows: expectedRows.length,
    observedRows: observedRows.length
  });
}

export async function loadSeed({ dir, name, readFileImpl = readFile } = {}) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new TypeError("loadSeed requires a seed directory");
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("loadSeed requires a seed name");
  }

  const candidates = candidatePaths(dir, name);
  let loaded;
  try {
    loaded = await readFirstSeed(candidates, readFileImpl);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw seedError("E_SEED_NOT_FOUND", "Seed was not found.", {
        seedName: name,
        directory: dir
      });
    }
    throw error;
  }

  return normalizeSeedDocument(parseSeedText(loaded.text, loaded.file), {
    name,
    file: loaded.file
  });
}

export function seedDigest(seed) {
  return fingerprintRow(seedDigestPayload(seed));
}

export async function applySeed(client, seed, { tenantKey } = {}) {
  if (client === null || typeof client !== "object" || typeof client.query !== "function") {
    throw new TypeError("applySeed requires a PostgreSQL client");
  }
  assertTenantKey(tenantKey);

  const normalized = normalizeSeedInput(seed);
  let insertedRows = 0;

  await queryRows(client, "BEGIN");
  try {
    for (const entity of normalized.entities) {
      for (const row of entity.rows) {
        await insertSeedRow(client, entity, tenantScopedRow(row, entity, tenantKey));
        insertedRows += 1;
      }
    }
    await queryRows(client, "COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the seed failure, not a cleanup side effect.
    }
    if (error instanceof InfraError) {
      throw error;
    }
    throw new InfraError("E_SEED_APPLY", "Failed to apply declared seed.", {
      seedName: normalized.name,
      causeCode: error?.code ?? null,
      causeMessage: error instanceof Error ? error.message : String(error)
    });
  }

  return deepFreeze({
    seedName: normalized.name,
    digest: seedDigest(normalized),
    tenantKey,
    insertedRows
  });
}

export async function assertPreState(client, seed, { tenantKey } = {}) {
  if (client === null || typeof client !== "object" || typeof client.query !== "function") {
    throw new TypeError("assertPreState requires a PostgreSQL client");
  }
  assertTenantKey(tenantKey);

  const normalized = normalizeSeedInput(seed);
  for (const entity of normalized.entities) {
    const expectedRows = entity.rows.map((row) => tenantScopedRow(row, entity, tenantKey));
    const observedRows = await observedRowsFor(client, entity, tenantKey);
    const expectedDigest = fingerprintRow({
      entity: entityName(entity),
      rows: digestForRows(expectedRows, entity.tenantColumn)
    });
    const observedDigest = fingerprintRow({
      entity: entityName(entity),
      rows: digestForRows(observedRows, entity.tenantColumn)
    });

    if (expectedDigest !== observedDigest) {
      throw mismatchError(entity, expectedRows, observedRows);
    }
  }

  return deepFreeze({
    ok: true,
    seedName: normalized.name,
    digest: seedDigest(normalized)
  });
}
