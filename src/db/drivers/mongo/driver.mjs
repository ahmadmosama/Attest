import { randomUUID } from "node:crypto";

import { InfraError, UsageError } from "../../../errors.mjs";
import { converge, quietPeriod } from "../../../runtime/converge.mjs";
import { isLifecycleEvent, toChangeEvent } from "../../capture/change-stream.mjs";
import { assertImplementsDbPort } from "../../port.mjs";
import { mongoCapabilities } from "./capabilities.mjs";
import { runMongoPreflight } from "./preflight.mjs";

const DEFAULT_CONVERGE_TIMEOUT_MS = 10_000;
const DEFAULT_CONVERGE_INTERVAL_MS = 50;
const DEFAULT_QUIET_PERIOD_MS = 750;
const QUIET_CAP_MULTIPLIER = 4;

// The harness owned collection the fence markers go into. A marker is a
// document like any other, so the stream sees it in order, which is what makes
// the window boundary causal rather than a wall clock guess.
export const WATERMARK_COLLECTION = "attest_watermark";

function assertTarget(target) {
  if (target?.driver !== "mongo" || typeof target.database !== "string" || target.database.length === 0) {
    throw new UsageError("E_MONGO_TARGET_INVALID", "Mongo driver requires a mongodb:// target naming a database", {
      driver: target?.driver ?? null
    });
  }

  return target.database;
}

function notReady(operation, runId, scenarioId) {
  return new InfraError("E_DB_DRIVER_NOT_READY", `Mongo ${operation} requires preflight to have run.`, {
    operation,
    runId,
    scenarioId
  });
}

function isMarker(event, database, identity) {
  return (
    event.entity === `${database}.${WATERMARK_COLLECTION}` &&
    event.after?.runId === identity.runId &&
    event.after?.scenarioId === identity.scenarioId &&
    event.after?.nonce === identity.nonce
  );
}

function boundaryOf(event) {
  return event.after?.boundary ?? null;
}

/**
 * Slice the stream between this window's own open and close markers.
 *
 * Identical in shape to the Postgres watermark slice, and for the same reason:
 * a window fenced by wall clock time cannot tell a write that arrived late from
 * a write that belongs to the next scenario.
 */
export function sliceByMarkers(events, database, identity) {
  const openIndex = events.findIndex(
    (event) => isMarker(event, database, identity) && boundaryOf(event) === "open"
  );
  const closeIndex = events.findIndex(
    (event) => isMarker(event, database, identity) && boundaryOf(event) === "close"
  );

  if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex) {
    throw new InfraError("E_MONGO_WINDOW_UNFENCED", "The change stream did not carry both window markers", {
      runId: identity.runId,
      scenarioId: identity.scenarioId,
      openSeen: openIndex !== -1,
      closeSeen: closeIndex !== -1,
      remediation:
        "The stream may have been opened after the window started, or the marker writes failed. Both are harness faults, not scenario failures."
    });
  }

  return Object.freeze(
    events
      .slice(openIndex + 1, closeIndex)
      .filter((event) => event.entity !== `${database}.${WATERMARK_COLLECTION}`)
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
 * The MongoDB driver.
 *
 * Capture is a change stream, which is the cleanest signal of the five engines.
 * A standalone deployment cannot provide one, and is refused by name at
 * preflight rather than degraded to polling (correction C4).
 *
 * Every client call is injected, so the topology refusal, the marker fencing,
 * the slicing and the convergence are all assertable with no Mongo anywhere.
 */
export function createMongoDriver({ target, config = {}, runId, scenarioId, dependencies = {} } = {}) {
  const database = assertTarget(target);
  const state = {
    capabilities: null,
    preflight: null,
    stream: null,
    window: null,
    events: [],
    seq: 0
  };

  function requireReady(operation) {
    if (state.preflight === null) {
      throw notReady(operation, runId, scenarioId);
    }
  }

  async function drainStream({ signal } = {}) {
    if (typeof dependencies.readStream !== "function") {
      return 0;
    }

    const documents = await dependencies.readStream({ signal });
    let added = 0;

    for (const document of documents ?? []) {
      // A dropped or renamed collection breaks the window's assumptions, so it
      // is surfaced rather than filtered out. "The collection went away" is not
      // "nothing changed".
      if (isLifecycleEvent(document)) {
        toChangeEvent(document, { seq: state.seq });
      }

      state.events.push(toChangeEvent(document, { seq: state.seq, actorFor: config.actorFor }));
      state.seq += 1;
      added += 1;
    }

    return added;
  }

  async function writeMarker(boundary, identity, { signal } = {}) {
    if (typeof dependencies.insertMarker !== "function") {
      throw new InfraError("E_MONGO_CLIENT_MISSING", "No MongoDB client is wired in", {
        remediation:
          "Install and inject the MongoDB client. The driver keeps it behind an injected seam so fencing and slicing stay testable without a server."
      });
    }

    return dependencies.insertMarker(
      {
        collection: WATERMARK_COLLECTION,
        document: { ...identity, boundary, surface: identity.surface }
      },
      { signal }
    );
  }

  const driver = {
    describeCapabilities() {
      if (state.capabilities === null) {
        throw new InfraError("E_DB_CAPABILITIES_NOT_READY", "Mongo capabilities are not known until preflight runs.", {
          driver: "mongo"
        });
      }

      return state.capabilities;
    },

    async preflight(ctx = {}) {
      const result = await runMongoPreflight({
        hello: dependencies.hello,
        canChangeStream: dependencies.canChangeStream,
        signal: ctx.signal
      });

      state.preflight = result;
      state.capabilities = mongoCapabilities({ preImagesEnabled: result.preImagesEnabled });
      return Object.freeze({ ok: true, capabilities: state.capabilities, topology: result.topology });
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

      // The stream opens BEFORE the marker is written, so the marker itself is
      // guaranteed to appear in it. Opening afterwards would race, and a window
      // that lost its own open marker cannot be sliced at all.
      if (typeof dependencies.openStream === "function") {
        state.stream = await dependencies.openStream({ signal: ctx.signal });
      }

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
        throw new InfraError("E_DB_WINDOW_NOT_OPEN", "Mongo closeWindow has no open window.", {
          runId,
          scenarioId
        });
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
          // A parse refusal or a dropped collection can never resolve by
          // waiting, so convergence stops instead of spending the whole budget
          // and then reporting an empty delta.
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
            await drainStream({ signal });
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
        drain: () => guarded(() => drainStream({ signal }), 0)
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
      await drainStream({ signal: ctx.signal });
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
          await drainStream({ signal: options.signal });
          return Object.freeze({ ok: expectationsMet(state.events, expect) });
        }
      });

      return Object.freeze({ ok: result.ok, events: Object.freeze([...state.events]), converge: result });
    },

    async teardown(ctx = {}) {
      if (state.stream !== null && typeof dependencies.closeStream === "function") {
        try {
          await dependencies.closeStream(state.stream, { signal: ctx.signal });
        } catch {
          // Teardown is best effort and must never mask a run result.
        }
      }

      state.stream = null;
      state.window = null;
      state.events = [];
      state.preflight = null;
      return Object.freeze({ ok: true });
    }
  };

  assertImplementsDbPort(driver);
  return Object.freeze(driver);
}
