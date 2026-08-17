import { AttestError } from "../../errors.mjs";
import { createChangeEvent } from "../change-event.mjs";

/**
 * Mongo change stream documents to canonical ChangeEvents.
 *
 * A change stream is the cleanest signal of the five engines: it is an actual
 * event log rather than a counter or a diff, it carries the transaction an
 * event belongs to, and for an update it names exactly which fields changed
 * instead of leaving a reader to compare two whole documents.
 *
 * This module is pure. It never opens a connection, so it is asserted against
 * committed fixtures with no Mongo anywhere.
 */

// The operations a collection watcher can emit that describe row level change.
const OP_FOR_OPERATION_TYPE = Object.freeze({
  insert: "insert",
  update: "update",
  replace: "update",
  delete: "delete"
});

// Emitted by a change stream and deliberately NOT mapped. Each one means the
// stream's own assumptions broke, and turning it into a row change would be
// inventing a change that did not happen.
const STREAM_LIFECYCLE_TYPES = Object.freeze([
  "drop",
  "dropDatabase",
  "rename",
  "invalidate",
  "shardCollection",
  "refineCollectionShardKey",
  "reshardCollection"
]);

function parseError(reason, details = {}) {
  return new AttestError("E_CHANGE_STREAM_INVALID", "Invalid Mongo change stream document", {
    reason,
    ...details
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * BSON values are objects, and two of them compare unequal even when they mean
 * the same thing. Normalising here keeps row hashing and key matching stable,
 * which is the same reason the Postgres driver has a canonical normaliser.
 */
export function normalizeBson(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeBson(item));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (isPlainObject(value)) {
    // ObjectId, Decimal128, Long, Binary and friends all carry _bsontype and a
    // meaningful toString. Keeping the wrapper object would make an id compare
    // unequal to itself across two reads.
    if (typeof value._bsontype === "string") {
      return String(value.toString());
    }

    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeBson(item)]));
  }

  return value;
}

function entityFor(document) {
  const ns = document.ns;
  if (!isPlainObject(ns) || typeof ns.db !== "string" || typeof ns.coll !== "string") {
    throw parseError("missing_namespace", { operationType: document.operationType ?? null });
  }

  // Already schema qualified, which is what ChangeEvent requires.
  return `${ns.db}.${ns.coll}`;
}

function keyFor(document) {
  if (!isPlainObject(document.documentKey)) {
    throw parseError("missing_document_key", { operationType: document.operationType });
  }

  return normalizeBson(document.documentKey);
}

/**
 * A document store has no columns, so the changed "columns" of an update are
 * the top level fields that changed. `updateDescription` gives that directly,
 * which is more precise than diffing two whole documents and is the reason a
 * change stream beats polling here.
 */
function pathsFor(document, op) {
  if (op === "update" && isPlainObject(document.updateDescription)) {
    const updated = Object.keys(document.updateDescription.updatedFields ?? {});
    const removed = Array.isArray(document.updateDescription.removedFields)
      ? document.updateDescription.removedFields
      : [];

    // A dotted key is a nested field, and it is a path, not a name.
    return [...updated, ...removed].toSorted().map((field) => field.split("."));
  }

  const document_ = op === "delete" ? document.fullDocumentBeforeChange : document.fullDocument;
  if (isPlainObject(document_)) {
    return Object.keys(document_).toSorted().map((field) => [field]);
  }

  return Object.keys(keyFor(document)).toSorted().map((field) => [field]);
}

// A change stream reports the transaction an event belongs to, so a derived
// rule can name its source mutation. Outside a transaction there is none, and
// saying so is better than inventing one.
function txIdFor(document) {
  const session = document.lsid;
  const txnNumber = document.txnNumber;

  if (session === undefined || session === null || txnNumber === undefined || txnNumber === null) {
    return null;
  }

  const id = normalizeBson(session);
  return `${typeof id === "string" ? id : JSON.stringify(id)}:${normalizeBson(txnNumber)}`;
}

/**
 * How much of the row this event actually carries.
 *
 * An update without pre images knows the after values and which fields changed,
 * but not what they were before. Claiming "full" there would let a rule compare
 * against a before image that does not exist.
 */
function fidelityFor(document, op) {
  const hasBefore = isPlainObject(document.fullDocumentBeforeChange);

  if (op === "insert") {
    return isPlainObject(document.fullDocument) ? "full" : "key_only";
  }

  if (op === "delete") {
    return hasBefore ? "full" : "key_only";
  }

  if (hasBefore && isPlainObject(document.fullDocument)) {
    return "full";
  }

  return isPlainObject(document.fullDocument) ? "value_only" : "key_only";
}

function beforeFor(document, op) {
  if (op === "insert") {
    return null;
  }

  return isPlainObject(document.fullDocumentBeforeChange)
    ? normalizeBson(document.fullDocumentBeforeChange)
    : null;
}

function afterFor(document, op) {
  if (op === "delete") {
    return null;
  }

  return isPlainObject(document.fullDocument) ? normalizeBson(document.fullDocument) : null;
}

export function isLifecycleEvent(document) {
  return STREAM_LIFECYCLE_TYPES.includes(document?.operationType);
}

/**
 * Translate one change stream document.
 *
 * `seq` comes from the caller's stream position rather than from clusterTime,
 * because clusterTime has second granularity and several events can share one.
 */
export function toChangeEvent(document, { seq = null, actorFor = null } = {}) {
  if (!isPlainObject(document)) {
    throw parseError("document_not_object");
  }

  if (typeof document.operationType !== "string") {
    throw parseError("missing_operation_type");
  }

  if (isLifecycleEvent(document)) {
    // The collection was dropped, renamed or resharded underneath the stream.
    // The window's assumptions are gone, so this is refused rather than
    // silently skipped: a dropped collection is not "no changes".
    throw parseError("stream_lifecycle_event", {
      operationType: document.operationType,
      remediation:
        "The watched collection changed shape during the window. Re run the scenario against a stable schema."
    });
  }

  const op = OP_FOR_OPERATION_TYPE[document.operationType];
  if (op === undefined) {
    // Never dropped. An unrecognised operationType is a Mongo version this
    // parser has not been taught, and skipping it would silently lose a change.
    throw parseError("unknown_operation_type", {
      operationType: document.operationType,
      accepted: Object.keys(OP_FOR_OPERATION_TYPE)
    });
  }

  const key = keyFor(document);

  return createChangeEvent({
    entity: entityFor(document),
    key,
    op,
    paths: pathsFor(document, op),
    before: beforeFor(document, op),
    after: afterFor(document, op),
    txId: txIdFor(document),
    seq,
    actor: typeof actorFor === "function" ? actorFor(document) : { kind: "unknown", id: null },
    fidelity: fidelityFor(document, op)
  });
}

/**
 * Translate a batch, numbering events by their position in the stream.
 */
export function toChangeEvents(documents, { startSeq = 0, actorFor = null } = {}) {
  if (!Array.isArray(documents)) {
    throw parseError("documents_not_array");
  }

  return Object.freeze(
    documents.map((document, index) => toChangeEvent(document, { seq: startSeq + index, actorFor }))
  );
}
