import { assertImplementsDbPort } from "../../port.mjs";
import { createLogicalSlotCapture } from "../../capture/logical-slot.mjs";
import { selectCaptureStrategy } from "../../capture/strategy.mjs";
import { AttestError, InfraError, UnsupportedOpError } from "../../../errors.mjs";
import { createPgClient } from "./connect.mjs";
import { runPreflight } from "./preflight.mjs";
import {
  createSlot,
  dropSlot,
  slotNameFor,
  sweepOrphanSlots
} from "./slots.mjs";

const DEFAULT_BATCH_SIZE = 1000;
const FENCING_PLAN = "03-11";

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeTargetDetails(target) {
  return Object.freeze({
    host: target?.host ?? null,
    database: target?.database ?? null,
    port: target?.port ?? null
  });
}

function contextSignal(ctx, fallback) {
  return ctx?.signal ?? fallback ?? null;
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

  if (Array.isArray(config?.entities)) {
    return config.entities;
  }

  return [];
}

function keyColumnsFor(config, ctx) {
  return ctx?.keyColumns ?? config?.keyColumns;
}

function surfaceFor(config, ctx) {
  return ctx?.surface ?? config?.surface ?? "db";
}

function batchSizeFor(config, ctx) {
  const value = ctx?.batchSize ?? config?.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Postgres driver batchSize must be a positive safe integer");
  }
  return value;
}

function notImplemented(method) {
  return new UnsupportedOpError(
    "E_NOT_IMPLEMENTED",
    `PostgreSQL ${method} is owned by Phase ${FENCING_PLAN} fencing and convergence, and is not implemented in plan 03-09.`,
    {
      method,
      plannedPhase: FENCING_PLAN
    }
  );
}

function captureUnavailable(capabilities, error) {
  return new InfraError("E_DB_CAPTURE_UNSUPPORTED", "PostgreSQL logical slot capture is unavailable.", {
    capture: capabilities?.capture ?? "unknown",
    driver: capabilities?.driver ?? "postgres",
    causeCode: error?.code ?? null,
    causeMessage: error instanceof Error ? error.message : String(error)
  });
}

async function closeClient(client) {
  if (client === null) {
    return;
  }

  await client.end();
}

function defaultDependencies() {
  return Object.freeze({
    assertImplementsDbPort,
    createLogicalSlotCapture,
    createPgClient,
    createSlot,
    dropSlot,
    runPreflight,
    selectCaptureStrategy,
    slotNameFor,
    sweepOrphanSlots
  });
}

function mergeDependencies(dependencies) {
  if (dependencies === undefined || dependencies === null) {
    return defaultDependencies();
  }

  if (!isPlainObject(dependencies)) {
    throw new TypeError("Postgres driver dependencies must be an object");
  }

  return Object.freeze({
    ...defaultDependencies(),
    ...dependencies
  });
}

function assertTarget(target) {
  if (target === null || typeof target !== "object") {
    throw new TypeError("createPostgresDriver requires a resolved target");
  }
}

function assertRunIdentity(runId, scenarioId) {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new TypeError("createPostgresDriver requires a runId");
  }

  if (typeof scenarioId !== "string" || scenarioId.length === 0) {
    throw new TypeError("createPostgresDriver requires a scenarioId");
  }
}

function assertPreflightReady(state) {
  if (state.capture === null || state.slotName === null || state.client === null) {
    throw new InfraError("E_DB_DRIVER_NOT_READY", "PostgreSQL driver preflight has not opened a capture slot.", {
      hasClient: state.client !== null,
      hasSlot: state.slotName !== null,
      hasCapture: state.capture !== null
    });
  }
}

function capabilitiesNotReady() {
  return new AttestError(
    "E_DB_CAPABILITIES_UNAVAILABLE",
    "PostgreSQL capabilities are unavailable until preflight succeeds.",
    {
      driver: "postgres"
    }
  );
}

/**
 * Assemble the Postgres database driver behind the Phase 1 port.
 *
 * Plan 03-09 owns the logical slot lifecycle and capture strategy. Fencing,
 * closing, and convergence polling are explicit Phase 03-11 seams, surfaced as
 * named not implemented errors without changing the port shape.
 */
