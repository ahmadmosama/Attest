import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import { AttestError, InfraError, UnsupportedOpError, UsageError } from "../../errors.mjs";
import { assertKnownCapability } from "../../capabilities/registry.mjs";
import { capabilitiesFor, OP_CAPABILITIES } from "../../ir/ops.mjs";
import { assertImplementsSurfacePort } from "../port.mjs";
import { executeAct, ACT_KINDS } from "./act.mjs";
import { executeAssert, ASSERT_KINDS } from "./assert.mjs";
import { webSurfaceCapabilities } from "./capabilities.mjs";
import { closeWebSession, openWebSession, WEB_SESSION_DEFAULTS } from "./session.mjs";

const DEFAULT_TEMP_ROOT = "attest-web";

function abortReason(signal) {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw abortReason(signal);
  }
}

function assertChromeChannel(channel) {
  if (channel === null || channel === "" || channel === "chromium") {
    throw new UsageError(
      "E_BARE_CHROMIUM_REFUSED",
      "WEB-01 requires launching through the chrome channel, never bare Chromium",
      {
        channel
      }
    );
  }

  if (typeof channel !== "string") {
    throw new UsageError("E_BARE_CHROMIUM_REFUSED", "WEB-01 requires a named chrome channel", {
      channel
    });
  }

  if (channel !== "chrome") {
    throw new UsageError("E_WEB_CHANNEL_UNSUPPORTED", "WEB-01 requires channel chrome", {
      channel,
      required: "chrome"
    });
  }
}

function parsedHttpBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new UsageError("E_WEB_BASE_URL_REQUIRED", "Web baseUrl must be an http or https URL", {
      baseUrl
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UsageError("E_WEB_BASE_URL_REQUIRED", "Web baseUrl must be an http or https URL", {
      baseUrl,
      protocol: parsed.protocol
    });
  }

  return parsed;
}

function browserMissingError(error, channel) {
  return new InfraError("E_ADAPTER_BROWSER_MISSING", "Google Chrome is not available for web surface", {
    channel,
    cause: error instanceof Error ? error.message : String(error),
    remediation: `Install Google Chrome and keep the Playwright channel set to ${channel}.`
  });
}

function assertChromeResolvable(channel) {
  try {
    const executablePath = chromium.executablePath({ channel });
    if (typeof executablePath !== "string" || executablePath.length === 0) {
      throw new Error("Playwright returned an empty executable path");
    }
  } catch (error) {
    throw browserMissingError(error, channel);
  }
}

function safeSegment(value) {
  const safe = String(value ?? "unknown").replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return safe.slice(0, 80) || "unknown";
}

function tempDirsFor(ctx) {
  const root = path.join(
    tmpdir(),
    DEFAULT_TEMP_ROOT,
    safeSegment(ctx?.runId),
    safeSegment(ctx?.scenarioId)
  );

  return Object.freeze({
    videoDir: path.join(root, "video"),
    tracesDir: path.join(root, "trace")
  });
}

async function removeTempDirs(session) {
  const dirs = Array.isArray(session?.tempDirs) ? session.tempDirs : [];

  await Promise.all(
    dirs.map(async (dir) => {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // close is best effort and must never mask the scenario result.
      }
    })
  );
}

function opKind(planOp) {
  if (planOp === null || typeof planOp !== "object" || Array.isArray(planOp)) {
    throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Web plan op must be an object", {
      kind: "<unknown>"
    });
  }

  return typeof planOp.kind === "string" && planOp.kind.length > 0 ? planOp.kind : "<unknown>";
}

function freezeOk() {
  return Object.freeze({ ok: true });
}

