import { randomUUID } from "node:crypto";

import { AttestError, InfraError, UnsupportedOpError } from "../../errors.mjs";
import { assertKnownCapability } from "../../capabilities/registry.mjs";
import { capabilitiesFor, OP_CAPABILITIES } from "../../ir/ops.mjs";
import { converge } from "../../runtime/converge.mjs";
import { createRedactor } from "../../evidence/redact.mjs";
import { assertImplementsSurfacePort } from "../port.mjs";
import { iosSurfaceCapabilities } from "./capabilities.mjs";
import { IOS_COMMANDS, buildSimctlCommand } from "./commands.mjs";
import { findByQuery, locateFailure, tapPoint, toIosQuery } from "./locate.mjs";

const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const QUERY_INTERVAL_MS = 250;
const EVIDENCE_DIR = "evidence";

// Same table the web and Android adapters use. Re-deriving what an op demands
// per adapter is how two adapters end up disagreeing about the same scenario.
const SOURCE_KIND_FOR_PLAN_KIND = Object.freeze({
  navigate: "open",
  back: "back",
  app_background: "background",
  app_foreground: "foreground",
  click: "tap",
  long_press: "long_press",
  fill: "fill",
  clear: "clear",
  press_key: "press_key",
  swipe: "swipe",
  scroll_until_visible: "scroll_until_visible",
  select_option: "select_option",
  upload_file: "upload_file",
  set_permission: "set_permission",
  set_network: "set_network",
  set_clipboard: "set_clipboard",
  expect_visible: "expect_visible",
  expect_hidden: "expect_hidden",
  expect_text: "expect_text",
  expect_state: "expect_state",
  expect_count: "expect_count",
  checkpoint: "checkpoint",
  raw: "raw"
});

const ACT_KINDS = new Set([
  "navigate",
  "back",
  "click",
  "long_press",
  "fill",
  "clear",
  "press_key",
  "swipe",
  "scroll_until_visible",
  "select_option",
  "upload_file",
  "set_permission",
  "set_network",
  "set_clipboard",
  "app_background",
  "app_foreground",
  "raw"
]);

const ASSERT_KINDS = new Set(["expect_visible", "expect_hidden", "expect_text", "expect_state", "expect_count"]);
const ACCEPTED_STATES = Object.freeze(["enabled", "disabled", "checked", "unchecked", "focused"]);

function abortReason(signal) {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw abortReason(signal);
  }
}

function opKind(planOp) {
  if (planOp === null || typeof planOp !== "object" || Array.isArray(planOp)) {
    throw new UnsupportedOpError("E_UNSUPPORTED_OP", "iOS plan op must be an object", { kind: "<unknown>" });
  }

  return typeof planOp.kind === "string" && planOp.kind.length > 0 ? planOp.kind : "<unknown>";
}

function demandedCapabilities(planOp) {
  if (planOp.capabilities !== undefined) {
    if (!Array.isArray(planOp.capabilities)) {
      throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Plan op capabilities must be an array", {
        i: planOp.i,
        kind: opKind(planOp)
      });
    }

    return Object.freeze(planOp.capabilities.map((capability) => assertKnownCapability(capability)));
  }

  const sourceKind = SOURCE_KIND_FOR_PLAN_KIND[opKind(planOp)];
  if (sourceKind === undefined || OP_CAPABILITIES[sourceKind] === undefined) {
    return Object.freeze([]);
  }

  // The whole plan op, never planOp.value, for the reason the other two
  // adapters carry in the same place: a fill's value is text, not a SemanticRef.
  return capabilitiesFor(sourceKind, planOp);
}

function assertCapabilitiesSupported(descriptor, planOp) {
  const missing = demandedCapabilities(planOp).filter((capability) => !descriptor.has(capability));

  if (missing.length > 0) {
    throw new UnsupportedOpError("E_UNSUPPORTED_OP", "iOS surface does not support plan op", {
      i: planOp.i,
      kind: opKind(planOp),
      missing
    });
  }
}

function safeSegment(value) {
  const safe = String(value ?? "unknown").replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return safe.slice(0, 80) || "unknown";
}

function okDetail(op, detail = {}) {
  return Object.freeze({ ok: true, detail: Object.freeze({ i: op.i, kind: op.kind, ...detail }) });
}

