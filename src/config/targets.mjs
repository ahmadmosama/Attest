import { UsageError } from "../errors.mjs";

export const TARGET_REFUSALS = Object.freeze([
  "E_DB_TARGET_INVALID",
  "E_DB_TARGET_UNSUPPORTED",
  "E_DB_POOLER_PORT",
  "E_DB_TARGET_NOT_ALLOWLISTED",
  "E_DB_TARGET_NOT_MARKED"
]);

const POSTGRES_PROTOCOLS = Object.freeze(new Set(["postgres:", "postgresql:"]));
const POSTGRES_DEFAULT_PORT = 5432;
const SUPABASE_TRANSACTION_POOLER_PORT = 6543;

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

function parsePort(parsed) {
  if (parsed.port === "") {
    return POSTGRES_PROTOCOLS.has(parsed.protocol) ? POSTGRES_DEFAULT_PORT : null;
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
  return parsed.protocol.replace(/:$/u, "");
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
  if (!POSTGRES_PROTOCOLS.has(`${target.driver}:`)) {
    refusal(
      "E_DB_TARGET_UNSUPPORTED",
      "Only PostgreSQL database targets are supported in Phase 3. Other database drivers are planned for Phase 6.",
      target
    );
  }
}

function assertSessionPort(target) {
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

  const target = freezeTarget(
    {
      driver: driverName(parsed),
      host: normalizeHost(parsed.hostname),
      port: parsePort(parsed),
      database: databaseName(parsed),
      user: decodeURIComponent(parsed.username)
    },
    urlString
  );

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
