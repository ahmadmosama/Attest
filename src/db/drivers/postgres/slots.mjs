import { createHash } from "node:crypto";

import { InfraError } from "../../../errors.mjs";
import { cleanup } from "../../../runtime/cleanup.mjs";
import { createPgClient } from "./connect.mjs";

const SLOT_PREFIX = "attest_";
const SLOT_IDENTIFIER_LIMIT = 63;
const RUN_SEGMENT_LIMIT = 24;
const HASH_SEGMENT_LENGTH = 24;
const DUPLICATE_OBJECT = "42710";
const UNDEFINED_OBJECT = "42704";
const openSlots = new Map();

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeSlotDetails(slotName, extra = {}) {
  return Object.freeze({
    slotName,
    ...extra
  });
}

function throwIfAborted(signal, code, message, details = {}) {
  if (signal?.aborted === true) {
    throw new InfraError(code, message, {
      ...details,
      reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "aborted")
    });
  }
}

function sanitizeSegment(value) {
  const raw = String(value ?? "").toLowerCase();
  const normalized = raw.replace(/[^a-z0-9_]/gu, "_").replace(/_+/gu, "_").replace(/^_+|_+$/gu, "");
  return normalized.length > 0 ? normalized : "run";
}

function hashSegment(input, length = HASH_SEGMENT_LENGTH) {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}

function assertSlotName(slotName) {
  if (typeof slotName !== "string" || !/^attest_[a-z0-9_]+$/u.test(slotName)) {
    throw new TypeError("PostgreSQL Attest slot names must start with attest_ and contain only lowercase letters, digits, and underscores");
  }

  if (Buffer.byteLength(slotName, "utf8") > SLOT_IDENTIFIER_LIMIT) {
    throw new TypeError("PostgreSQL Attest slot names must not exceed 63 bytes");
  }
}

function warningForExistingSlot(slotName) {
  return Object.freeze({
    code: "W_DB_SLOT_ORPHAN_RECREATED",
    slotName,
    message: "Existing Attest replication slot was dropped and recreated before capture."
  });
}

async function slotState(client, slotName, signal) {
  const rows = await queryRows(
    client,
    "SELECT slot_name, active FROM pg_replication_slots WHERE slot_name = $1",
    [slotName],
    signal,
    "E_DB_SLOT_CREATE_ABORTED",
    "PostgreSQL logical replication slot creation was aborted.",
    { slotName }
  );

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  return Object.freeze({
    slotName: String(row.slot_name ?? row.slotName ?? slotName),
    active: row.active === true
  });
}

function isDuplicateSlotError(error) {
  return error?.code === DUPLICATE_OBJECT || /already exists/iu.test(String(error?.message ?? ""));
}

function isMissingSlotError(error) {
  return error?.code === UNDEFINED_OBJECT || /does not exist/iu.test(String(error?.message ?? ""));
}

function slotCreateError(slotName, error, details = {}) {
  return new InfraError("E_DB_SLOT_CREATE", "Failed to create PostgreSQL logical replication slot.", {
    ...safeSlotDetails(slotName, details),
    causeCode: error?.code ?? null,
    causeMessage: error instanceof Error ? error.message : String(error)
  });
}

function slotDropError(slotName, error, attempts) {
  return new InfraError("E_DB_SLOT_DROP", "Failed to drop PostgreSQL logical replication slot.", {
    ...safeSlotDetails(slotName, {
      attempts,
      severity: "infra_error"
    }),
    causeCode: error?.code ?? null,
    causeMessage: error instanceof Error ? error.message : String(error)
  });
}

async function queryRows(client, text, values, signal, abortCode, abortMessage, details = {}) {
  throwIfAborted(signal, abortCode, abortMessage, details);
  const result = await client.query(text, values);
  throwIfAborted(signal, abortCode, abortMessage, details);
  return Array.isArray(result?.rows) ? result.rows : [];
}

