import { randomUUID } from "node:crypto";

import { AttestError, InfraError } from "../../../errors.mjs";
import { converge, quietPeriod } from "../../../runtime/converge.mjs";
import { withFreshTransaction } from "./connect.mjs";
import {
  ensureWatermarkTable,
  sliceWindow,
  writeMarker
} from "../../watermark.mjs";

const DEFAULT_CONVERGE_TIMEOUT_MS = 10000;
const DEFAULT_CONVERGE_INTERVAL_MS = 50;
const DEFAULT_QUIET_PERIOD_MS = 750;
const QUIET_CAP_MULTIPLIER = 4;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClient(client, name) {
  if (client === null || typeof client !== "object" || typeof client.query !== "function") {
    throw new TypeError(`${name} requires a connected Postgres client`);
  }
}

function assertCapture(capture) {
  if (capture === null || typeof capture !== "object" || typeof capture.drain !== "function") {
    throw new TypeError("Postgres window requires a logical slot capture strategy");
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non empty string`);
  }
}

function assertSafeInteger(value, field) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
}

function assertSignal(signal, field) {
  if (signal !== undefined && (signal === null || typeof signal.aborted !== "boolean")) {
    throw new TypeError(`${field} must be an AbortSignal`);
  }
}

function throwIfAborted(signal, code, message) {
  if (signal?.aborted === true) {
    throw new InfraError(code, message, {
      reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "aborted")
    });
  }
}

function positiveMs(value, fallback, field) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${field} must be a non negative safe integer`);
  }
  return resolved;
}

function quietCapMs(op, quietMs) {
  const configured = op?.quietPeriodCapMs;
  if (configured !== undefined && configured !== null) {
    return positiveMs(configured, configured, "quietPeriodCapMs");
  }

  return quietMs * QUIET_CAP_MULTIPLIER;
}

function normalizeOpenInput(input) {
  if (!isPlainObject(input)) {
    throw new TypeError("openPostgresWindow requires an input object");
  }

  assertClient(input.client, "openPostgresWindow");
  assertCapture(input.capture);
  assertNonEmptyString(input.runId, "runId");
  assertNonEmptyString(input.scenarioId, "scenarioId");
  assertNonEmptyString(input.surface, "surface");
  assertSafeInteger(input.seq, "seq");
  assertSignal(input.signal, "signal");

  return Object.freeze({
    client: input.client,
    capture: input.capture,
    runId: input.runId,
    scenarioId: input.scenarioId,
    surface: input.surface,
    seq: input.seq,
    signal: input.signal,
    nonce: input.nonce ?? randomUUID()
  });
}

function normalizeCloseInput(input) {
  if (!isPlainObject(input)) {
    throw new TypeError("closePostgresWindow requires an input object");
  }

  assertClient(input.client, "closePostgresWindow");
  assertCapture(input.capture ?? input.window?.capture);
  if (
    input.pollClient === undefined &&
    typeof input.createPollClient !== "function"
  ) {
    throw new TypeError("closePostgresWindow requires createPollClient when pollClient is absent");
  }
  assertNonEmptyString(input.runId, "runId");
  assertNonEmptyString(input.scenarioId, "scenarioId");
  assertNonEmptyString(input.surface, "surface");
  assertSafeInteger(input.seq, "seq");
  assertNonEmptyString(input.nonce, "nonce");
  assertSignal(input.signal, "signal");

  return Object.freeze({
    client: input.client,
    capture: input.capture ?? input.window.capture,
    pollClient: input.pollClient,
    createPollClient: input.createPollClient,
    runId: input.runId,
    scenarioId: input.scenarioId,
    surface: input.surface,
    seq: input.seq,
    nonce: input.nonce,
    expect: Array.isArray(input.expect) ? input.expect : [],
    convergeTimeoutMs: positiveMs(
      input.convergeTimeoutMs,
      DEFAULT_CONVERGE_TIMEOUT_MS,
      "convergeTimeoutMs"
    ),
    convergeIntervalMs: positiveMs(
      input.convergeIntervalMs,
      DEFAULT_CONVERGE_INTERVAL_MS,
      "convergeIntervalMs"
    ),
    quietPeriodMs: positiveMs(input.quietPeriodMs, DEFAULT_QUIET_PERIOD_MS, "quietPeriodMs"),
    quietPeriodCapMs: quietCapMs(input, positiveMs(input.quietPeriodMs, DEFAULT_QUIET_PERIOD_MS, "quietPeriodMs")),
    signal: input.signal,
    now: input.now ?? Date.now
  });
}

function assertIdentifier(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new AttestError("E_DB_EXPECTATION_UNQUERYABLE", "Mutation expectation cannot be queried safely.", {
      field,
      value
    });
  }
}

function quoteIdentifier(value) {
  assertIdentifier(value, "identifier");
  return `"${value.replaceAll('"', '""')}"`;
}

function entityParts(entity) {
  assertNonEmptyString(entity, "mutation.entity");
  const parts = entity.includes(".") ? entity.split(".") : ["public", entity];

  if (parts.length !== 2) {
    throw new AttestError("E_DB_EXPECTATION_UNQUERYABLE", "Mutation entity must be table or schema.table.", {
      entity
    });
  }

  for (const [index, part] of parts.entries()) {
    assertIdentifier(part, `mutation.entity[${index}]`);
  }

  return Object.freeze(parts);
}

