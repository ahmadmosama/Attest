import { AttestError } from "../errors.mjs";

export const DB_PORT_METHODS = Object.freeze([
  "describeCapabilities",
  "preflight",
  "openWindow",
  "closeWindow",
  "drain",
  "poll",
  "teardown"
]);

/**
 * Database driver contract:
 * describeCapabilities() is the first thing a driver produces and returns a frozen
 * database capability descriptor. The lowerer consumes that descriptor so an
 * unsupported delta assertion is structural, not a documentation promise.
 * preflight(ctx) returns { ok: true } or throws InfraError.
 * openWindow(ctx) writes or records the opening fence and returns a window handle.
 * closeWindow(window, ctx) writes or records the closing fence and returns close metadata.
 * drain(window, ctx) returns normalized ChangeEvent records collected so far.
 * poll(window, assertion, { signal }) performs bounded convergence polling.
 * teardown(ctx) releases driver owned state and may be called after partial failure.
 */
export function assertImplementsDbPort(driver) {
  const missing = DB_PORT_METHODS.filter((method) => typeof driver?.[method] !== "function");

  if (missing.length > 0) {
    throw new AttestError("E_BAD_ADAPTER", "Database driver does not implement the port", {
      missing
    });
  }
}
