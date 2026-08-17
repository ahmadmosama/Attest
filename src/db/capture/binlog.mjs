import { AttestError } from "../../errors.mjs";
import { createChangeEvent } from "../change-event.mjs";

/**
 * MySQL row format binlog events to canonical ChangeEvents.
 *
 * The binlog is MySQL's logical replication stream, so the classifier and the
 * rule engine consume the same ChangeEvent shape they consume from Postgres,
 * with no special cases. `information_schema.TABLES.UPDATE_TIME` is the
 * tempting shortcut and is unreliable for InnoDB, which would produce false
 * negatives: the worst possible failure mode for a gate.
 *
 * The input here is a NEUTRAL row event, not any library's object. A client
 * that produces the events does not get to define Attest's event shape, and
 * keeping the boundary here is what lets the parser be asserted against
 * committed fixtures with no MySQL anywhere.
 */

// The three row events, and nothing else. A binlog also carries QUERY, XID,
// ROTATE, FORMAT_DESCRIPTION and TABLE_MAP events; those are stream mechanics
// the caller consumes, not row changes.
const OP_FOR_EVENT_TYPE = Object.freeze({
  write_rows: "insert",
  update_rows: "update",
  delete_rows: "delete"
});

// A STATEMENT format binlog carries the SQL text rather than the rows. There is
// no way to recover per row before and after images from it, which is why
// preflight refuses that server rather than this parser trying.
const STATEMENT_EVENT_TYPES = Object.freeze(["query", "intvar", "user_var"]);

export const BINLOG_ROW_EVENT_TYPES = Object.freeze(Object.keys(OP_FOR_EVENT_TYPE));

function parseError(reason, details = {}) {
  return new AttestError("E_BINLOG_EVENT_INVALID", "Invalid MySQL binlog row event", {
    reason,
    ...details
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * MySQL hands back Buffers for binary columns and Date objects for temporal
 * ones. Normalising here keeps row hashing and key matching stable across two
 * reads, the same reason the Postgres driver has a canonical normaliser.
 */
export function normalizeMysqlValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeMysqlValue(item));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeMysqlValue(item)]));
  }

  return value;
}

function normalizeRow(row) {
  return row === null || row === undefined ? null : normalizeMysqlValue(row);
}

function entityFor(event) {
  if (typeof event.schema !== "string" || event.schema.length === 0 || typeof event.table !== "string" || event.table.length === 0) {
    throw parseError("missing_table_map", { type: event.type ?? null });
  }

  return `${event.schema}.${event.table}`;
}

function keyFor(row, keyColumns, entity) {
  if (!Array.isArray(keyColumns) || keyColumns.length === 0) {
    throw parseError("key_columns_required", { entity });
  }

  const key = {};
  for (const column of keyColumns) {
    if (!Object.hasOwn(row ?? {}, column)) {
      throw parseError("row_missing_key_column", { entity, column });
    }
    key[column] = normalizeMysqlValue(row[column]);
  }

  return key;
}

function changedPathsFor(before, after) {
  const columns = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);

  return [...columns]
    .filter((column) => JSON.stringify(before?.[column] ?? null) !== JSON.stringify(after?.[column] ?? null))
    .toSorted()
    .map((column) => [column]);
}

function allPaths(row) {
  return Object.keys(row ?? {}).toSorted().map((column) => [column]);
}

// The transaction identity comes from the XID event that commits the group, and
// the caller threads it through. Without it a derived rule could not name its
// source mutation.
function txIdFor(event) {
  return event.xid === undefined || event.xid === null ? null : String(event.xid);
}

/**
 * Row images depend on `binlog_row_image`.
 *
 * FULL gives every column before and after. MINIMAL gives the key plus the
 * columns that changed, so an update's before image is partial and a delete
 * carries only the key. The descriptor reports what the server is actually set
 * to, and this reports the same per event.
 */
function fidelityFor(rowImage, op) {
  if (rowImage === "full") {
    return "full";
  }

  return op === "delete" ? "key_only" : "value_only";
}

function pairsFor(event, op) {
  const rows = Array.isArray(event.rows) ? event.rows : null;
  if (rows === null) {
    throw parseError("rows_not_array", { type: event.type });
  }

  if (op === "insert") {
    return rows.map((row) => ({ before: null, after: normalizeRow(row) }));
  }

  if (op === "delete") {
    return rows.map((row) => ({ before: normalizeRow(row), after: null }));
  }

  return rows.map((row) => {
    if (!isPlainObject(row) || !Object.hasOwn(row, "after")) {
      // An update row must carry both images. Guessing the before image would
      // invent a change that was never observed.
      throw parseError("update_row_missing_images", { type: event.type });
    }

    return { before: normalizeRow(row.before), after: normalizeRow(row.after) };
  });
}

/**
 * Translate one neutral binlog row event, which may carry several rows.
 */
export function toChangeEvents(event, { keyColumns = {}, startSeq = 0, rowImage = "full", actorFor = null } = {}) {
  if (!isPlainObject(event) || typeof event.type !== "string") {
    throw parseError("event_not_object");
  }

  if (STATEMENT_EVENT_TYPES.includes(event.type)) {
    // Reached only if preflight was bypassed: a STATEMENT format server is
    // refused before a run starts, because SQL text cannot yield row images.
    throw parseError("statement_format_event", {
      type: event.type,
      remediation: "This server is not in ROW binlog format. Set binlog_format=ROW."
    });
  }

  const op = OP_FOR_EVENT_TYPE[event.type];
  if (op === undefined) {
    // Never dropped silently. An unrecognised row event is a MySQL version this
    // parser has not been taught, and skipping it would lose a change.
    throw parseError("unknown_event_type", { type: event.type, accepted: BINLOG_ROW_EVENT_TYPES });
  }

  const entity = entityFor(event);
  const columns = keyColumns[entity];

  return Object.freeze(
    pairsFor(event, op).map((pair, index) => {
      const identifying = op === "delete" ? pair.before : pair.after;

      return createChangeEvent({
        entity,
        key: keyFor(identifying, columns, entity),
        op,
        paths: op === "update" ? changedPathsFor(pair.before, pair.after) : allPaths(identifying),
        before: pair.before,
        after: pair.after,
        txId: txIdFor(event),
        seq: startSeq + index,
        actor: typeof actorFor === "function" ? actorFor(event) : { kind: "unknown", id: null },
        fidelity: fidelityFor(rowImage, op)
      });
    })
  );
}

/**
 * Translate a batch of row events, numbering across the whole batch.
 */
export function toChangeEventBatch(events, options = {}) {
  if (!Array.isArray(events)) {
    throw parseError("events_not_array");
  }

  const out = [];
  for (const event of events) {
    out.push(...toChangeEvents(event, { ...options, startSeq: (options.startSeq ?? 0) + out.length }));
  }

  return Object.freeze(out);
}
