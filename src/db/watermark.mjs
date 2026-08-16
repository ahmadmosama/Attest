import { AttestError } from "../errors.mjs";

export const WATERMARK_ENTITY = "attest.watermark";

const MARKERS = Object.freeze(["open", "close"]);
const REQUIRED_MARKER_FIELDS = Object.freeze(["runId", "scenarioId", "surface", "seq", "nonce"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClient(client, fnName) {
  if (client === null || typeof client !== "object" || typeof client.query !== "function") {
    throw new TypeError(`${fnName} requires a connected database client`);
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non empty string`);
  }
}

function assertSafeInteger(value, field) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
}

function markerKind(input) {
  const kind = input?.kind ?? input?.marker ?? input?.boundary;
  if (!MARKERS.includes(kind)) {
    throw new TypeError("watermark marker kind must be open or close");
  }
  return kind;
}

function assertMarkerInput(input) {
  if (!isPlainObject(input)) {
    throw new TypeError("watermark marker input must be an object");
  }

  for (const field of REQUIRED_MARKER_FIELDS) {
    if (field === "seq") {
      assertSafeInteger(input[field], field);
    } else {
      assertNonEmptyString(input[field], field);
    }
  }
}

function rowValue(row, camel, snake = camel) {
  if (!isPlainObject(row)) {
    return undefined;
  }

  return row[snake] ?? row[camel];
}

function markerRow(event) {
  if (event?.entity !== WATERMARK_ENTITY) {
    return null;
  }

  const row = event.after ?? event.key ?? {};
  return isPlainObject(row) ? row : null;
}

function matchesWindow(row, { runId, scenarioId, nonce }) {
  return (
    rowValue(row, "runId", "run_id") === runId &&
    rowValue(row, "scenarioId", "scenario_id") === scenarioId &&
    rowValue(row, "nonce") === nonce
  );
}

function rowMarkerKind(row) {
  return rowValue(row, "kind") ?? rowValue(row, "marker") ?? rowValue(row, "boundary");
}

function unfenced(absent, details = {}) {
  return new AttestError(
    "E_DB_WINDOW_UNFENCED",
    `Database change window is missing its ${absent} watermark marker.`,
    {
      absent,
      ...details
    }
  );
}

function normalizeWindowIdentity(input) {
  if (!isPlainObject(input)) {
    throw new TypeError("sliceWindow requires a window identity object");
  }

  assertNonEmptyString(input.runId, "runId");
  assertNonEmptyString(input.scenarioId, "scenarioId");
  assertNonEmptyString(input.nonce, "nonce");

  return Object.freeze({
    runId: input.runId,
    scenarioId: input.scenarioId,
    nonce: input.nonce
  });
}

function markerIndexes(events, identity) {
  let open = null;
  let close = null;
  const harnessTxIds = [];

  events.forEach((event, index) => {
    const row = markerRow(event);
    if (row === null || !matchesWindow(row, identity)) {
      return;
    }

    if (event.txId !== null && event.txId !== undefined) {
      harnessTxIds.push(event.txId);
    }

    const kind = rowMarkerKind(row);
    if (kind === "open") {
      open = open ?? index;
    } else if (kind === "close") {
      close = close ?? index;
    }
  });

  return Object.freeze({
    open,
    close,
    harnessTxIds: Object.freeze([...new Set(harnessTxIds)])
  });
}

function freezeSlice(result) {
  return Object.freeze({
    events: Object.freeze(result.events),
    harnessTxIds: Object.freeze(result.harnessTxIds)
  });
}

/**
 * Watermark fence helpers for database delta windows.
 *
 * The fence is made from Attest owned marker rows that appear inline in the
 * database change stream. The scenario change set is defined only by stream
 * order: events strictly after the open marker and strictly before the close
 * marker. Do not replace this with a timestamp range. PostgreSQL now() is the
 * transaction start time, timestamp defaults are evaluated at statement start,
 * and clocks between the harness host and database host can skew. Any timestamp
 * fence can silently include or exclude the wrong rows.
 */
export async function ensureWatermarkTable(client) {
  assertClient(client, "ensureWatermarkTable");

  await client.query("CREATE SCHEMA IF NOT EXISTS attest");
  await client.query(`
    CREATE TABLE IF NOT EXISTS attest.watermark (
      run_id text NOT NULL,
      scenario_id text NOT NULL,
      surface text NOT NULL,
      seq integer NOT NULL,
      nonce text NOT NULL,
      boundary text NOT NULL CHECK (boundary IN ('open', 'close')),
      created_at timestamptz,
      PRIMARY KEY (run_id, scenario_id, surface, seq, nonce, boundary)
    )
  `);
}

export async function writeMarker(client, input) {
  assertClient(client, "writeMarker");
  assertMarkerInput(input);

  const boundary = markerKind(input);
  await client.query("BEGIN");

  try {
    await client.query(
      `
        INSERT INTO attest.watermark (run_id, scenario_id, surface, seq, nonce, boundary)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [input.runId, input.scenarioId, input.surface, input.seq, input.nonce, boundary]
    );
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the write failure. Rollback can fail if the connection is gone.
    }
    throw error;
  }

  return Object.freeze({
    ok: true,
    runId: input.runId,
    scenarioId: input.scenarioId,
    surface: input.surface,
    seq: input.seq,
    nonce: input.nonce,
    boundary
  });
}

export function sliceWindow(events, input) {
  if (!Array.isArray(events)) {
    throw new TypeError("sliceWindow events must be an array");
  }

  const identity = normalizeWindowIdentity(input);
  const indexes = markerIndexes(events, identity);

  if (indexes.open === null) {
    throw unfenced("open", identity);
  }

  if (indexes.close === null) {
    throw unfenced("close", identity);
  }

  if (indexes.close <= indexes.open) {
    throw unfenced("close", {
      ...identity,
      reason: "close_before_open",
      openIndex: indexes.open,
      closeIndex: indexes.close
    });
  }

  const windowEvents = events
    .slice(indexes.open + 1, indexes.close)
    .filter((event) => event?.entity !== WATERMARK_ENTITY);

  return freezeSlice({
    events: windowEvents,
    harnessTxIds: indexes.harnessTxIds
  });
}
