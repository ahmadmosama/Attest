import { randomUUID } from "node:crypto";

import { InfraError, UsageError } from "../../../errors.mjs";
import { defineDbCapabilities } from "../../../capabilities/db-caps.mjs";
import { converge, quietPeriod } from "../../../runtime/converge.mjs";
import { toChangeEventBatch } from "../../capture/binlog.mjs";
import { assertImplementsDbPort } from "../../port.mjs";
import { runMysqlPreflight } from "./preflight.mjs";

const DEFAULT_CONVERGE_TIMEOUT_MS = 10_000;
const DEFAULT_CONVERGE_INTERVAL_MS = 50;
const DEFAULT_QUIET_PERIOD_MS = 750;
const QUIET_CAP_MULTIPLIER = 4;

// The harness owned table the fence markers go into. A marker is a row like any
// other, so it appears in the binlog in order, which is what makes the window
// boundary causal rather than a wall clock guess.
export const WATERMARK_TABLE = "attest_watermark";

export function mysqlCapabilities({ beforeImages = "full", degraded = [] } = {}) {
  return defineDbCapabilities({
    driver: "mysql",
    capture: "binlog",
    deltaAssertion: true,
    boundedPolling: true,
    // The binlog is an ordered stream with commit grouping, so it carries the
    // same guarantees the Postgres replication stream does.
    ordering: true,
    txAttribution: true,
    watermarkFencing: "inline",
    beforeImages,
    transactionalTeardown: false,
    degraded
  });
}

function assertTarget(target) {
  if (target?.driver !== "mysql" || typeof target.database !== "string" || target.database.length === 0) {
    throw new UsageError("E_MYSQL_TARGET_INVALID", "MySQL driver requires a mysql:// target naming a database", {
      driver: target?.driver ?? null
    });
  }

  return target.database;
}

function isMarker(event, database, identity) {
  return (
    event.entity === `${database}.${WATERMARK_TABLE}` &&
    event.after?.run_id === identity.runId &&
    event.after?.scenario_id === identity.scenarioId &&
    event.after?.nonce === identity.nonce
  );
}

/**
 * Slice the binlog between this window's own markers.
 *
 * Identical to the Postgres and Mongo slices, for the identical reason: a
 * window fenced by wall clock time cannot tell a write that arrived late from a
 * write that belongs to the next scenario.
 */
export function sliceByMarkers(events, database, identity) {
  const openIndex = events.findIndex((event) => isMarker(event, database, identity) && event.after?.boundary === "open");
  const closeIndex = events.findIndex((event) => isMarker(event, database, identity) && event.after?.boundary === "close");

  if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex) {
    throw new InfraError("E_MYSQL_WINDOW_UNFENCED", "The binlog did not carry both window markers", {
      runId: identity.runId,
      scenarioId: identity.scenarioId,
      openSeen: openIndex !== -1,
      closeSeen: closeIndex !== -1,
      remediation:
        "The binlog reader may have connected after the window started, or the marker writes failed. Both are harness faults, not scenario failures."
    });
  }

  return Object.freeze(
    events.slice(openIndex + 1, closeIndex).filter((event) => event.entity !== `${database}.${WATERMARK_TABLE}`)
  );
}

function expectationsMet(events, expect) {
  return expect.every((expectation) => {
    const matches = events.filter(
      (event) => event.entity === expectation.entity && event.op === expectation.op
    ).length;
    return matches >= (expectation.count ?? 1);
  });
}

