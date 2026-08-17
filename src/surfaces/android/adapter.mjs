import { AttestError, InfraError, UnsupportedOpError } from "../../errors.mjs";
import { assertKnownCapability } from "../../capabilities/registry.mjs";
import { capabilitiesFor, OP_CAPABILITIES } from "../../ir/ops.mjs";
import { assertImplementsSurfacePort } from "../port.mjs";
import { ACT_KINDS, executeAct } from "./act.mjs";
import { ASSERT_KINDS, executeAssert } from "./assert.mjs";
import { androidSurfaceCapabilities } from "./capabilities.mjs";
import {
  captureHierarchy,
  captureScreenshot,
  discardRecording,
  removeDump,
  retainRecording,
  startRecording
} from "./evidence.mjs";
import { ANDROID_SESSION_DEFAULTS, openAndroidSession, withStepTimeout } from "./session.mjs";

// The plan op vocabulary is surface neutral, so the capability lookup has to
// map back to the IR op name the capability table is keyed by. Same table the
// web adapter uses, for the same reason: the demanded capability must not be
// re-derived per adapter or two adapters will disagree about what an op needs.
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

function abortReason(signal) {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw abortReason(signal);
  }
}

function freezeOk() {
  return Object.freeze({ ok: true });
}

function safeSegment(value) {
  const safe = String(value ?? "unknown").replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return safe.slice(0, 80) || "unknown";
}

function opKind(planOp) {
  if (planOp === null || typeof planOp !== "object" || Array.isArray(planOp)) {
    throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Android plan op must be an object", {
      kind: "<unknown>"
    });
  }

  return typeof planOp.kind === "string" && planOp.kind.length > 0 ? planOp.kind : "<unknown>";
}

function explicitCapabilities(planOp) {
  if (planOp.capabilities === undefined) {
    return null;
  }

  if (!Array.isArray(planOp.capabilities)) {
    throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Plan op capabilities must be an array", {
      i: planOp.i,
      kind: opKind(planOp)
    });
  }

  return Object.freeze(
    planOp.capabilities.map((capability) => {
      assertKnownCapability(capability);
      return capability;
    })
  );
}

function demandedCapabilities(planOp) {
  const explicit = explicitCapabilities(planOp);
  if (explicit !== null) {
    return explicit;
  }

  const sourceKind = SOURCE_KIND_FOR_PLAN_KIND[opKind(planOp)];
  if (sourceKind === undefined || OP_CAPABILITIES[sourceKind] === undefined) {
    return Object.freeze([]);
  }

  // The whole plan op, never `planOp.value`. On a fill or select_option the
  // value is the text being typed, and capabilitiesFor would try to read it as
  // a SemanticRef and reject the step for a reason that has nothing to do with
  // capabilities.
  return capabilitiesFor(sourceKind, planOp);
}

function assertCapabilitiesSupported(descriptor, planOp) {
  const missing = demandedCapabilities(planOp).filter((capability) => !descriptor.has(capability));

  if (missing.length > 0) {
    throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Android surface does not support plan op", {
      i: planOp.i,
      kind: opKind(planOp),
      missing
    });
  }
}

function componentFor({ packageName, activity }) {
  if (typeof packageName !== "string" || packageName.length === 0) {
    return null;
  }

  if (typeof activity !== "string" || activity.length === 0) {
    return `${packageName}/${packageName}.MainActivity`;
  }

  return activity.startsWith(".") || activity.includes(".")
    ? `${packageName}/${activity}`
    : `${packageName}/.${activity}`;
}

async function executeCheckpoint(session, planOp) {
  const label = safeSegment(
    session.redactor?.redactText?.(planOp.label ?? "checkpoint") ?? planOp.label ?? "checkpoint"
  );
  const reference = await captureScreenshot(session, { name: `step-${planOp.i}-checkpoint-${label}` });

  return Object.freeze({
    ok: true,
    detail: Object.freeze({ i: planOp.i, kind: planOp.kind, label }),
    evidence: Object.freeze(reference === null ? [] : [reference])
  });
}

/**
 * The Android surface adapter.
 *
 * It drives adb directly rather than Appium (decision C6). It sits behind the
 * same surface port the web adapter does and passes the same conformance
 * suite, which is what makes an Appium backed interaction layer a later
 * substitution rather than a rewrite.
 */
