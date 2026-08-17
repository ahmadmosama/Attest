import pg from "pg";

import { resolveTarget } from "../../src/config/targets.mjs";

const { Client } = pg;
const CONNECTION_TIMEOUT_MS = 1500;
const POSTGRES_SLOT_LOCK_KEY = "4155564122367263";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizeReason(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  return error.message.replace(/postgres(?:ql)?:\/\/[^@\s]+@/giu, "postgres://<redacted>@");
}

function defaultPort(parsed) {
  return parsed.port === "" ? 5432 : Number(parsed.port);
}

function databaseName(parsed) {
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  return database.length > 0 ? database : null;
}

function allowlistFor(url) {
  const parsed = new URL(url);

  return Object.freeze([
    Object.freeze({
      host: parsed.hostname.toLowerCase(),
      database: databaseName(parsed),
      nonProd: true,
      note: "Postgres integration test target from ATTEST_PG_URL"
    })
  ]);
}

export function postgresUrl(env = process.env) {
  return nonEmptyString(env.ATTEST_PG_URL) ? env.ATTEST_PG_URL : null;
}

export async function probePostgres(url) {
  if (!nonEmptyString(url)) {
    return Object.freeze({
      ok: false,
      reason: "ATTEST_PG_URL is unset"
    });
  }

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS
  });

  try {
    await client.connect();
    await client.query("SELECT 1");
    return Object.freeze({ ok: true, reason: null });
  } catch (error) {
    return Object.freeze({
      ok: false,
      reason: sanitizeReason(error)
    });
  } finally {
    try {
      await client.end();
    } catch {
      // The probe may fail before a socket exists.
    }
  }
}

export async function skipUnlessPostgres(t, env = process.env) {
  const url = postgresUrl(env);
  if (url === null) {
    t.skip("Postgres tests skipped: ATTEST_PG_URL is unset.");
    return null;
  }

  const probe = await probePostgres(url);
  if (!probe.ok) {
    t.skip(`Postgres tests skipped: database unreachable: ${probe.reason}`);
    return null;
  }

  const parsed = new URL(url);
  const allowlist = allowlistFor(url);
  const target = resolveTarget({ url, allowlist });

  return Object.freeze({
    url,
    target,
    allowlist,
    hostPort: defaultPort(parsed)
  });
}

export async function withPostgresSlotLock(live, fn) {
  if (!nonEmptyString(live?.url)) {
    return fn();
  }

  const client = new Client({
    connectionString: live.url,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS
  });
  let locked = false;

  try {
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1::bigint)", [POSTGRES_SLOT_LOCK_KEY]);
    locked = true;
    return await fn();
  } finally {
    try {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [POSTGRES_SLOT_LOCK_KEY]);
      }
    } finally {
      await client.end().catch(() => {});
    }
  }
}