function stateOf(element, state) {
  switch (state) {
    case "enabled":
      return element.enabled !== false;
    case "disabled":
      return element.enabled === false;
    case "checked":
      return element.value === "1" || element.selected === true;
    case "unchecked":
      return element.value === "0" || element.selected === false;
    case "focused":
      return element.hasFocus === true;
    default:
      throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported iOS assertion state", {
        state,
        accepted: ACCEPTED_STATES
      });
  }
}

// An element's accessible text is its label, falling back to its value, which
// is where a text field keeps what was typed into it.
function accessibleText(element) {
  return String(element.label?.length > 0 ? element.label : element.value ?? "").trim();
}

/**
 * The iOS surface adapter.
 *
 * It is written on Windows, where it cannot run, which is the whole point of
 * IOS-02: an adapter exercised only on CI rots between runs and the rot is
 * invisible until the one time it matters. Every seam that touches the
 * simulator is injected, so command construction, locate, ambiguity refusal,
 * tap arithmetic and evidence writing are all asserted here, and only the
 * simulator itself is absent.
 */
export function createIosSurface(options = {}) {
  const descriptor = iosSurfaceCapabilities();
  const lease = options.lease ?? null;
  const bundleId = options.bundleId ?? null;
  const deps = options.deps ?? {};
  const closedSessions = new WeakSet();
  const failedSessions = new WeakSet();

  function requireSimctl() {
    if (typeof deps.runSimctl !== "function") {
      throw new InfraError("E_IOS_SIMCTL_MISSING", "No simctl runner is available", {
        remediation:
          "iOS executes only on a macOS runner. On any other host the adapter is exercised through an injected transport, which is IOS-02."
      });
    }

    return deps.runSimctl;
  }

  async function run(session, kind, input = {}, { signal, encoding = "utf8" } = {}) {
    const command = buildSimctlCommand(kind, {
      xcodeVersion: session.xcodeVersion,
      runtimeName: session.runtimeName,
      runtimeVersion: session.runtimeVersion,
      // The Phase 4 command layer calls the booted simulator `device`, and the
      // lease calls it `deviceId`. Bridged here rather than renaming either:
      // the command layer's transcripts are committed and pinned.
      device: session.deviceId,
      deviceId: session.deviceId,
      bundleId: session.bundleId,
      ...input
    });

    return requireSimctl()(command, { signal, encoding });
  }

  async function describeElements(session, { signal } = {}) {
    if (typeof deps.describeElements !== "function") {
      throw new InfraError("E_IOS_ACCESSIBILITY_UNAVAILABLE", "No accessibility tree source is available", {
        remediation: "The accessibility tree comes from the CI harness on the macOS runner."
      });
    }

    const elements = await deps.describeElements({ deviceId: session.deviceId, signal });
    return Array.isArray(elements) ? elements : [];
  }

  async function resolveElement(session, locator, { signal, i = null, kind = null, requireVisible = true } = {}) {
    const query = toIosQuery(locator);
    let last = null;
    let fatal = null;

    const result = await converge({
      signal,
      timeoutMs: session.stepTimeoutMs,
      intervalMs: QUERY_INTERVAL_MS,
      probe: async () => {
        if (fatal !== null) {
          return Object.freeze({ ok: true });
        }

        try {
          last = findByQuery(await describeElements(session, { signal }), query, { requireVisible });
          return Object.freeze({ ok: last.ok === true, value: last });
        } catch (error) {
          // A simulator that went away can never come back inside this step, so
          // convergence stops rather than reporting a locator miss for a reason
          // that has nothing to do with the locator.
          fatal = error;
          return Object.freeze({ ok: true });
        }
      }
    });

    if (fatal !== null) {
      throw fatal;
    }

    if (result.ok !== true) {
      throw locateFailure(last ?? { reason: "not_found", matches: 0, description: query.description }, { i, kind });
    }

    return Object.freeze({ element: result.value.element, query, convergeMs: result.elapsedMs });
  }

  async function captureScreenshot(session, name) {
    try {
      const relPath = `${EVIDENCE_DIR}/${safeSegment(name)}.png`;
      const result = await run(session, IOS_COMMANDS.screenshot, {
        screenshotPath: `${session.screenshotDir}/${safeSegment(name)}.png`
      });

      if (session.bundle === null || typeof session.bundle.write !== "function") {
        return null;
      }

      return await session.bundle.write(relPath, result?.bytes ?? result?.stdout ?? "");
    } catch {
      // Evidence capture must never replace the real scenario result.
      return null;
    }
  }

  const adapter = {
    describeCapabilities() {
      return descriptor;
    },

    async preflight(_ctx, { signal } = {}) {
      throwIfAborted(signal);

      if (lease === null || typeof lease.acquire !== "function") {
        throw new InfraError("E_IOS_NO_SIMULATOR", "iOS surface has no simulator lease", {
          remediation:
            "iOS runs on a GitHub Actions macOS runner with a pinned Xcode and runtime. It cannot run on this host."
        });
      }

      await lease.acquire({ signal });
      throwIfAborted(signal);
      return Object.freeze({ ok: true });
    },

    async open(ctx, { signal } = {}) {
      throwIfAborted(signal);

      if (lease === null || typeof lease.acquire !== "function") {
        throw new InfraError("E_IOS_NO_SIMULATOR", "iOS surface has no simulator lease", {
          remediation: "iOS runs on a macOS runner only."
        });
      }

      const device = await lease.acquire({ signal });

      return Object.freeze({
        id: `ios-session-${randomUUID()}`,
        deviceId: device.deviceId,
        xcodeVersion: device.xcodeVersion,
        runtimeName: device.runtimeName,
        runtimeVersion: device.runtimeVersion,
        bundleId: bundleId ?? device.bundleId ?? null,
        bundle: ctx?.bundle ?? null,
        redactor: createRedactor({ secrets: options.secrets ?? [] }),
        stepTimeoutMs: ctx?.timeouts?.stepMs ?? DEFAULT_STEP_TIMEOUT_MS,
        screenshotDir: device.screenshotDir ?? "/tmp/attest-ios"
      });
    },

    execute(session, planOp, { signal } = {}) {
      if (closedSessions.has(session)) {
        throw new AttestError("E_SESSION_CLOSED", "iOS surface session is closed", { sessionId: session?.id });
      }

      throwIfAborted(signal);
      const kind = opKind(planOp);
      assertCapabilitiesSupported(descriptor, planOp);

      if (kind === "checkpoint") {
        const label = safeSegment(planOp.label ?? "checkpoint");
        return captureScreenshot(session, `step-${planOp.i}-checkpoint-${label}`).then((reference) =>
          Object.freeze({
            ok: true,
            detail: Object.freeze({ i: planOp.i, kind, label }),
            evidence: Object.freeze(reference === null ? [] : [reference])
          })
        );
      }

      if (kind === "db_window_open" || kind === "db_window_close") {
        throw new AttestError("E_DB_OP_AT_SURFACE", "Database window op reached ios surface adapter", {
          i: planOp.i,
          kind
        });
      }

      if (ASSERT_KINDS.has(kind)) {
        return executeAssert(session, planOp, { signal });
      }

      if (ACT_KINDS.has(kind)) {
        return executeAct(session, planOp, { signal });
      }

      throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported ios plan op", { i: planOp.i, kind });
    },

    async collectEvidence(session, kind) {
      if (kind !== "failure") {
        return null;
      }

      failedSessions.add(session);
      return captureScreenshot(session, "failure");
    },

    async close(session) {
      if (session !== null && typeof session === "object") {
        closedSessions.add(session);
      }

      return Object.freeze({ ok: true });
    }
  };

  async function executeAct(session, op, { signal }) {
    switch (op.kind) {
      case "navigate": {
        // A simulator has no URL bar. A screen is reached by launching the app,
        // optionally with the deeplink the bindings declared.
        await run(session, IOS_COMMANDS.launchApp, {}, { signal });
        if (op.ready === undefined) {
          return okDetail(op, { deeplink: op.target?.deeplink ?? null });
        }

        const ready = await resolveElement(session, op.ready, { signal, i: op.i, kind: op.kind });
        return okDetail(op, { deeplink: op.target?.deeplink ?? null, readyMs: ready.convergeMs });
      }
      case "click":
      case "long_press": {
        const resolved = await resolveElement(session, op.locator, { signal, i: op.i, kind: op.kind });
        const point = tapPoint(resolved.element);
        await tap(session, point, op.kind === "long_press", { signal });
        return okDetail(op, { locator: resolved.query.description, x: point.x, y: point.y });
      }
      case "fill": {
        const resolved = await resolveElement(session, op.locator, { signal, i: op.i, kind: op.kind });
        await tap(session, tapPoint(resolved.element), false, { signal });
        await type(session, String(op.value), { signal });
        return okDetail(op, { locator: resolved.query.description });
      }
      case "app_background":
      case "app_foreground":
        await run(session, IOS_COMMANDS.launchApp, {}, { signal });
        return okDetail(op);
      case "raw": {
        const argv = op.block?.simctl;
        if (!Array.isArray(argv) || argv.some((item) => typeof item !== "string")) {
          throw new UnsupportedOpError("E_RAW_BLOCK_UNSUPPORTED", "Raw op does not carry an ios simctl argv block", {
            i: op.i,
            kind: op.kind,
            keys: Object.keys(op.block ?? {}),
            accepted: ["simctl"]
          });
        }

        await requireSimctl()(
          Object.freeze({ command: "xcrun", args: Object.freeze([...argv]), env: Object.freeze({}) }),
          { signal }
        );
        return okDetail(op, { raw: "simctl" });
      }
      default:
        // Reached only for an op whose capability the descriptor declares but
        // whose driver is not written. Refused by name rather than no-opped.
        throw new UnsupportedOpError("E_IOS_OP_NOT_IMPLEMENTED", `iOS surface does not implement ${op.kind} yet`, {
          i: op.i,
          kind: op.kind,
          remediation: "Use a raw simctl escape hatch with a written reason, or bind this step to another surface."
        });
    }
  }

  async function tap(session, point, longPress, { signal }) {
    if (typeof deps.tap !== "function") {
      throw new InfraError("E_IOS_INPUT_UNAVAILABLE", "No input driver is available", {
        remediation: "Tapping is driven by the CI harness on the macOS runner."
      });
    }

    return deps.tap({ deviceId: session.deviceId, point, longPress, signal });
  }

  async function type(session, text, { signal }) {
    if (typeof deps.type !== "function") {
      throw new InfraError("E_IOS_INPUT_UNAVAILABLE", "No input driver is available", {
        remediation: "Typing is driven by the CI harness on the macOS runner."
      });
    }

    return deps.type({ deviceId: session.deviceId, text, signal });
  }

  async function executeAssert(session, op, { signal }) {
    const query = toIosQuery(op.locator);
    let expected;
    let observed;
    let fatal = null;

    const result = await converge({
      signal,
      timeoutMs: session.stepTimeoutMs,
      intervalMs: QUERY_INTERVAL_MS,
      probe: async () => {
        if (fatal !== null) {
          return Object.freeze({ ok: true });
        }

        try {
          const elements = await describeElements(session, { signal });
          const found = findByQuery(elements, query, { requireVisible: true });

          switch (op.kind) {
            case "expect_visible":
              expected = "visible";
              observed = found.ok === true ? "visible" : found.reason;
              return Object.freeze({ ok: found.ok === true });
            case "expect_hidden":
              expected = "hidden";
              observed = found.ok === true ? "visible" : "hidden";
              return Object.freeze({ ok: found.ok !== true });
            case "expect_text":
              expected = String(op.equals).trim();
              observed = found.ok === true ? accessibleText(found.element) : found.reason;
              return Object.freeze({ ok: found.ok === true && observed === expected });
            case "expect_count": {
              expected = op.equals;
              observed = findByQuery(elements, Object.freeze({ ...query, nth: null }), { requireVisible: true }).ok
                ? 1
                : elements.filter((element) => findByQuery([element], query, { requireVisible: true }).ok).length;
              return Object.freeze({ ok: observed === expected });
            }
            default: {
              if (!ACCEPTED_STATES.includes(op.state)) {
                throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported iOS assertion state", {
                  i: op.i,
                  kind: op.kind,
                  state: op.state,
                  accepted: ACCEPTED_STATES
                });
              }

              expected = op.state;
              if (found.ok !== true) {
                observed = found.reason;
                return Object.freeze({ ok: false });
              }

              const holds = stateOf(found.element, op.state);
              observed = holds ? op.state : `not_${op.state}`;
              return Object.freeze({ ok: holds });
            }
          }
        } catch (error) {
          fatal = error;
          return Object.freeze({ ok: true });
        }
      }
    });

    if (fatal !== null) {
      throw fatal;
    }

    if (result.ok !== true) {
      throw new AttestError("E_IOS_ASSERTION_FAILED", "iOS assertion did not converge", {
        i: op.i,
        kind: op.kind,
        locator: query.description,
        expected,
        observed,
        convergeMs: result.elapsedMs,
        attempts: result.attempts
      });
    }

    return Object.freeze({
      ok: true,
      detail: Object.freeze({
        i: op.i,
        kind: op.kind,
        locator: query.description,
        convergeMs: result.elapsedMs,
        attempts: result.attempts
      })
    });
  }

  assertImplementsSurfacePort(adapter);
  return Object.freeze(adapter);
}
