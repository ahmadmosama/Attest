import { UsageError } from "../errors.mjs";

export const TARGET_REFUSALS = Object.freeze([
  "E_DB_TARGET_INVALID",
  "E_DB_TARGET_UNSUPPORTED",
  "E_DB_POOLER_PORT",
  "E_DB_TARGET_NOT_ALLOWLISTED",
  "E_DB_TARGET_NOT_MARKED"
]);

const POSTGRES_DEFAULT_PORT = 5432;
const SUPABASE_TRANSACTION_POOLER_PORT = 6543;

// One scheme table for every engine. A driver name is normalised here and
// nowhere else, so `postgresql://` and `postgres://` cannot end up as two
// different drivers downstream, and neither can `mongodb+srv://`.
const DRIVER_FOR_PROTOCOL = Object.freeze({
  "postgres:": "postgres",
  "postgresql:": "postgres",
  "mysql:": "mysql",
  "mongodb:": "mongo",
  "mongodb+srv:": "mongo",
  "sqlite:": "sqlite",
  "file:": "sqlite",
  "bigquery:": "bigquery"
});

export const SUPPORTED_DRIVERS = Object.freeze(["postgres", "mysql", "mongo", "sqlite", "bigquery"]);

const DEFAULT_PORT = Object.freeze({
  postgres: POSTGRES_DEFAULT_PORT,
  mysql: 3306,
  mongo: 27017
});

// SQLite has no host and BigQuery has no port, so each gets a synthetic host
// that the allowlist can match on. The point of DB-09 is that every target is
// named in a file somebody reviewed, and a local file path is a target like
// any other: pointing a run at a production sqlite file is exactly as bad as
// pointing it at a production Postgres.
const SQLITE_HOST = "file";

function freezeTarget(fields, urlString) {
  return Object.freeze({
    ...fields,
    raw() {
      return urlString;
    }
  });
}

function emptyDetails() {
  return Object.freeze({
    host: null,
    database: null,
    port: null
  });
}

function detailsFor(target) {
  return Object.freeze({
    host: target?.host ?? null,
    database: target?.database ?? null,
    port: target?.port ?? null
  });
}

function refusal(code, message, target) {
  throw new UsageError(code, message, detailsFor(target));
}

function invalidTarget() {
  throw new UsageError(
    "E_DB_TARGET_INVALID",
    "Database target URL is invalid. Set ATTEST_DB_URL to a valid database URL.",
    emptyDetails()
  );
}

function parsePort(parsed, driver) {
  if (parsed.port === "") {
    // mongodb+srv carries no port: the seedlist and its ports come from DNS
    // SRV records, so defaulting to 27017 would be a fact nobody stated.
    return parsed.protocol === "mongodb+srv:" ? null : DEFAULT_PORT[driver] ?? null;
  }

  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    invalidTarget();
  }
  return port;
}

function databaseName(parsed) {
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  return database.length > 0 ? database : null;
}

function driverName(parsed) {
  return DRIVER_FOR_PROTOCOL[parsed.protocol] ?? parsed.protocol.replace(/:$/u, "");
}

// The path is kept as written rather than resolved against the current working
// directory, so an allowlist entry stays portable between machines and CI. The
// driver resolves it when it opens the file.
function sqlitePath(parsed, urlString) {
  const raw = decodeURIComponent(`${parsed.pathname}`);
  const withoutScheme = urlString.replace(/^(?:sqlite|file):(?:\/\/)?/iu, "");
  const chosen = raw.length > 0 && raw !== "/" ? raw : withoutScheme;
  const normalized = chosen.replaceAll("\\", "/").replace(/^\/(?=[A-Za-z]:)/u, "");

  return normalized.length > 0 ? normalized : null;
}

function fieldsFor(parsed, urlString) {
  const driver = driverName(parsed);

  if (driver === "sqlite") {
    return {
      driver,
      host: SQLITE_HOST,
      port: null,
      database: sqlitePath(parsed, urlString),
      user: ""
    };
  }

  if (driver === "bigquery") {
    // bigquery://project/dataset. The project is the host so the allowlist
    // reads naturally, and there is never a credential in the URL.
    return {
      driver,
      host: normalizeHost(parsed.hostname),
      port: null,
      database: databaseName(parsed),
      user: ""
    };
  }

  return {
    driver,
    host: normalizeHost(parsed.hostname),
    port: parsePort(parsed, driver),
    database: databaseName(parsed),
    user: decodeURIComponent(parsed.username)
  };
}

function normalizeHost(host) {
  return typeof host === "string" ? host.toLowerCase() : "";
}

function normalizeDatabase(database) {
  return typeof database === "string" ? database : "";
}

function hasWildcard(value) {
  return typeof value === "string" && /[*?]/u.test(value);
}

function allowlistEntryMatches(entry, target) {
  if (hasWildcard(entry?.host) || hasWildcard(entry?.database)) {
    return false;
  }

  return (
    normalizeHost(entry?.host) === normalizeHost(target.host) &&
    normalizeDatabase(entry?.database) === normalizeDatabase(target.database)
  );
}

function matchingAllowlistEntry(allowlist, target) {
  if (!Array.isArray(allowlist)) {
    return null;
  }

  return allowlist.find((entry) => allowlistEntryMatches(entry, target)) ?? null;
}

function assertSupported(target) {
  if (!SUPPORTED_DRIVERS.includes(target.driver)) {
    refusal(
      `E_DB_TARGET_UNSUPPORTED`,
      `Database target scheme is not one of the supported engines: ${SUPPORTED_DRIVERS.join(", ")}.`,
      target
    );
  }
}

// Postgres only. pgbouncer transaction mode breaks temp tables, advisory locks,
// LISTEN and session scoped settings, all of which the capture layer needs.
function assertSessionPort(target) {
  if (target.driver !== "postgres") {
    return;
  }

  if (target.port === SUPABASE_TRANSACTION_POOLER_PORT) {
    refusal(
      "E_DB_POOLER_PORT",
      "Database target uses the Supabase transaction pooler on port 6543. Use the direct session connection on port 5432.",
      target
    );
  }
}

function assertAllowlisted(target, allowlist) {
  const entry = matchingAllowlistEntry(allowlist, target);
  if (entry === null) {
    refusal(
      "E_DB_TARGET_NOT_ALLOWLISTED",
      `Database target ${describeTarget(target)} is not on the explicit allowlist.`,
      target
    );
  }
  return entry;
}

function assertNonProductionMarker(target, entry) {
  if (entry.nonProd !== true) {
    refusal(
      "E_DB_TARGET_NOT_MARKED",
      `Database target ${describeTarget(target)} is allowlisted but is not marked non production.`,
      target
    );
  }
}

export function parseTarget(urlString) {
  if (typeof urlString !== "string" || urlString.trim().length === 0) {
    invalidTarget();
  }

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    invalidTarget();
  }

  const target = freezeTarget(fieldsFor(parsed, urlString), urlString);

  if (target.host.length === 0 || target.database === null) {
    invalidTarget();
  }

  return target;
}

export function describeTarget(target) {
  const host = target?.host ?? "";
  const database = target?.database ?? "";
  return `${host}/${database}`;
}

export function resolveTarget({ url, allowlist }) {
  const target = parseTarget(url);
  assertSupported(target);
  assertSessionPort(target);
  const entry = assertAllowlisted(target, allowlist);
  assertNonProductionMarker(target, entry);
  return target;
}