function positiveMs(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * The MySQL database driver.
 *
 * Capture is the ROW format binlog, which is MySQL's logical replication
 * stream, so the classifier consumes the same ChangeEvent shape it consumes
 * from Postgres. A server in STATEMENT or MIXED format is refused at preflight
 * rather than degraded, because SQL text cannot yield per row images and a run
 * that captured nothing reports no unexplained changes.
 *
 * Every client call is injected, so the refusals, the fencing, the slicing and
 * the convergence are all assertable with no MySQL anywhere.
 */
export function createMysqlDriver({ target, config = {}, runId, scenarioId, dependencies = {} } = {}) {
  const database = assertTarget(target);
  const state = { capabilities: null, preflight: null, window: null, events: [], seq: 0, reader: null };

  function requireReady(operation) {
    if (state.preflight === null) {
      throw new InfraError("E_DB_DRIVER_NOT_READY", `MySQL ${operation} requires preflight to have run.`, {
        operation,
        runId,
        scenarioId
      });
    }
  }

  async function drainBinlog({ signal } = {}) {
    if (typeof dependencies.readBinlog !== "function") {
      return 0;
    }

    const rowEvents = (await dependencies.readBinlog({ signal })) ?? [];
    const translated = toChangeEventBatch(rowEvents, {
      keyColumns: config.keyColumns ?? {},
      startSeq: state.seq,
      rowImage: state.preflight?.rowImage ?? "full",
      actorFor: config.actorFor
    });

    state.events.push(...translated);
    state.seq += translated.length;
    return translated.length;
  }

  async function writeMarker(boundary, identity, { signal } = {}) {
    if (typeof dependencies.insertMarker !== "function") {
      throw new InfraError("E_MYSQL_CLIENT_MISSING", "No MySQL client is wired in", {
        remediation:
          "Install and inject the MySQL client. The driver keeps it behind an injected seam so fencing and slicing stay testable without a server."
      });
    }

    return dependencies.insertMarker(
      {
        table: WATERMARK_TABLE,
        row: {
          run_id: identity.runId,
          scenario_id: identity.scenarioId,
          surface: identity.surface,
          seq: identity.seq,
          nonce: identity.nonce,
          boundary
        }
      },
      { signal }
    );
  }

  const driver = {
    describeCapabilities() {
      if (state.capabilities === null) {
        throw new InfraError("E_DB_CAPABILITIES_NOT_READY", "MySQL capabilities are not known until preflight runs.", {
          driver: "mysql"
        });
      }

      return state.capabilities;
    },

    async preflight(ctx = {}) {
      const result = await runMysqlPreflight({
        variables: dependencies.variables,
        grants: dependencies.grants,
        signal: ctx.signal
      });

      state.preflight = result;
      state.capabilities = mysqlCapabilities({
        beforeImages: result.beforeImages,
        degraded: result.degraded
      });

      if (typeof dependencies.openBinlog === "function") {
        state.reader = await dependencies.openBinlog({ signal: ctx.signal });
      }

      return Object.freeze({ ok: true, capabilities: state.capabilities, binlogFormat: result.binlogFormat });
    },

    async openWindow(ctx = {}) {
      requireReady("openWindow");
      const op = ctx.op ?? ctx;
      const identity = Object.freeze({
        runId,
        scenarioId: op.scenarioId ?? scenarioId,
        surface: op.surface ?? config.surface ?? "db",
        seq: op.seq ?? 0,
        nonce: randomUUID()
      });

      state.events = [];
      state.seq = 0;
      await writeMarker("open", identity, { signal: ctx.signal });
      state.window = identity;
      return identity;
    },

    async closeWindow(windowHandle = null, ctx = {}) {
      requireReady("closeWindow");
      const identity = windowHandle?.nonce === undefined ? state.window : windowHandle;

      if (identity === null || identity === undefined) {
        throw new InfraError("E_DB_WINDOW_NOT_OPEN", "MySQL closeWindow has no open window.", { runId, scenarioId });
      }

      const op = windowHandle?.kind === "db_window_close" ? windowHandle : ctx.op ?? ctx;
      const expect = Array.isArray(op?.expect) ? op.expect : [];
      const signal = ctx.signal;
      const now = ctx.now ?? config.now ?? Date.now;
      let fatal = null;

      async function guarded(work, satisfied) {
        if (fatal !== null) {
          return satisfied;
        }

        try {
          return await work();
        } catch (error) {
          // An unparseable event can never become parseable by waiting, so
          // convergence stops rather than spending the budget and then
          // reporting an empty delta.
          fatal = error;
          return satisfied;
        }
      }

      const convergeResult = await converge({
        timeoutMs: positiveMs(op.convergeTimeoutMs, DEFAULT_CONVERGE_TIMEOUT_MS),
        intervalMs: positiveMs(op.convergeIntervalMs, DEFAULT_CONVERGE_INTERVAL_MS),
        signal,
        now,
        probe: () =>
          guarded(async () => {
            await drainBinlog({ signal });
            return Object.freeze({ ok: expectationsMet(state.events, expect) });
          }, Object.freeze({ ok: true }))
      });

      if (fatal !== null) {
        throw fatal;
      }

      await writeMarker("close", identity, { signal });

      const quietMs = positiveMs(op.quietPeriodMs, DEFAULT_QUIET_PERIOD_MS);
      const quietResult = await quietPeriod({
        quietMs,
        capMs: positiveMs(op.quietPeriodCapMs, quietMs * QUIET_CAP_MULTIPLIER),
        signal,
        now,
        drain: () => guarded(() => drainBinlog({ signal }), 0)
      });

      if (fatal !== null) {
        throw fatal;
      }

      const events = sliceByMarkers(state.events, database, identity);
      state.window = null;

      return Object.freeze({
        ok: true,
        events,
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
      requireReady("drain");
      await drainBinlog({ signal: ctx.signal });
      return Object.freeze([...state.events]);
    },

    async poll(_window, assertion = {}, options = {}) {
      requireReady("poll");
      const expect = Array.isArray(assertion.expect) ? assertion.expect : [];

      const result = await converge({
        timeoutMs: assertion.timeoutMs ?? DEFAULT_CONVERGE_TIMEOUT_MS,
        intervalMs: assertion.intervalMs ?? DEFAULT_CONVERGE_INTERVAL_MS,
        signal: options.signal,
        now: options.now ?? Date.now,
        probe: async () => {
          await drainBinlog({ signal: options.signal });
          return Object.freeze({ ok: expectationsMet(state.events, expect) });
        }
      });

      return Object.freeze({ ok: result.ok, events: Object.freeze([...state.events]), converge: result });
    },

    async teardown(ctx = {}) {
      if (state.reader !== null && typeof dependencies.closeBinlog === "function") {
        try {
          await dependencies.closeBinlog(state.reader, { signal: ctx.signal });
        } catch {
          // Teardown is best effort and must never mask a run result.
        }
      }

      state.reader = null;
      state.window = null;
      state.events = [];
      state.preflight = null;
      return Object.freeze({ ok: true });
    }
  };

  assertImplementsDbPort(driver);
  return Object.freeze(driver);
}
