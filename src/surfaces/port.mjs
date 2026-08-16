import { AttestError } from "../errors.mjs";

// execute() given an op whose capability was not declared MUST throw UnsupportedOpError.
// It must never return { ok: true }. A silently no-opped step is a green gate that verified nothing.

export const SURFACE_PORT_METHODS = Object.freeze([
  "describeCapabilities",
  "preflight",
  "open",
  "execute",
  "collectEvidence",
  "close"
]);

/**
 * Surface adapter contract:
 * describeCapabilities() returns a frozen surface capability descriptor.
 * preflight(ctx) returns { ok: true } or throws InfraError, it refuses rather than warns.
 * open(ctx) returns a session handle.
 * execute(session, planOp, { signal }) returns { ok: true, detail } or throws
 * UnsupportedOpError or AttestError. It must honour signal. It may additionally
 * return evidence, an array of artifact references already written to the bundle.
 * collectEvidence(session, kind, { bundle }) returns an artifact reference { kind, path, bytes }.
 * close(session) is idempotent and never throws on an already closed session.
 */
export function assertImplementsSurfacePort(adapter) {
  const missing = SURFACE_PORT_METHODS.filter((method) => typeof adapter?.[method] !== "function");

  if (missing.length > 0) {
    throw new AttestError("E_BAD_ADAPTER", "Surface adapter does not implement the port", {
      missing
    });
  }
}
