import { AttestError, InfraError } from "../../../errors.mjs";
import { converge, quietPeriod } from "../../../runtime/converge.mjs";
import { diffEntity } from "../../capture/snapshot-diff.mjs";
import { assertImplementsDbPort } from "../../port.mjs";
import { sqliteCapabilities } from "./capabilities.mjs";
import { openSqliteDatabase } from "./connect.mjs";

const DEFAULT_CONVERGE_TIMEOUT_MS = 10_000;
const DEFAULT_CONVERGE_INTERVAL_MS = 50;
const DEFAULT_QUIET_PERIOD_MS = 750;
const QUIET_CAP_MULTIPLIER = 4;

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function quoteIdent(identifier, field) {
  if (typeof identifier !== "string" || !IDENTIFIER_RE.test(identifier)) {
    // The driver reads schemas it does not own, so every identifier that
    // reaches SQL is checked rather than escaped. An entity name is
    // configuration, and configuration that builds SQL is an injection surface.
    throw new AttestError("E_SQLITE_IDENTIFIER_INVALID", "SQLite identifier is not a plain identifier", {
      field,
      value: typeof identifier === "string" ? identifier : null
    });
  }

  return `"${identifier}"`;
}

function entityName(entity) {
  return typeof entity === "string" ? entity : `${entity.schema ?? "main"}.${entity.table}`;
}

function tableOf(entity) {
  return typeof entity === "string" ? entity.split(".").at(-1) : entity.table;
}

function contextSignal(ctx) {
  return ctx?.signal ?? undefined;
}

function throwIfAborted(signal, code, message) {
  if (signal?.aborted === true) {
    throw new InfraError(code, message, {
      reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "aborted")
    });
  }
}

function entitiesFor(config, ctx) {
  if (Array.isArray(ctx?.entities)) {
    return ctx.entities;
  }

  return Array.isArray(config?.entities) ? config.entities : [];
}

function keyColumnsFor(config, ctx) {
  return ctx?.keyColumns ?? config?.keyColumns ?? {};
}

function positiveMs(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Snapshot one entity, optionally scoped to a tenant.
 *
 * Ordering is by rowid, which is stable for a given file but carries no
 * meaning: the diff sorts by declared key, because a run must be reproducible
 * and SQLite gives no order of its own.
 */
function snapshotEntity(handle, entity, tenantKey) {
  const table = quoteIdent(tableOf(entity), "table");
  const tenantColumn = typeof entity === "string" ? null : entity.tenantColumn ?? null;

  if (tenantColumn !== null && tenantKey !== null && tenantKey !== undefined) {
    const column = quoteIdent(tenantColumn, "tenantColumn");
    return handle.database.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).all(tenantKey);
  }

  return handle.database.prepare(`SELECT * FROM ${table}`).all();
}

function snapshotAll(handle, entities, tenantKey) {
  const snapshot = new Map();

  for (const entity of entities) {
    try {
      snapshot.set(entityName(entity), snapshotEntity(handle, entity, tenantKey));
    } catch (error) {
      if (error instanceof AttestError) {
        throw error;
      }

      throw new InfraError("E_SQLITE_SNAPSHOT_FAILED", "Could not snapshot an entity", {
        entity: entityName(entity),
        cause: error instanceof Error ? error.message : String(error),
        remediation: "Check the entity exists in this database and that db.entities names it correctly."
      });
    }
  }

  return snapshot;
}

