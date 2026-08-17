import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { InfraError, UsageError } from "../../../errors.mjs";

/**
 * Driver defaults are pinned here, explicitly, which is half of DB-03.
 *
 * `node:sqlite` is a release candidate, so inheriting whatever it happens to
 * default to today means a run can change behaviour under a Node patch release
 * with nothing in the diff. Each pin below is session scoped: none of them
 * writes to the file or changes anything the app under test will observe.
 *
 *   query_only        the observer must never write to the database it is
 *                     watching. This makes that structural rather than a
 *                     promise about how carefully the SQL was written.
 *   busy_timeout      SQLite defaults to 0, which means a snapshot taken while
 *                     the app is mid write fails immediately with SQLITE_BUSY
 *                     and looks like a harness bug.
 *   read_uncommitted  pinned off, so a shared cache connection can never read
 *                     a write the app has not committed. Asserting on
 *                     uncommitted data would be worse than missing it.
 *   foreign_keys      pinned off on the observer connection: it never writes,
 *                     and enforcing constraints on a read only connection only
 *                     adds ways for a snapshot to fail.
 */
export const SQLITE_PINNED_PRAGMAS = Object.freeze({
  query_only: "ON",
  busy_timeout: "5000",
  read_uncommitted: "OFF",
  foreign_keys: "OFF"
});

// Read, never set. Changing a database file's journal mode from the harness
// would be the observer altering the thing it observes, and it persists.
export const SQLITE_OBSERVED_PRAGMAS = Object.freeze(["journal_mode", "data_version", "schema_version"]);

function fileFor(target) {
  if (typeof target?.database !== "string" || target.database.length === 0) {
    throw new UsageError("E_SQLITE_FILE_REQUIRED", "SQLite target carries no database file path", {
      target: target?.database ?? null
    });
  }

  return target.database;
}

export function resolveSqliteFile(target, { cwd = process.cwd() } = {}) {
  const file = fileFor(target);
  return file === ":memory:" ? file : path.resolve(cwd, file);
}

function pragmaValue(database, name) {
  try {
    const row = database.prepare(`PRAGMA ${name}`).get();
    return row === undefined ? null : Object.values(row)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Open the observer connection.
 *
 * Read only at the file level as well as through `query_only`, so a bug in this
 * driver cannot write to the app's database even if it tried.
 */
export function openSqliteDatabase(target, { cwd = process.cwd(), readOnly = true } = {}) {
  const file = resolveSqliteFile(target, { cwd });

  if (file !== ":memory:" && !existsSync(file)) {
    throw new InfraError("E_SQLITE_FILE_MISSING", "The SQLite database file does not exist", {
      file,
      remediation:
        "Point db.url at the file the app under test writes, and make sure the app has created it before the run starts."
    });
  }

  let database;
  try {
    database = new DatabaseSync(file, { readOnly: readOnly && file !== ":memory:" });
  } catch (error) {
    throw new InfraError("E_SQLITE_OPEN_FAILED", "Could not open the SQLite database", {
      file,
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  for (const [name, value] of Object.entries(SQLITE_PINNED_PRAGMAS)) {
    try {
      database.exec(`PRAGMA ${name} = ${value}`);
    } catch (error) {
      // query_only cannot be set on some builds. Refusing loudly beats running
      // an observer that might write.
      throw new InfraError("E_SQLITE_PRAGMA_FAILED", `Could not pin SQLite pragma ${name}`, {
        pragma: name,
        value,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const observed = Object.fromEntries(
    SQLITE_OBSERVED_PRAGMAS.map((name) => [name, pragmaValue(database, name)])
  );

  return Object.freeze({
    file,
    database,
    observed: Object.freeze(observed),
    pinned: SQLITE_PINNED_PRAGMAS,
    dataVersion() {
      return pragmaValue(database, "data_version");
    },
    close() {
      try {
        database.close();
      } catch {
        // Teardown is best effort and must never mask a run result.
      }
    }
  });
}
