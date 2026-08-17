import stableStringify from "json-stable-stringify";

import { AttestError } from "../../errors.mjs";
import { createChangeEvent } from "../change-event.mjs";

/**
 * Engine neutral snapshot diff.
 *
 * This is the fallback capture strategy, and it is genuinely weaker than a
 * change stream. It is worth being precise about how, because the difference is
 * the difference between a gate and a rumour:
 *
 *   ordering      a diff has none. Two rows changed, but not in any order.
 *   attribution   a diff has none. Nobody wrote these rows, they are just
 *                 different now, so a derived rule cannot name its source.
 *   round trips   a row inserted and then deleted inside one window leaves no
 *                 trace at all, and neither does a value changed and changed
 *                 back. Those are invisible, not merely unattributed.
 *
 * Everything downstream, the classifier and the typed rule engine, consumes the
 * same ChangeEvent shape either way. What changes is what the events can
 * possibly say, which is why the driver declares it rather than the reader
 * inferring it.
 */

export const SNAPSHOT_BLIND_SPOTS = Object.freeze([
  "no ordering: changes within a window carry no sequence",
  "no attribution: changes carry no transaction or author",
  "no round trips: an insert then delete, or a value changed and changed back, is invisible"
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diffError(reason, details = {}) {
  return new AttestError("E_SNAPSHOT_DIFF_INVALID", "Invalid snapshot diff input", {
    reason,
    ...details
  });
}

function assertEntity(entity) {
  if (typeof entity !== "string" || !entity.includes(".")) {
    throw diffError("entity_not_schema_qualified", { entity });
  }

  return entity;
}

function assertRows(rows, field, entity) {
  if (!Array.isArray(rows) || rows.some((row) => !isPlainObject(row))) {
    throw diffError("rows_not_object_array", { field, entity });
  }

  return rows;
}

function assertKeyColumns(keyColumns, entity) {
  if (!Array.isArray(keyColumns) || keyColumns.length === 0 || keyColumns.some((column) => typeof column !== "string")) {
    // Without a key there is no way to tell an update from a delete plus an
    // insert, and guessing would invent changes that never happened.
    throw diffError("key_columns_required", { entity });
  }

  return keyColumns;
}

function keyOf(row, keyColumns, entity) {
  const key = {};
  for (const column of keyColumns) {
    if (!Object.hasOwn(row, column)) {
      throw diffError("row_missing_key_column", { entity, column });
    }
    key[column] = row[column];
  }

  return key;
}

function keyId(key) {
  return stableStringify(key) ?? "";
}

function indexByKey(rows, keyColumns, entity) {
  const index = new Map();

  for (const row of rows) {
    const key = keyOf(row, keyColumns, entity);
    const id = keyId(key);

    if (index.has(id)) {
      // Two rows with the same key means the declared key is not a key. Silently
      // keeping one would hide every change to the other.
      throw diffError("duplicate_key", { entity, key: id });
    }

    index.set(id, Object.freeze({ key, row }));
  }

  return index;
}

function changedColumns(before, after) {
  const columns = new Set([...Object.keys(before), ...Object.keys(after)]);

  return [...columns]
    .filter((column) => stableStringify(before[column] ?? null) !== stableStringify(after[column] ?? null))
    .toSorted();
}

function event(entity, op, key, before, after, paths) {
  return createChangeEvent({
    entity,
    key,
    op,
    paths,
    before,
    after,
    // A snapshot pair has no transaction and no sequence. Emitting a synthetic
    // one would let a derived rule claim attribution this strategy cannot give.
    txId: null,
    seq: null,
    actor: { kind: "unknown", id: null },
    fidelity: "full"
  });
}

/**
 * Diff one entity's before and after snapshots into ChangeEvents.
 *
 * Deterministic: rows are compared by declared key and emitted in key order,
 * because the engine gives no order of its own and a run must be reproducible.
 */
export function diffEntity({ entity, keyColumns, before = [], after = [] } = {}) {
  const name = assertEntity(entity);
  const keys = assertKeyColumns(keyColumns, name);
  const beforeIndex = indexByKey(assertRows(before, "before", name), keys, name);
  const afterIndex = indexByKey(assertRows(after, "after", name), keys, name);

  const events = [];
  const ids = [...new Set([...beforeIndex.keys(), ...afterIndex.keys()])].toSorted();

  for (const id of ids) {
    const previous = beforeIndex.get(id) ?? null;
    const current = afterIndex.get(id) ?? null;

    if (previous === null) {
      events.push(event(name, "insert", current.key, null, current.row, Object.keys(current.row).toSorted().map((column) => [column])));
      continue;
    }

    if (current === null) {
      events.push(event(name, "delete", previous.key, previous.row, null, Object.keys(previous.row).toSorted().map((column) => [column])));
      continue;
    }

    const columns = changedColumns(previous.row, current.row);
    if (columns.length === 0) {
      continue;
    }

    // An update, not a delete plus an insert. The row is the same row: it has
    // the same declared key, and saying otherwise would report two changes
    // where one happened.
    events.push(event(name, "update", current.key, previous.row, current.row, columns.map((column) => [column])));
  }

  return Object.freeze(events);
}

/**
 * Diff a whole snapshot pair, entity by entity, in declared entity order.
 */
export function diffSnapshots({ entities = [], before = new Map(), after = new Map(), keyColumns = {} } = {}) {
  const events = [];

  for (const entity of entities) {
    const name = typeof entity === "string" ? entity : `${entity.schema}.${entity.table}`;
    events.push(
      ...diffEntity({
        entity: name,
        keyColumns: keyColumns[name],
        before: before.get(name) ?? [],
        after: after.get(name) ?? []
      })
    );
  }

  return Object.freeze(events);
}