export function createPostgresDriver({
  target,
  config = {},
  runId,
  scenarioId,
  dependencies
} = {}) {
  assertTarget(target);
  assertRunIdentity(runId, scenarioId);

  const deps = mergeDependencies(dependencies);
  const state = {
    client: null,
    slotName: null,
    capture: null,
    capabilities: null,
    preflightResult: null,
    closed: false
  };

  const driver = {
    describeCapabilities() {
      if (state.capabilities === null) {
        throw capabilitiesNotReady();
      }

      return state.capabilities;
    },

    async preflight(ctx = {}) {
      const signal = contextSignal(ctx);
      throwIfAborted(signal, "E_DB_PREFLIGHT_ABORTED", "PostgreSQL driver preflight was aborted.");

      try {
        const preflightResult = await deps.runPreflight({
          target,
          entities: entitiesFor(config, ctx),
          signal
        });
        state.preflightResult = preflightResult;
        state.capabilities = preflightResult.capabilities;

        try {
          deps.selectCaptureStrategy(state.capabilities);
        } catch (error) {
          throw captureUnavailable(state.capabilities, error);
        }

        const slotName = deps.slotNameFor({
          runId,
          scenarioId,
          surface: surfaceFor(config, ctx)
        });
        state.client = await deps.createPgClient(target, { signal });
        await deps.sweepOrphanSlots(state.client, {
          keep: [],
          signal,
          logger: ctx.logger ?? config.logger
        });
        await deps.createSlot(state.client, slotName, { signal });
        state.slotName = slotName;
        state.capture = deps.createLogicalSlotCapture({
          client: state.client,
          slotName,
          keyColumns: keyColumnsFor(config, ctx),
          actorFor: ctx.actorFor ?? config.actorFor,
          batchSize: batchSizeFor(config, ctx)
        });
        state.closed = false;

        return Object.freeze({
          ok: true
        });
      } catch (error) {
        await driver.teardown(ctx);
        throw error;
      }
    },

    async openWindow(ctx = {}) {
      throwIfAborted(
        contextSignal(ctx),
        "E_DB_OPEN_WINDOW_ABORTED",
        "PostgreSQL openWindow was aborted."
      );
      throw notImplemented("openWindow");
    },

    async closeWindow(_window, ctx = {}) {
      throwIfAborted(
        contextSignal(ctx),
        "E_DB_CLOSE_WINDOW_ABORTED",
        "PostgreSQL closeWindow was aborted."
      );
      throw notImplemented("closeWindow");
    },

    async drain(_window, ctx = {}) {
      const signal = contextSignal(ctx);
      throwIfAborted(signal, "E_DB_DRAIN_ABORTED", "PostgreSQL drain was aborted.");
      assertPreflightReady(state);
      const result = await state.capture.drain({
        signal
      });
      return result.events;
    },

    async poll(_window, _assertion, options = {}) {
      throwIfAborted(
        contextSignal(options),
        "E_DB_POLL_ABORTED",
        "PostgreSQL poll was aborted."
      );
      throw notImplemented("poll");
    },

    async teardown(_ctx = {}) {
      const errors = [];

      if (state.slotName !== null && state.client !== null) {
        try {
          await deps.dropSlot(state.client, state.slotName);
        } catch (error) {
          errors.push(error);
        }
      }

      if (state.client !== null) {
        try {
          await closeClient(state.client);
        } catch (error) {
          errors.push(
            new InfraError("E_DB_CLIENT_CLOSE", "Failed to close PostgreSQL client.", {
              ...safeTargetDetails(target),
              causeMessage: error instanceof Error ? error.message : String(error)
            })
          );
        }
      }

      state.client = null;
      state.slotName = null;
      state.capture = null;
      state.closed = true;

      if (errors.length > 0) {
        throw errors[0];
      }

      return Object.freeze({
        ok: true
      });
    }
  };

  deps.assertImplementsDbPort(driver);
  return Object.freeze(driver);
}
