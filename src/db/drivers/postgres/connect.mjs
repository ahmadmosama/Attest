import pg from "pg";

import { InfraError } from "../../../errors.mjs";

const { Client } = pg;

const POSTGRES_DEFAULT_PORT = 5432;
const APPLICATION_NAME = "attest";
const CONNECTION_TIMEOUT_MS = 2000;
const STATEMENT_TIMEOUT_MS = 5000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 5000;
const CONNECTION_URL_ENV_KEYS = Object.freeze(["ATTEST_DB_URL", "ATTEST_PG_URL"]);

/**
 * Postgres connection helpers for the observer side of a delta run.
 *
 * withFreshTransaction is intentionally short lived and always pins READ
 * COMMITTED. Polling inside a long lived REPEATABLE READ transaction can hold a
 * stale snapshot forever and make a committed application write look absent.
 * Do not add a helper that keeps one transaction open across polling attempts.
 */

function safeTargetDetails(target) {
  return Object.freeze({
    host: target?.host ?? null,
    database: target?.database ?? null,
    port: target?.port ?? null
  });
}

function assertResolvedPostgresTarget(target) {
  if (typeof target === "string") {
    throw new TypeError("createPgClient requires a resolved target, not a raw connection string");
  }

  if (
    target === null ||
    typeof target !== "object" ||
    !["postgres", "postgresql"].includes(target.driver) ||
    typeof target.host !== "string" ||
    target.host.length === 0 ||
    typeof target.port !== "number" ||
    typeof target.database !== "string" ||
    target.database.length === 0 ||
    typeof target.user !== "string"
  ) {
    throw new TypeError("createPgClient requires a resolved PostgreSQL target");
  }
}

function parseEnvUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function databaseName(parsed) {
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  return database.length > 0 ? database : null;
}

function parsedPort(parsed) {
  if (parsed.port === "") {
    return POSTGRES_DEFAULT_PORT;
  }

  const port = Number(parsed.port);
  return Number.isSafeInteger(port) ? port : null;
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
  for (const key of CONNECTION_URL_ENV_KEYS) {
    const parsed = parseEnvUrl(env?.[key]);
    if (parsed !== null && parsedMatchesTarget(parsed, target)) {
      return decodeURIComponent(parsed.password);
    }
  }

  return undefined;
}

function clientConfig(target, env) {
  const config = {
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    application_name: APPLICATION_NAME,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS
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

function unreachable(target) {
  return new InfraError(
    "E_DB_UNREACHABLE",
    `Database target ${target.host}/${target.database} is unreachable.`,
    safeTargetDetails(target)
  );
}

async function closeQuietly(client) {
  try {
    await client.end();
  } catch {
    // A failed connection can already be closed. Preserve the original error.
  }
}

async function pinSessionSettings(client) {
  await client.query("SET application_name TO 'attest'");
  await client.query(`SET statement_timeout TO '${STATEMENT_TIMEOUT_MS}ms'`);
  await client.query(
    `SET idle_in_transaction_session_timeout TO '${IDLE_IN_TRANSACTION_TIMEOUT_MS}ms'`
  );
}

export async function createPgClient(target, options = {}) {
  assertResolvedPostgresTarget(target);

  const ClientCtor = options.ClientCtor ?? Client;
  const env = options.env ?? process.env;
  const client = new ClientCtor(clientConfig(target, env));

  try {
    await client.connect();
    await pinSessionSettings(client);
    return client;
  } catch {
    await closeQuietly(client);
    throw unreachable(target);
  }
}

export async function withClient(target, fn, options = {}) {
  const client = await createPgClient(target, options);
  let released = false;

  try {
    return await fn(client);
  } catch (error) {
    released = true;
    try {
      await client.end();
    } catch {
      // Preserve the callback failure, which is the actionable error.
    }
    throw error;
  } finally {
    if (!released) {
      await client.end();
    }
  }
}

export async function withFreshTransaction(client, fn) {
  await client.query("BEGIN");

  try {
    await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure from the transaction body.
    }
    throw error;
  }
}