function withStepTimeouts(session, ctx) {
  const stepMs = ctx?.timeouts?.stepMs ?? WEB_SESSION_DEFAULTS.actionTimeoutMs ?? 5000;
  return Object.freeze({
    ...session,
    actionTimeoutMs: stepMs,
    assertTimeoutMs: stepMs
  });
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

function demandedCapabilities(planOp) {
  const explicit = explicitCapabilities(planOp);
  if (explicit !== null) {
    return explicit;
  }

  const sourceKind = SOURCE_KIND_FOR_PLAN_KIND[opKind(planOp)];
  if (sourceKind === undefined || OP_CAPABILITIES[sourceKind] === undefined) {
    return Object.freeze([]);
  }

  return capabilitiesFor(sourceKind, planOp.value ?? planOp);
}

function assertCapabilitiesSupported(descriptor, planOp) {
  const kind = opKind(planOp);
  const missing = demandedCapabilities(planOp).filter((capability) => !descriptor.has(capability));

  if (missing.length > 0) {
    throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Web surface does not support plan op", {
      i: planOp.i,
      kind,
      missing
    });
  }
}

function isValidWebSession(session) {
  return (
    session !== null &&
    typeof session === "object" &&
    typeof session.page?.goto === "function" &&
    typeof session.context?.setOffline === "function"
  );
}

export function createWebSurface(options = {}) {
  const channel = options.channel ?? WEB_SESSION_DEFAULTS.channel;
  const baseUrl = options.baseUrl;
  const descriptor = webSurfaceCapabilities();
  const closedSessions = new WeakSet();

  const adapter = {
    describeCapabilities() {
      return descriptor;
    },

    preflight(_ctx, { signal } = {}) {
      throwIfAborted(signal);
      assertChromeChannel(channel);
      parsedHttpBaseUrl(baseUrl);
      assertChromeResolvable(channel);
      throwIfAborted(signal);
      return freezeOk();
    },

    async open(ctx, { signal } = {}) {
      throwIfAborted(signal);
      const { videoDir, tracesDir } = tempDirsFor(ctx);
      const session = await openWebSession({
        ...options,
        baseUrl,
        channel,
        headed: ctx?.headed ?? options.headed ?? WEB_SESSION_DEFAULTS.headed,
        bundle: ctx?.bundle ?? options.bundle,
        now: ctx?.now ?? options.now,
        videoDir,
        tracesDir,
        signal
      });
      return withStepTimeouts(session, ctx);
    },

    execute(session, planOp, { signal } = {}) {
      if (closedSessions.has(session)) {
        throw new AttestError("E_SESSION_CLOSED", "Web surface session is closed", {
          sessionId: session?.id
        });
      }

      throwIfAborted(signal);
      const kind = opKind(planOp);

      if (!isValidWebSession(session)) {
        throw new UnsupportedOpError(
          "E_WEB_OP_NOT_IMPLEMENTED",
          `Web op ${kind} requires an open web session`,
          {
            kind
          }
        );
      }

      assertCapabilitiesSupported(descriptor, planOp);

      if (ACT_KINDS.has(kind)) {
        return executeAct(session, planOp, { signal });
      }

      if (ASSERT_KINDS.has(kind)) {
        return executeAssert(session, planOp, { signal });
      }

      if (kind === "checkpoint") {
        return Object.freeze({ ok: true, detail: Object.freeze({ i: planOp.i, kind }) });
      }

      if (kind === "db_window_open" || kind === "db_window_close") {
        throw new AttestError("E_DB_OP_AT_SURFACE", "Database window op reached web surface adapter", {
          i: planOp.i,
          kind
        });
      }

      throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported web plan op", {
        i: planOp.i,
        kind
      });
    },

    collectEvidence() {
      return null;
    },

    async close(session) {
      try {
        if (session !== null && typeof session === "object") {
          closedSessions.add(session);
        }
        await closeWebSession(session);
        await removeTempDirs(session);
      } catch {
        // The surface port requires close to be idempotent and non throwing.
      }

      return freezeOk();
    }
  };

  assertImplementsSurfacePort(adapter);
  return Object.freeze(adapter);
}
