import { AttestError } from "../../errors.mjs";
import { createChangeEvent } from "../change-event.mjs";
import { drainSlot } from "../drivers/postgres/slots.mjs";
import { parseSlotRows } from "./test-decoding.mjs";

const DEFAULT_BATCH_SIZE = 1000;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClient(client) {
  if (client === null || typeof client !== "object" || typeof client.query !== "function") {
    throw new TypeError("createLogicalSlotCapture requires a connected Postgres client");
  }
}

function assertSlotName(slotName) {
  if (typeof slotName !== "string" || slotName.length === 0) {
    throw new TypeError("createLogicalSlotCapture requires a slot name");
  }
}

function normalizeBatchSize(batchSize) {
  if (batchSize === undefined || batchSize === null) {
    return DEFAULT_BATCH_SIZE;
  }

  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new TypeError("logical slot capture batchSize must be a positive safe integer");
  }

  return batchSize;
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw new AttestError("E_DB_CAPTURE_ABORTED", "Logical slot capture was aborted.", {
      reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "aborted")
    });
  }
}

function rebaseEventSeq(event, offset) {
  return createChangeEvent({
    entity: event.entity,
    key: event.key,
    op: event.op,
    paths: event.paths,
    before: event.before,
    after: event.after,
    txId: event.txId,
    seq: event.seq === null ? null : event.seq + offset,
    actor: event.actor,
    fidelity: event.fidelity
  });
}

function rebaseTransactions(transactions, offset) {
  const rebased = {};
  for (const [txId, seqs] of Object.entries(transactions)) {
    rebased[txId] = Object.freeze(seqs.map((seq) => seq + offset));
  }
  return Object.freeze(rebased);
}

function freezeDrainResult(result) {
  return Object.freeze({
    events: Object.freeze(result.events),
    transactions: Object.freeze({ ...result.transactions }),
    warnings: Object.freeze(result.warnings),
    more: result.more
  });
}

/**
 * Create a logical-slot capture strategy for one Postgres scenario window.
 *
 * Draining a logical slot consumes those changes on the server. A second drain
 * only sees changes that arrived after the first drain, so callers that need a
 * quiet period must accumulate the returned events instead of re-reading the
 * window. This strategy intentionally holds no transaction open between drains.
 */
export function createLogicalSlotCapture({
  client,
  slotName,
  keyColumns,
  actorFor,
  batchSize,
  drainSlotImpl = drainSlot
} = {}) {
  assertClient(client);
  assertSlotName(slotName);

  const resolvedBatchSize = normalizeBatchSize(batchSize);
  let nextSeq = 0;

  return Object.freeze({
    async drain(options = {}) {
      if (!isPlainObject(options)) {
        throw new TypeError("logical slot drain options must be an object");
      }

      throwIfAborted(options.signal);
      const drained = await drainSlotImpl(client, slotName, {
        signal: options.signal,
        batchSize: resolvedBatchSize
      });
      throwIfAborted(options.signal);

      const parsed = parseSlotRows(drained.rows, {
        keyColumns,
        actorFor
      });
      const seqOffset = nextSeq;
      const events = parsed.events.map((event) => rebaseEventSeq(event, seqOffset));
      nextSeq += events.length;

      return freezeDrainResult({
        events,
        transactions: rebaseTransactions(parsed.transactions, seqOffset),
        warnings: parsed.warnings,
        more: drained.more === true
      });
    }
  });
}
