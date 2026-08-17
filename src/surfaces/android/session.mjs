import { randomUUID } from "node:crypto";

import { InfraError } from "../../errors.mjs";
import { createRedactor } from "../../evidence/redact.mjs";
import { converge } from "../../runtime/converge.mjs";
import { ADB_COMMANDS, buildAdbCommand } from "./commands.mjs";
import { runAdb, startAdb } from "./exec.mjs";
import { findByQuery, locateFailure, toAndroidQuery } from "./locate.mjs";
import { parseHierarchy } from "./hierarchy.mjs";

export const ANDROID_SESSION_DEFAULTS = Object.freeze({
  stepTimeoutMs: 30_000,
  // A uiautomator dump costs a device round trip, so the retry cadence is
  // coarser than the web adapter's 50ms DOM poll. It is still convergence, not
  // a fixed wait: the first successful match returns immediately.
  dumpIntervalMs: 250,
  recordSeconds: 180
});

function deviceFile(kind, extension) {
  // Unique per session so two scenarios on one device can never read each
  // other's dump. Hyphens are inside the accepted device path pattern.
  return `/sdcard/attest-${kind}-${randomUUID()}.${extension}`;
}

export function openAndroidSession({
  device,
  packageName = null,
  component = null,
  extras = null,
  bundle = null,
  secrets = [],
  stepTimeoutMs = ANDROID_SESSION_DEFAULTS.stepTimeoutMs,
  recordSeconds = ANDROID_SESSION_DEFAULTS.recordSeconds,
  deps = {},
  now = Date.now
} = {}) {
  const runtime = { runAdb, startAdb, ...deps };

  return Object.freeze({
    id: `android-session-${randomUUID()}`,
    serial: device.serial,
    adbPath: device.adbPath,
    packageName,
    component,
    extras,
    bundle,
    redactor: createRedactor({ secrets }),
    stepTimeoutMs,
    dumpIntervalMs: ANDROID_SESSION_DEFAULTS.dumpIntervalMs,
    recordSeconds,
    dumpPath: deviceFile("hierarchy", "xml"),
    recordingPath: deviceFile("recording", "mp4"),
    startedAt: now(),
    runtime
  });
}

/**
 * Run one adb command for this session's device.
 */
export function run(session, kind, input = {}, { signal, encoding = "utf8" } = {}) {
  return session.runtime.runAdb(
    buildAdbCommand(kind, { serial: session.serial, ...input }, { adbPath: session.adbPath }),
    { signal, encoding }
  );
}

/**
 * Dump and parse the current UI hierarchy.
 *
 * Two round trips: uiautomator writes an XML file on the device, then exec-out
 * streams it back on stdout. `exec-out cat` rather than `adb pull` is
 * deliberate: pull takes a host path, and a host path is exactly what MSYS
 * rewrote on this machine (ENV-VERIFIED). No host path, no rewrite.
 */
export async function dumpHierarchy(session, { signal } = {}) {
  await run(session, ADB_COMMANDS.uiDump, { devicePath: session.dumpPath }, { signal });
  // Read as bytes, not text. Captured text is capped at a megabyte, and a dump
  // of a dense screen can reach that. A truncated dump parses into a partial
  // tree, so a locator would report not found for an element that is on the
  // screen: a wrong answer with no error, which is the one outcome this
  // project exists to prevent.
  const result = await run(session, ADB_COMMANDS.readFile, { devicePath: session.dumpPath }, {
    signal,
    encoding: "buffer"
  });
  return parseHierarchy(result.stdout.toString("utf8"));
}

function convergeFailure(lastError) {
  // A dead device is infrastructure and must be reported as such. A dump that
  // merely did not contain the node yet is a scenario failure. Collapsing the
  // two is how an operator learns to ignore red.
  return lastError instanceof InfraError ? lastError : null;
}

/**
 * Converge on exactly one node for a locator.
 */
export async function resolveNode(
  session,
  locator,
  { signal, i = null, kind = null, requireVisible = true } = {}
) {
  const query = toAndroidQuery(locator);
  let last = null;

  const result = await converge({
    signal,
    timeoutMs: session.stepTimeoutMs,
    intervalMs: session.dumpIntervalMs,
    probe: async () => {
      const nodes = await dumpHierarchy(session, { signal });
      last = findByQuery(nodes, query, { requireVisible });
      return Object.freeze({ ok: last.ok === true, value: last });
    }
  });

  if (result.ok !== true) {
    const infra = convergeFailure(result.lastError);
    if (infra !== null) {
      throw infra;
    }

    throw locateFailure(last ?? Object.freeze({ reason: "not_found", matches: 0, description: query.description }), {
      i,
      kind
    });
  }

  return Object.freeze({
    node: result.value.node,
    query,
    convergeMs: result.elapsedMs,
    attempts: result.attempts
  });
}