export function createAndroidSurface(options = {}) {
  const descriptor = androidSurfaceCapabilities();
  const lease = options.lease;
  const packageName = options.packageName ?? null;
  const component = options.component ?? componentFor({ packageName, activity: options.activity });
  const extras = options.extras ?? null;
  const secrets = options.secrets ?? [];
  const recordSeconds = options.recordSeconds ?? ANDROID_SESSION_DEFAULTS.recordSeconds;
  const record = options.record !== false;
  const deps = options.deps ?? {};

  const closedSessions = new WeakSet();
  const failedSessions = new WeakSet();
  const recordings = new WeakMap();

  function assertLease() {
    if (lease === null || lease === undefined || typeof lease.acquire !== "function") {
      throw new InfraError("E_ANDROID_NO_DEVICE", "Android surface has no device lease", {
        remediation: "Set android.avd or android.serial in the config."
      });
    }
  }

  const adapter = {
    describeCapabilities() {
      return descriptor;
    },

    async preflight(_ctx, { signal } = {}) {
      throwIfAborted(signal);
      assertLease();
      // Acquiring here rather than in open is what makes an unbootable
      // emulator an infrastructure error before any scenario starts.
      await lease.acquire({ signal });
      throwIfAborted(signal);
      return freezeOk();
    },

    async open(ctx, { signal } = {}) {
      throwIfAborted(signal);
      assertLease();
      const device = await lease.acquire({ signal });
      const session = openAndroidSession({
        device,
        packageName,
        component,
        extras,
        bundle: ctx?.bundle ?? null,
        secrets,
        stepTimeoutMs: ctx?.timeouts?.stepMs ?? ANDROID_SESSION_DEFAULTS.stepTimeoutMs,
        recordSeconds,
        deps,
        now: ctx?.now ?? Date.now
      });

      if (record) {
        // Record always, retain on failure, discard on pass. Same contract the
        // web adapter established for video in Phase 2, because a recording
        // that only starts once a step has failed has already missed it.
        recordings.set(session, startRecording(session));
      }

      return session;
    },

    execute(session, planOp, { signal } = {}) {
      if (closedSessions.has(session)) {
        throw new AttestError("E_SESSION_CLOSED", "Android surface session is closed", {
          sessionId: session?.id
        });
      }

      throwIfAborted(signal);
      const kind = opKind(planOp);
      assertCapabilitiesSupported(descriptor, planOp);

      const scoped = withStepTimeout(session, session.stepTimeoutMs);

      if (ACT_KINDS.has(kind)) {
        return executeAct(scoped, planOp, { signal });
      }

      if (ASSERT_KINDS.has(kind)) {
        return executeAssert(scoped, planOp, { signal });
      }

      if (kind === "checkpoint") {
        return executeCheckpoint(scoped, planOp);
      }

      if (kind === "db_window_open" || kind === "db_window_close") {
        throw new AttestError("E_DB_OP_AT_SURFACE", "Database window op reached android surface adapter", {
          i: planOp.i,
          kind
        });
      }

      throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported android plan op", {
        i: planOp.i,
        kind
      });
    },

    async collectEvidence(session, kind) {
      if (kind !== "failure") {
        return null;
      }

      failedSessions.add(session);
      // The hierarchy dump of the failing step is the Android equivalent of the
      // web trace: without it, "the locator did not resolve" is unfalsifiable.
      const screenshot = await captureScreenshot(session, { name: "failure" });
      await captureHierarchy(session, { name: "failure-hierarchy" });
      return screenshot;
    },

    async close(session) {
      if (session !== null && typeof session === "object") {
        closedSessions.add(session);
      }

      const recording = recordings.get(session) ?? null;
      recordings.delete(session);

      try {
        if (failedSessions.has(session)) {
          await retainRecording(session, recording);
        } else {
          await discardRecording(session, recording);
        }
      } catch {
        // Retention is best effort and must never mask the scenario result.
      }

      try {
        await removeDump(session);
      } catch {
        // The port requires close to be idempotent and non throwing.
      }

      return freezeOk();
    }
  };

  assertImplementsSurfacePort(adapter);
  return Object.freeze(adapter);
}