function registerOpenSlot(client, slotName) {
  // Registered with the ONE process-wide registry, not with a second set of
  // signal handlers of this module's own. This module used to install its own
  // SIGINT/SIGTERM handlers ending in process.exit, and so did the tenancy
  // layer; whichever settled first killed the other's in-flight cleanup, so a
  // Ctrl-C during a run holding both a slot and a tenant reliably leaked one.
  const handle = cleanup.register(`pg-slot:${slotName}`, async (reason) => {
    await dropSlot(client, slotName, { reason });
  });

  openSlots.set(slotName, { client, slotName, handle });
}

function unregisterOpenSlot(slotName) {
  // Released rather than disposed: the caller is dropping the slot right now on
  // the normal path, so the registry should stop tracking it, not drop it twice.
  openSlots.get(slotName)?.handle?.release();
  openSlots.delete(slotName);
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

function logSweep(logger, action, slotName, details = {}) {
  const entry = Object.freeze({
    action,
    slotName,
    ...details
  });

  if (typeof logger === "function") {
    logger(entry);
    return;
  }

  if (logger !== null && logger !== false) {
    console.warn(`[attest:postgres:slots] ${action} ${slotName}`);
  }
}

function normalizeSlotRow(row) {
  return Object.freeze({
    slotName: String(row.slot_name ?? row.slotName ?? ""),
    active: row.active === true
  });
}

async function closeClient(client) {
  try {
    await client.end();
  } catch {
    // Preserve the slot lifecycle error that caused this cleanup path.
  }
}

/**
 * Build a deterministic, legal logical replication slot name for one scenario.
 *
 * The slot is deliberately derived from the run id, scenario id, and surface
 * but constrained to a short sanitized run segment plus a hash. PostgreSQL
 * identifiers are limited to 63 bytes, and slot creation is the wrong place to
 * discover an unchecked scenario id.
 */
/**
 * Every slot this process currently holds.
 *
 * Exists so the orphan sweep can be told what NOT to drop. The sweep's job is
 * to reclaim slots left behind by a killed run, and "left behind by a killed
 * run" and "held right now by the scenario next door" look identical from SQL
 * when the sibling is momentarily inactive.
 */
export function openSlotNames() {
  return Object.freeze(Array.from(openSlots.keys()));
}

export function slotNameFor({ runId, scenarioId, surface = "db" } = {}) {
  const runSegment = sanitizeSegment(runId).slice(0, RUN_SEGMENT_LIMIT);
  const hash = hashSegment(`${String(runId ?? "")}\0${String(scenarioId ?? "")}\0${String(surface ?? "")}`);
  const name = `${SLOT_PREFIX}${runSegment}_${hash}`;

  if (Buffer.byteLength(name, "utf8") <= SLOT_IDENTIFIER_LIMIT) {
    return name;
  }

  const budget = SLOT_IDENTIFIER_LIMIT - SLOT_PREFIX.length - 1 - HASH_SEGMENT_LENGTH;
  return `${SLOT_PREFIX}${runSegment.slice(0, budget)}_${hash}`;
}

export async function createSlot(client, slotName, options = {}) {
  assertSlotName(slotName);

  const warnings = [];
  const signal = options.signal;

  try {
    await queryRows(
      client,
      "SELECT pg_create_logical_replication_slot($1, 'test_decoding')",
      [slotName],
      signal,
      "E_DB_SLOT_CREATE_ABORTED",
      "PostgreSQL logical replication slot creation was aborted.",
      { slotName }
    );
  } catch (error) {
    if (!isDuplicateSlotError(error)) {
      throw slotCreateError(slotName, error);
    }

    warnings.push(warningForExistingSlot(slotName));
    try {
      const existing = await slotState(client, slotName, signal);
      if (existing?.active === true) {
        throw slotCreateError(slotName, error, { reason: "existing_slot_active" });
      }

      await dropSlot(client, slotName, { signal });
      await queryRows(
        client,
        "SELECT pg_create_logical_replication_slot($1, 'test_decoding')",
        [slotName],
        signal,
        "E_DB_SLOT_CREATE_ABORTED",
        "PostgreSQL logical replication slot creation was aborted.",
        { slotName }
      );
    } catch (recreateError) {
      if (
        recreateError instanceof InfraError &&
        (recreateError.code === "E_DB_SLOT_DROP" || recreateError.code === "E_DB_SLOT_CREATE")
      ) {
        throw recreateError;
      }
      throw slotCreateError(slotName, recreateError, { phase: "recreate_existing" });
    }
  }

  registerOpenSlot(client, slotName);
  return Object.freeze({
    slotName,
    warnings: Object.freeze(warnings)
  });
}

export async function drainSlot(client, slotName, options = {}) {
  assertSlotName(slotName);

  const batchSize = Number.isSafeInteger(options.batchSize) && options.batchSize > 0 ? options.batchSize : null;
  const rows = await queryRows(
    client,
    "SELECT lsn::text AS lsn, xid::text AS xid, data FROM pg_logical_slot_get_changes($1, NULL, $2)",
    [slotName, batchSize],
    options.signal,
    "E_DB_SLOT_DRAIN_ABORTED",
    "PostgreSQL logical replication slot drain was aborted.",
    { slotName }
  );

  return Object.freeze({
    rows: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
    more: batchSize !== null && rows.length >= batchSize
  });
}

export async function dropSlot(client, slotName, options = {}) {
  assertSlotName(slotName);

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await queryRows(
        client,
        "SELECT pg_drop_replication_slot($1)",
        [slotName],
        options.signal,
        "E_DB_SLOT_DROP_ABORTED",
        "PostgreSQL logical replication slot drop was aborted.",
        { slotName }
      );
      unregisterOpenSlot(slotName);
      return Object.freeze({
        slotName,
        dropped: true,
        attempts: attempt
      });
    } catch (error) {
      if (isMissingSlotError(error)) {
        unregisterOpenSlot(slotName);
        return Object.freeze({
          slotName,
          dropped: false,
          missing: true,
          attempts: attempt
        });
      }

      lastError = error;
    }
  }

  throw slotDropError(slotName, lastError, 2);
}

