import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import { InfraError, UnsupportedOpError, UsageError } from "../../errors.mjs";
import { assertImplementsSurfacePort } from "../port.mjs";
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
  return typeof planOp?.kind === "string" && planOp.kind.length > 0 ? planOp.kind : "<unknown>";
}

function freezeOk() {
  return Object.freeze({ ok: true });
}

export function createWebSurface(options = {}) {
  const channel = options.channel ?? WEB_SESSION_DEFAULTS.channel;
  const baseUrl = options.baseUrl;
  const descriptor = webSurfaceCapabilities();

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

    open(ctx, { signal } = {}) {
      throwIfAborted(signal);
      const { videoDir, tracesDir } = tempDirsFor(ctx);
      return openWebSession({
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
    },

    execute(_session, planOp, { signal } = {}) {
      throwIfAborted(signal);
      const kind = opKind(planOp);
      throw new UnsupportedOpError(
        "E_WEB_OP_NOT_IMPLEMENTED",
        `Web op ${kind} is not implemented in this phase`,
        {
          kind
        }
      );
    },

    collectEvidence() {
      return null;
    },

    async close(session) {
      try {
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
