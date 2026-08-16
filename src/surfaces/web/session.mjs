import { randomUUID } from "node:crypto";

import { chromium, selectors } from "playwright";

import { InfraError, UsageError } from "../../errors.mjs";

const CLOSED_SESSIONS = new WeakSet();

let configuredTestIdAttribute = null;

export const WEB_SESSION_DEFAULTS = Object.freeze({
  channel: "chrome",
  headed: false,
  testIdAttribute: "data-testid",
  viewport: undefined,
  videoDir: undefined,
  tracesDir: undefined,
  secrets: Object.freeze([]),
  extraHTTPHeaders: undefined
});

function noop() {}

function abortReason(signal) {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw abortReason(signal);
  }
}

function isAbortFromSignal(error, signal) {
  return signal?.aborted === true && error === abortReason(signal);
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

function launchError(error, channel) {
  return new InfraError("E_ADAPTER_BROWSER_LAUNCH", "Unable to launch Google Chrome for web surface", {
    channel,
    cause: error instanceof Error ? error.message : String(error),
    remediation: `Install Google Chrome and keep the Playwright channel set to ${channel}.`
  });
}

function setupError(error, stage) {
  return new InfraError("E_ADAPTER_BROWSER_SETUP", "Unable to initialize Playwright web session", {
    stage,
    cause: error instanceof Error ? error.message : String(error)
  });
}

async function ignoreClose(handle) {
  if (handle !== null && handle !== undefined && typeof handle.close === "function") {
    try {
      await handle.close();
    } catch {
      // closeWebSession is intentionally best effort so cleanup never hides the real result.
    }
  }
}

async function ignoreCleanup({ page, context, browser }) {
  await ignoreClose(page);
  await ignoreClose(context);
  await ignoreClose(browser);
}

async function abortable(promise, signal, cleanup) {
  if (signal === undefined) {
    return promise;
  }

  if (signal.aborted) {
    promise.then(cleanup, () => {});
    throw abortReason(signal);
  }

  let aborted = false;
  let removeAbortListener = noop;
  const abortPromise = new Promise((_, reject) => {
    const onAbort = () => {
      aborted = true;
      reject(abortReason(signal));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    removeAbortListener();
    if (aborted) {
      promise.then(cleanup, () => {});
    }
  }
}

function configureTestIdAttribute(testIdAttribute) {
  if (typeof testIdAttribute !== "string" || testIdAttribute.length === 0) {
    throw new UsageError("E_WEB_TEST_ID_ATTRIBUTE_REQUIRED", "testIdAttribute must be non empty", {
      testIdAttribute
    });
  }

  if (configuredTestIdAttribute === null) {
    selectors.setTestIdAttribute(testIdAttribute);
    configuredTestIdAttribute = testIdAttribute;
    return testIdAttribute;
  }

  if (configuredTestIdAttribute !== testIdAttribute) {
    throw new UsageError(
      "E_WEB_TEST_ID_ATTRIBUTE_LOCKED",
      "Playwright test id attribute is already configured for this process",
      {
        requested: testIdAttribute,
        configured: configuredTestIdAttribute
      }
    );
  }

  return configuredTestIdAttribute;
}

function freezeSession(fields) {
  return Object.freeze({
    id: fields.id,
    browser: fields.browser,
    context: fields.context,
    page: fields.page,
    baseUrl: fields.baseUrl,
    bundle: fields.bundle,
    redactor: null,
    network: [],
    closed: false,
    startedAt: fields.startedAt,
    channel: fields.channel,
    testIdAttribute: fields.testIdAttribute,
    videoDir: fields.videoDir,
    tracesDir: fields.tracesDir,
    tempDirs: Object.freeze(fields.tempDirs)
  });
}

export async function openWebSession(options = {}) {
  const {
    baseUrl,
    headed = WEB_SESSION_DEFAULTS.headed,
    channel = WEB_SESSION_DEFAULTS.channel,
    testIdAttribute = WEB_SESSION_DEFAULTS.testIdAttribute,
    viewport = WEB_SESSION_DEFAULTS.viewport,
    videoDir = WEB_SESSION_DEFAULTS.videoDir,
    tracesDir = WEB_SESSION_DEFAULTS.tracesDir,
    extraHTTPHeaders = WEB_SESSION_DEFAULTS.extraHTTPHeaders,
    bundle = null,
    now = Date.now,
    signal
  } = options;

  throwIfAborted(signal);
  assertChromeChannel(channel);
  const parsedBaseUrl = parsedHttpBaseUrl(baseUrl);
  const configuredAttribute = configureTestIdAttribute(testIdAttribute);

  let browser = null;
  let context = null;
  let page = null;

  try {
    browser = await abortable(
      chromium.launch({ channel, headless: !headed }),
      signal,
      (createdBrowser) => ignoreClose(createdBrowser)
    );
  } catch (error) {
    if (isAbortFromSignal(error, signal)) {
      throw error;
    }

    throw launchError(error, channel);
  }

  try {
    throwIfAborted(signal);
    context = await abortable(
      browser.newContext({
        viewport,
        recordVideo: videoDir === undefined ? undefined : { dir: videoDir },
        extraHTTPHeaders
      }),
      signal,
      (createdContext) => ignoreClose(createdContext)
    );

    throwIfAborted(signal);
    await abortable(
      context.tracing.start({ screenshots: true, snapshots: true, sources: false }),
      signal,
      () => {}
    );

    throwIfAborted(signal);
    page = await abortable(context.newPage(), signal, (createdPage) => ignoreClose(createdPage));

    return freezeSession({
      id: `web-session-${randomUUID()}`,
      browser,
      context,
      page,
      baseUrl: parsedBaseUrl,
      bundle,
      startedAt: now(),
      channel,
      testIdAttribute: configuredAttribute,
      videoDir,
      tracesDir,
      tempDirs: [videoDir, tracesDir].filter((dir) => typeof dir === "string" && dir.length > 0)
    });
  } catch (error) {
    await ignoreCleanup({ page, context, browser });
    if (isAbortFromSignal(error, signal)) {
      throw error;
    }

    throw setupError(error, page === null ? "context" : "page");
  }
}

export async function closeWebSession(session) {
  if (session === null || typeof session !== "object") {
    return Object.freeze({ ok: true });
  }

  if (CLOSED_SESSIONS.has(session)) {
    return Object.freeze({ ok: true });
  }

  CLOSED_SESSIONS.add(session);
  await ignoreClose(session.page);
  await ignoreClose(session.context);
  await ignoreClose(session.browser);
  return Object.freeze({ ok: true });
}