function diffAll(entities, keyColumns, before, after) {
  const events = [];

  for (const entity of entities) {
    const name = entityName(entity);
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

// An expectation is satisfied when at least `count` events match its entity and
// op. This is deliberately weaker than the classifier's own matching: it is a
// convergence signal, not the assertion. The classifier still decides.
function expectationsMet(events, expect) {
  return expect.every((expectation) => {
    const matches = events.filter(
      (event) => event.entity === expectation.entity && event.op === expectation.op
    ).length;
    return matches >= (expectation.count ?? 1);
  });
}

function windowNotOpen(runId, scenarioId) {
  return new InfraError("E_DB_WINDOW_NOT_OPEN", "SQLite closeWindow has no open window.", {
    runId,
    scenarioId
  });
}

/**
 * The SQLite database driver.
 *
 * Capture is a snapshot pair rather than a change stream, which is the DB-03
 * fallback. Everything downstream is unchanged: the same ChangeEvent shape, the
 * same four bucket classifier, the same typed rules. What changes is what the
 * events can possibly say, and the descriptor says so on every run.
 */
export function createSqliteDriver({ target, config = {}, runId, scenarioId, dependencies } = {}) {
  const deps = { openSqliteDatabase, ...dependencies };
  const state = {
    handle: null,
    capabilities: null,
    window: null
  };

  function requireHandle(operation) {
    if (state.handle === null) {
      throw new InfraError("E_DB_DRIVER_NOT_READY", `SQLite ${operation} requires preflight to have run.`, {
        operation,
        runId,
        scenarioId
      });
    }

    return state.handle;
  }

  const driver = {
    describeCapabilities() {
      if (state.capabilities === null) {
        throw new InfraError("E_DB_CAPABILITIES_NOT_READY", "SQLite capabilities are not known until preflight runs.", {
          driver: "sqlite"
        });
      }

      return state.capabilities;
    },

    async preflight(ctx = {}) {
      const signal = contextSignal(ctx);
      throwIfAborted(signal, "E_DB_PREFLIGHT_ABORTED", "SQLite driver preflight was aborted.");

      const handle = deps.openSqliteDatabase(target, { cwd: ctx.cwd ?? config.cwd });

      try {
        state.capabilities = sqliteCapabilities({ journalMode: handle.observed.journal_mode });

        // Every configured entity is read once here, so a misspelled table is an
        // infrastructure error before the scenario runs rather than a confusing
        // empty delta after it.
        snapshotAll(handle, entitiesFor(config, ctx), ctx.tenantKey ?? config.tenantKey ?? null);
      } catch (error) {
        // A preflight that fails after opening must not leave the connection
        // behind. On Windows an open handle holds a lock on the file, so the
        // leak is not merely untidy: nothing else can remove or replace that
        // database for the life of the process.
        handle.close();
        state.capabilities = null;
        throw error;
      }

      state.handle = handle;
      return Object.freeze({ ok: true, capabilities: state.capabilities });
    },

    async openWindow(ctx = {}) {
      const signal = contextSignal(ctx);
      throwIfAborted(signal, "E_DB_OPEN_WINDOW_ABORTED", "SQLite openWindow was aborted.");
      const handle = requireHandle("openWindow");

      const op = ctx.op ?? ctx;
      const entities = entitiesFor(config, ctx);
      const tenantKey = ctx.tenantKey ?? ctx.tenant?.tenantKey ?? config.tenantKey ?? null;

      state.window = Object.freeze({
        runId,
        scenarioId: op.scenarioId ?? scenarioId,
        surface: op.surface ?? config.surface ?? "db",
        seq: op.seq ?? 0,
        entities: Object.freeze([...entities]),
        tenantKey,
        // The fence is this snapshot, taken by the harness. There is no marker
        // row in the app's tables, which is what watermarkFencing "external"
        // means in the descriptor.
        before: snapshotAll(handle, entities, tenantKey),
        dataVersion: handle.dataVersion()
      });

      return state.window;
    },

    async closeWindow(windowHandle = null, ctx = {}) {
      const signal = contextSignal(ctx);
      throwIfAborted(signal, "E_DB_CLOSE_WINDOW_ABORTED", "SQLite closeWindow was aborted.");
      const handle = requireHandle("closeWindow");

      const window = windowHandle?.before instanceof Map ? windowHandle : state.window;
      if (window === null || window === undefined) {
        throw windowNotOpen(runId, scenarioId);
      }

      const op = windowHandle?.kind === "db_window_close" ? windowHandle : ctx.op ?? ctx;
      const expect = Array.isArray(op.expect) ? op.expect : [];
      const keyColumns = keyColumnsFor(config, ctx);
      const now = ctx.now ?? config.now ?? Date.now;
      let events = Object.freeze([]);
      // converge and quietPeriod both treat a throwing probe as "not yet". A
      // snapshot that fails because the table went away, or because an entity
      // name is not an identifier, will never succeed by waiting, so retrying
      // it would spend the whole window and then report an empty delta: a
      // failure about the wrong thing, and the kind that reads as a pass.
      let fatal = null;

      function resnapshot() {
        events = diffAll(window.entities, keyColumns, window.before, snapshotAll(handle, window.entities, window.tenantKey));
        return events;
      }

      function guarded(work, satisfied) {
        if (fatal !== null) {
          return satisfied;
        }

        try {
          return work();
        } catch (error) {
          fatal = error;
          return satisfied;
        }
      }

      // Bounded convergence on the expected mutations becoming visible. This is
      // DB-08: the race between "the UI says saved" and "the row is visible to
      // another connection" must not produce a false failure.
      const convergeResult = await converge({
        timeoutMs: positiveMs(op.convergeTimeoutMs, DEFAULT_CONVERGE_TIMEOUT_MS),
        intervalMs: positiveMs(op.convergeIntervalMs, DEFAULT_CONVERGE_INTERVAL_MS),
        signal,
        now,
        probe: () => guarded(() => Object.freeze({ ok: expectationsMet(resnapshot(), expect) }), Object.freeze({ ok: true }))
      });

      if (fatal !== null) {
        throw fatal;
      }

      // Then wait for the picture to stop moving, so a write that lands just
      // after the expectations are met is still inside this window rather than
      // orphaned into the next one.
      const quietMs = positiveMs(op.quietPeriodMs, DEFAULT_QUIET_PERIOD_MS);
      let lastCount = events.length;
      const quietResult = await quietPeriod({
        quietMs,
        capMs: positiveMs(op.quietPeriodCapMs, quietMs * QUIET_CAP_MULTIPLIER),
        signal,
        now,
        drain: () =>
          guarded(() => {
            const count = resnapshot().length;
            const fresh = Math.max(0, count - lastCount);
            lastCount = count;
            return fresh;
          }, 0)
      });

      state.window = null;

      if (fatal !== null) {
        throw fatal;
      }

      return Object.freeze({
        ok: true,
        events,
        // A diff has no transactions, so there are none to report. Inventing a
        // synthetic id would let a derived rule claim attribution.
        harnessTxIds: Object.freeze([]),
        transactions: Object.freeze({}),
        warnings: state.capabilities.degraded,
        converge: convergeResult,
        quiet: quietResult
      });
    },

    onWindowOpen(op, options = {}) {
      return driver.openWindow({ ...options, op });
    },

    onWindowClose(op, options = {}) {
      return driver.closeWindow(op, options);
    },

    async drain(_window, ctx = {}) {
      throwIfAborted(contextSignal(ctx), "E_DB_DRAIN_ABORTED", "SQLite drain was aborted.");
      const handle = requireHandle("drain");
      const window = state.window;

      if (window === null) {
        return Object.freeze([]);
      }

      // Non destructive: a snapshot diff can be recomputed any number of times,
      // unlike a stream, which is consumed when it is drained.
      return diffAll(
        window.entities,
        keyColumnsFor(config, ctx),
        window.before,
        snapshotAll(handle, window.entities, window.tenantKey)
      );
    },

    async poll(_window, assertion = {}, options = {}) {
      const signal = contextSignal(options);
      throwIfAborted(signal, "E_DB_POLL_ABORTED", "SQLite poll was aborted.");
      const handle = requireHandle("poll");
      const entities = entitiesFor(config, options);
      const keyColumns = keyColumnsFor(config, options);
      const expect = Array.isArray(assertion.expect) ? assertion.expect : [];
      const before = state.window?.before ?? new Map();
      const tenantKey = state.window?.tenantKey ?? null;
      let events = Object.freeze([]);

      const result = await converge({
        timeoutMs: positiveMs(assertion.timeoutMs, DEFAULT_CONVERGE_TIMEOUT_MS),
        intervalMs: positiveMs(assertion.intervalMs, DEFAULT_CONVERGE_INTERVAL_MS),
        signal,
        now: options.now ?? Date.now,
        probe: () => {
          events = diffAll(entities, keyColumns, before, snapshotAll(handle, entities, tenantKey));
          return Object.freeze({ ok: expectationsMet(events, expect), value: events });
        }
      });

      return Object.freeze({ ok: result.ok, events, converge: result });
    },

    async teardown(_ctx = {}) {
      if (state.handle !== null) {
        state.handle.close();
        state.handle = null;
      }

      state.window = null;
      return Object.freeze({ ok: true });
    }
  };

  assertImplementsDbPort(driver);
  return Object.freeze(driver);
}