export async function sweepOrphanSlots(client, options = {}) {
  const keep = normalizeKeep(options.keep);
  const logger = Object.hasOwn(options, "logger") ? options.logger : console.warn;
  const rows = await queryRows(
    client,
    "SELECT slot_name, active FROM pg_replication_slots WHERE slot_name LIKE 'attest\\_%' ESCAPE '\\'",
    [],
    options.signal,
    "E_DB_SLOT_SWEEP_ABORTED",
    "PostgreSQL orphan slot sweep was aborted."
  );

  const dropped = [];
  for (const row of rows.map(normalizeSlotRow)) {
    if (!row.slotName.startsWith(SLOT_PREFIX)) {
      logSweep(logger, "skip_non_attest", row.slotName);
      continue;
    }

    if (keep.has(row.slotName)) {
      logSweep(logger, "skip_keep", row.slotName);
      continue;
    }

    if (row.active) {
      logSweep(logger, "skip_active", row.slotName);
      continue;
    }

    logSweep(logger, "drop_orphan", row.slotName);
    await dropSlot(client, row.slotName, { signal: options.signal });
    dropped.push(row.slotName);
  }

  return Object.freeze(dropped);
}

export async function withSlot(target, slotName, fn, options = {}) {
  if (typeof fn !== "function") {
    throw new TypeError("withSlot requires a callback");
  }

  const client = isPlainObject(options) && options.client !== undefined
    ? options.client
    : await createPgClient(target, options);
  const ownsClient = !(isPlainObject(options) && options.client !== undefined);
  let created = false;
  let bodyResult;
  let bodyError;

  try {
    await createSlot(client, slotName, { signal: options.signal });
    created = true;
    bodyResult = await fn({
      client,
      slotName,
      signal: options.signal
    });
  } catch (error) {
    bodyError = error;
  } finally {
    if (created) {
      await dropSlot(client, slotName);
    }

    if (ownsClient) {
      await closeClient(client);
    }
  }

  if (bodyError !== undefined) {
    throw bodyError;
  }

  return bodyResult;
}
