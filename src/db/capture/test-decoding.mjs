import { AttestError } from "../../errors.mjs";
import { createChangeEvent } from "../change-event.mjs";

export const TEST_DECODING_LINE_KINDS = Object.freeze({
  begin: "begin",
  commit: "commit",
  change: "change"
});

const INTEGER_TYPES = Object.freeze([
  "bigint",
  "bigserial",
  "int",
  "int2",
  "int4",
  "int8",
  "integer",
  "oid",
  "serial",
  "serial2",
  "serial4",
  "serial8",
  "smallint",
  "smallserial"
]);

const FLOAT_TYPES = Object.freeze([
  "double precision",
  "float",
  "float4",
  "float8",
  "real"
]);

const STRING_NUMERIC_TYPES = Object.freeze(["decimal", "money", "numeric"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unparseable(rawLine, offset, fragment, reason) {
  return new AttestError("E_DB_UNPARSEABLE_CHANGE", "Unparseable test_decoding change", {
    rawLine,
    offset,
    fragment,
    reason
  });
}

function requireString(value, field) {
  if (typeof value !== "string") {
    throw unparseable(String(value), 0, String(value), `${field}_not_string`);
  }
}

function parsePipeDelimitedRow(row) {
  const first = row.indexOf("|");
  const second = first === -1 ? -1 : row.indexOf("|", first + 1);

  if (first === -1 || second === -1) {
    return {
      lsn: null,
      xid: null,
      data: row,
      rawLine: row
    };
  }

  return {
    lsn: row.slice(0, first),
    xid: row.slice(first + 1, second),
    data: row.slice(second + 1),
    rawLine: row
  };
}

function normalizeRow(row) {
  if (typeof row === "string") {
    return parsePipeDelimitedRow(row);
  }

  if (!isPlainObject(row)) {
    throw unparseable(String(row), 0, String(row), "row_not_object_or_string");
  }

  requireString(row.data, "data");

  return {
    lsn: row.lsn === undefined || row.lsn === null ? null : String(row.lsn),
    xid: row.xid === undefined || row.xid === null ? null : String(row.xid),
    data: row.data,
    rawLine: `${row.lsn ?? ""}|${row.xid ?? ""}|${row.data}`
  };
}

function skipSpaces(text, offset) {
  let cursor = offset;
  while (cursor < text.length && text[cursor] === " ") {
    cursor += 1;
  }
  return cursor;
}

function typeBase(typeName) {
  return typeName.toLowerCase().replace(/\(.+\)$/u, "").trim();
}

function parseNumber(typeName, literal, rawLine, offset) {
  const value = Number(literal);
  if (!Number.isFinite(value)) {
    throw unparseable(rawLine, offset, literal, `invalid_${typeName}`);
  }
  return value;
}

function convertValue(typeName, literal, quoted, rawLine, offset) {
  const base = typeBase(typeName);

  if (!quoted && literal === "null") {
    return null;
  }

  if (base === "boolean") {
    if (literal === "t" || literal === "true") {
      return true;
    }
    if (literal === "f" || literal === "false") {
      return false;
    }
    throw unparseable(rawLine, offset, literal, "invalid_boolean");
  }

  if (STRING_NUMERIC_TYPES.includes(base)) {
    return literal;
  }

  if (INTEGER_TYPES.includes(base) || FLOAT_TYPES.includes(base)) {
    return parseNumber(base, literal, rawLine, offset);
  }

  return literal;
}

function scanQuotedValue(text, offset, rawLine, absoluteOffset) {
  let cursor = offset + 1;
  let value = "";

  while (cursor < text.length) {
    const char = text[cursor];

    if (char === "'") {
      if (text[cursor + 1] === "'") {
        value += "'";
        cursor += 2;
        continue;
      }

      return {
        quoted: true,
        value,
        raw: text.slice(offset, cursor + 1),
        next: cursor + 1
      };
    }

    value += char;
    cursor += 1;
  }

  throw unparseable(rawLine, absoluteOffset + offset, text.slice(offset), "unterminated_quoted_value");
}

function scanUnquotedValue(text, offset, rawLine, absoluteOffset) {
  let cursor = offset;
  while (cursor < text.length && text[cursor] !== " ") {
    cursor += 1;
  }

  if (cursor === offset) {
    throw unparseable(rawLine, absoluteOffset + offset, text.slice(offset), "missing_value");
  }

  return {
    quoted: false,
    value: text.slice(offset, cursor),
    raw: text.slice(offset, cursor),
    next: cursor
  };
}

function scanValue(text, offset, rawLine, absoluteOffset) {
  if (offset >= text.length) {
    throw unparseable(rawLine, absoluteOffset + offset, text.slice(Math.max(0, offset - 32)), "missing_value");
  }

  if (text[offset] === "'") {
    return scanQuotedValue(text, offset, rawLine, absoluteOffset);
  }

  return scanUnquotedValue(text, offset, rawLine, absoluteOffset);
}

function parseTupleColumn(text, offset, rawLine, absoluteOffset) {
  const nameStart = offset;
  const typeOpen = text.indexOf("[", nameStart);

  if (typeOpen === -1) {
    throw unparseable(rawLine, absoluteOffset + nameStart, text.slice(nameStart), "missing_type_open");
  }

  const name = text.slice(nameStart, typeOpen);
  if (name.length === 0) {
    throw unparseable(rawLine, absoluteOffset + nameStart, text.slice(nameStart), "missing_column_name");
  }

  const typeClose = text.indexOf("]", typeOpen + 1);
  if (typeClose === -1) {
    throw unparseable(rawLine, absoluteOffset + typeOpen, text.slice(typeOpen), "missing_type_close");
  }

  const typeName = text.slice(typeOpen + 1, typeClose);
  if (typeName.length === 0) {
    throw unparseable(rawLine, absoluteOffset + typeOpen, text.slice(typeOpen, typeClose + 1), "missing_type");
  }

  const colon = typeClose + 1;
  if (text[colon] !== ":") {
    throw unparseable(rawLine, absoluteOffset + colon, text.slice(nameStart, colon + 1), "missing_value_colon");
  }

  const valueStart = colon + 1;
  const scanned = scanValue(text, valueStart, rawLine, absoluteOffset);
  return {
    name,
    typeName,
    value: convertValue(typeName, scanned.value, scanned.quoted, rawLine, absoluteOffset + valueStart),
    next: scanned.next
  };
}

function parseTupleColumns(text, rawLine, absoluteOffset) {
  if (text === "(no-tuple-data)") {
    return {
      noTupleData: true,
      row: {},
      order: []
    };
  }

  const row = {};
  const order = [];
  let cursor = skipSpaces(text, 0);

  if (cursor >= text.length) {
    throw unparseable(rawLine, absoluteOffset, text, "empty_tuple");
  }

  while (cursor < text.length) {
    const column = parseTupleColumn(text, cursor, rawLine, absoluteOffset);
    row[column.name] = column.value;
    order.push(column.name);
    cursor = column.next;

    if (cursor >= text.length) {
      break;
    }

    if (text[cursor] !== " ") {
      throw unparseable(rawLine, absoluteOffset + cursor, text.slice(cursor), "missing_column_separator");
    }

    cursor = skipSpaces(text, cursor);
  }

  return {
    noTupleData: false,
    row,
    order
  };
}

function markerOutsideQuotes(text, marker, offset) {
  let cursor = offset;
  let inQuote = false;

  while (cursor < text.length) {
    if (!inQuote && text.startsWith(marker, cursor)) {
      return cursor;
    }

    const char = text[cursor];
    if (char === "'") {
      if (inQuote && text[cursor + 1] === "'") {
        cursor += 2;
        continue;
      }
      inQuote = !inQuote;
    }

    cursor += 1;
  }

  return -1;
}

function tuplePaths(row, order) {
  return order.filter((column) => Object.hasOwn(row, column)).map((column) => [column]);
}

function changedTuplePaths(before, after, afterOrder, beforeOrder) {
  const seen = new Set();
  const ordered = [];

  for (const column of afterOrder) {
    if (!seen.has(column)) {
      seen.add(column);
      ordered.push(column);
    }
  }

  for (const column of beforeOrder) {
    if (!seen.has(column)) {
      seen.add(column);
      ordered.push(column);
    }
  }

  return ordered.filter((column) => before[column] !== after[column]).map((column) => [column]);
}

function columnsForEntity(keyColumns, entity) {
  if (keyColumns === undefined || keyColumns === null) {
    return null;
  }

  if (keyColumns instanceof Map) {
    return keyColumns.get(entity) ?? null;
  }

  if (Array.isArray(keyColumns)) {
    return keyColumns;
  }

  if (isPlainObject(keyColumns)) {
    return keyColumns[entity] ?? null;
  }

  return null;
}

function buildKey(entity, image, keyColumns, rawLine, offset) {
  const columns = columnsForEntity(keyColumns, entity);
  if (columns === null) {
    return { ...image };
  }

  const key = {};
  for (const column of columns) {
    if (!Object.hasOwn(image, column)) {
      throw unparseable(rawLine, offset, column, "missing_key_column");
    }
    key[column] = image[column];
  }
  return key;
}

function actorForChange(ctx, input) {
  const actor = typeof ctx.actorFor === "function" ? ctx.actorFor(input) : { kind: "unknown" };
  if (!isPlainObject(actor)) {
    throw unparseable(input.rawLine, 0, String(actor), "actor_not_object");
  }
  return {
    ...actor,
    lsn: input.lsn
  };
}

function boundary(kind, metadata, txId) {
  return Object.freeze({
    kind,
    lsn: metadata.lsn,
    txId,
    xid: metadata.xid,
    event: null,
    warnings: Object.freeze([])
  });
}

function parseBoundary(metadata) {
  const begin = /^BEGIN(?: ([0-9]+))?$/u.exec(metadata.data);
  if (begin) {
    return boundary(TEST_DECODING_LINE_KINDS.begin, metadata, metadata.xid ?? begin[1] ?? null);
  }

  const commit = /^COMMIT(?: ([0-9]+))?$/u.exec(metadata.data);
  if (commit) {
    return boundary(TEST_DECODING_LINE_KINDS.commit, metadata, metadata.xid ?? commit[1] ?? null);
  }

  return null;
}

function changeEnvelope(metadata) {
  const match = /^table ([^:]+): (INSERT|UPDATE|DELETE): (.*)$/u.exec(metadata.data);
  if (!match) {
    throw unparseable(metadata.rawLine, 0, metadata.data, "unknown_line_kind");
  }

  return {
    entity: match[1],
    operation: match[2],
    tupleText: match[3],
    tupleOffset: metadata.rawLine.indexOf(match[3])
  };
}

function warningForNoTupleData(entity, metadata) {
  return Object.freeze({
    code: "W_DB_DELETE_NO_TUPLE_DATA",
    entity,
    lsn: metadata.lsn,
    txId: metadata.xid,
    message: "DELETE emitted no tuple data because the table has no usable replica identity"
  });
}

function createEvent(metadata, ctx, change) {
  const actor = actorForChange(ctx, {
    rawLine: metadata.rawLine,
    lsn: metadata.lsn,
    txId: metadata.xid,
    entity: change.entity,
    op: change.op
  });

  return createChangeEvent({
    entity: change.entity,
    key: change.key,
    op: change.op,
    paths: change.paths,
    before: change.before,
    after: change.after,
    txId: metadata.xid,
    seq: Number.isInteger(ctx.seq) ? ctx.seq : null,
    actor,
    fidelity: change.fidelity
  });
}

function parseInsert(metadata, ctx, envelope) {
  const after = parseTupleColumns(envelope.tupleText, metadata.rawLine, envelope.tupleOffset);
  const change = {
    entity: envelope.entity,
    key: buildKey(envelope.entity, after.row, ctx.keyColumns, metadata.rawLine, envelope.tupleOffset),
    op: "insert",
    paths: tuplePaths(after.row, after.order),
    before: null,
    after: after.row,
    fidelity: "value_only"
  };
  return createEvent(metadata, ctx, change);
}

function parseDelete(metadata, ctx, envelope, warnings) {
  const before = parseTupleColumns(envelope.tupleText, metadata.rawLine, envelope.tupleOffset);
  if (before.noTupleData) {
    const warning = warningForNoTupleData(envelope.entity, metadata);
    warnings.push(warning);
    return createEvent(metadata, ctx, {
      entity: envelope.entity,
      key: {},
      op: "delete",
      paths: [],
      before: {},
      after: null,
      fidelity: "key_only"
    });
  }

  return createEvent(metadata, ctx, {
    entity: envelope.entity,
    key: buildKey(envelope.entity, before.row, ctx.keyColumns, metadata.rawLine, envelope.tupleOffset),
    op: "delete",
    paths: tuplePaths(before.row, before.order),
    before: before.row,
    after: null,
    fidelity: "key_only"
  });
}

function parseUpdate(metadata, ctx, envelope) {
  const oldPrefix = "old-key: ";
  if (!envelope.tupleText.startsWith(oldPrefix)) {
    const after = parseTupleColumns(envelope.tupleText, metadata.rawLine, envelope.tupleOffset);
    return createEvent(metadata, ctx, {
      entity: envelope.entity,
      key: buildKey(envelope.entity, after.row, ctx.keyColumns, metadata.rawLine, envelope.tupleOffset),
      op: "update",
      paths: tuplePaths(after.row, after.order),
      before: null,
      after: after.row,
      fidelity: "key_only"
    });
  }

  const marker = " new-tuple: ";
  const markerAt = markerOutsideQuotes(envelope.tupleText, marker, oldPrefix.length);
  if (markerAt === -1) {
    throw unparseable(metadata.rawLine, envelope.tupleOffset, envelope.tupleText, "missing_new_tuple");
  }

  const oldText = envelope.tupleText.slice(oldPrefix.length, markerAt);
  const newText = envelope.tupleText.slice(markerAt + marker.length);
  const before = parseTupleColumns(oldText, metadata.rawLine, envelope.tupleOffset + oldPrefix.length);
  const after = parseTupleColumns(newText, metadata.rawLine, envelope.tupleOffset + markerAt + marker.length);

  return createEvent(metadata, ctx, {
    entity: envelope.entity,
    key: buildKey(envelope.entity, after.row, ctx.keyColumns, metadata.rawLine, envelope.tupleOffset),
    op: "update",
    paths: changedTuplePaths(before.row, after.row, after.order, before.order),
    before: before.row,
    after: after.row,
    fidelity: "full"
  });
}

export function parseChangeLine(row, ctx = {}) {
  const metadata = normalizeRow(row);
  const boundaryResult = parseBoundary(metadata);
  if (boundaryResult) {
    return boundaryResult;
  }

  const warnings = [];
  const envelope = changeEnvelope(metadata);
  let event;

  if (envelope.operation === "INSERT") {
    event = parseInsert(metadata, ctx, envelope);
  } else if (envelope.operation === "UPDATE") {
    event = parseUpdate(metadata, ctx, envelope);
  } else if (envelope.operation === "DELETE") {
    event = parseDelete(metadata, ctx, envelope, warnings);
  } else {
    throw unparseable(metadata.rawLine, 0, metadata.data, "unknown_operation");
  }

  if (Array.isArray(ctx.warnings)) {
    ctx.warnings.push(...warnings);
  }

  return Object.freeze({
    kind: TEST_DECODING_LINE_KINDS.change,
    lsn: metadata.lsn,
    txId: metadata.xid,
    xid: metadata.xid,
    event,
    warnings: Object.freeze(warnings)
  });
}

export function parseSlotRows(rows, options = {}) {
  if (!Array.isArray(rows)) {
    throw unparseable(String(rows), 0, String(rows), "rows_not_array");
  }

  const events = [];
  const transactions = {};
  const warnings = [];

  for (const row of rows) {
    const parsed = parseChangeLine(row, {
      keyColumns: options.keyColumns,
      actorFor: options.actorFor,
      seq: events.length,
      warnings
    });

    if (parsed.kind !== TEST_DECODING_LINE_KINDS.change) {
      if (parsed.txId !== null && !Object.hasOwn(transactions, parsed.txId)) {
        transactions[parsed.txId] = [];
      }
      continue;
    }

    events.push(parsed.event);
    if (parsed.txId !== null) {
      transactions[parsed.txId] ??= [];
      transactions[parsed.txId].push(parsed.event.seq);
    }
  }

  return {
    events,
    transactions,
    warnings
  };
}