function tableSql(entity) {
  const [schema, table] = entityParts(entity);
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function whereSql(where) {
  if (!isPlainObject(where) || Object.keys(where).length === 0) {
    return null;
  }

  const values = [];
  const clauses = Object.entries(where).map(([column, value]) => {
    assertIdentifier(column, "mutation.where");
    values.push(value);
    return `${quoteIdentifier(column)} IS NOT DISTINCT FROM $${values.length}`;
  });

  return Object.freeze({
    text: `WHERE ${clauses.join(" AND ")}`,
    values: Object.freeze(values)
  });
}

async function countRows(client, mutation) {
  const where = whereSql(mutation.where);
  if (where === null) {
    return null;
  }

  const result = await client.query(
    `SELECT COUNT(*)::integer AS count FROM ${tableSql(mutation.entity)} ${where.text}`,
    where.values
  );
  return Number(result.rows?.[0]?.count ?? 0);
}

function expectedCount(mutation) {
  return Number.isSafeInteger(mutation.count) && mutation.count > 0 ? mutation.count : 1;
}

function visibleEnough(mutation, count) {
  if (count === null) {
    return true;
  }

  if (mutation.op === "delete") {
    return count === 0;
  }

  return count >= expectedCount(mutation);
}

async function expectationsVisible(client, expectations, signal) {
  const observations = [];

  for (const [index, mutation] of expectations.entries()) {
    throwIfAborted(signal, "E_DB_CONVERGE_ABORTED", "PostgreSQL convergence was aborted.");
    const count = await countRows(client, mutation);
    throwIfAborted(signal, "E_DB_CONVERGE_ABORTED", "PostgreSQL convergence was aborted.");

    observations.push(
      Object.freeze({
        index,
        entity: mutation.entity,
        op: mutation.op,
        count,
        expected: expectedCount(mutation),
        observable: count !== null,
        ok: visibleEnough(mutation, count)
      })
    );
  }

  return Object.freeze({
    ok: observations.every((entry) => entry.ok),
    value: Object.freeze({ observations: Object.freeze(observations) })
  });
}

function mergeTransactions(target, transactions) {
  for (const [txId, seqs] of Object.entries(transactions ?? {})) {
    target[txId] ??= [];
    target[txId].push(...seqs);
  }
}

async function drainCapture(capture, sink, signal) {
  const result = await capture.drain({ signal });
  sink.events.push(...result.events);
  mergeTransactions(sink.transactions, result.transactions);
  sink.warnings.push(...(result.warnings ?? []));
  return result;
}

async function drainUntilExhausted(capture, sink, signal) {
  while (true) {
    throwIfAborted(signal, "E_DB_DRAIN_ABORTED", "PostgreSQL window drain was aborted.");
    const result = await drainCapture(capture, sink, signal);
    if (result.more !== true && result.events.length === 0) {
      return;
    }
  }
}

async function closePollClient(client) {
  if (client === null || client === undefined || typeof client.end !== "function") {
    return;
  }

  await client.end();
}

function frozenTransactions(transactions) {
  const frozen = {};
  for (const [txId, seqs] of Object.entries(transactions)) {
    frozen[txId] = Object.freeze(seqs.slice());
  }
  return Object.freeze(frozen);
}

function closeResult({ sliced, sink, convergeResult, quietResult }) {
  return Object.freeze({
    ok: true,
    events: sliced.events,
    harnessTxIds: sliced.harnessTxIds,
    transactions: frozenTransactions(sink.transactions),
    warnings: Object.freeze(sink.warnings.slice()),
    converge: convergeResult,
    quiet: quietResult
  });
}

export async function openPostgresWindow(input = {}) {
  const options = normalizeOpenInput(input);
  throwIfAborted(options.signal, "E_DB_OPEN_WINDOW_ABORTED", "PostgreSQL openWindow was aborted.");

  await ensureWatermarkTable(options.client);
  await writeMarker(options.client, {
    runId: options.runId,
    scenarioId: options.scenarioId,
    surface: options.surface,
    seq: options.seq,
    nonce: options.nonce,
    kind: "open"
  });

  return Object.freeze({
    runId: options.runId,
    scenarioId: options.scenarioId,
    surface: options.surface,
    seq: options.seq,
    nonce: options.nonce,
    capture: options.capture
  });
}

export async function closePostgresWindow(input = {}) {
  const options = normalizeCloseInput(input);
  throwIfAborted(options.signal, "E_DB_CLOSE_WINDOW_ABORTED", "PostgreSQL closeWindow was aborted.");

  await writeMarker(options.client, {
    runId: options.runId,
    scenarioId: options.scenarioId,
    surface: options.surface,
    seq: options.seq,
    nonce: options.nonce,
    kind: "close"
  });

  const sink = {
    events: [],
    transactions: {},
    warnings: []
  };
  const pollClient =
    options.pollClient ?? (await options.createPollClient({ signal: options.signal }));

  try {
    const convergeResult = await converge({
      timeoutMs: options.convergeTimeoutMs,
      intervalMs: options.convergeIntervalMs,
      signal: options.signal,
      now: options.now,
      probe: ({ signal }) =>
        withFreshTransaction(pollClient, (transactionClient) =>
          expectationsVisible(transactionClient, options.expect, signal)
        )
    });

    const quietResult = await quietPeriod({
      quietMs: options.quietPeriodMs,
      capMs: options.quietPeriodCapMs,
      signal: options.signal,
      now: options.now,
      drain: async ({ signal }) => {
        const result = await drainCapture(options.capture, sink, signal);
        return result.events.length;
      }
    });

    await drainUntilExhausted(options.capture, sink, options.signal);
    const sliced = sliceWindow(sink.events, {
      runId: options.runId,
      scenarioId: options.scenarioId,
      nonce: options.nonce
    });

    return closeResult({ sliced, sink, convergeResult, quietResult });
  } finally {
    await closePollClient(pollClient);
  }
}
