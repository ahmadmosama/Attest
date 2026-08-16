import { AttestError, InfraError, UnsupportedOpError } from "../../errors.mjs";
import { describeLocator, toLocator } from "./locate.mjs";
import { convergeOnLocator } from "./assert.mjs";

const DEFAULT_ACTION_TIMEOUT_MS = 5000;
const SWIPE_DELTA_PX = 500;
const LONG_PRESS_DELAY_MS = 750;

export const ACT_KINDS = Object.freeze(
  new Set([
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
  ])
);

function abortReason(signal) {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw abortReason(signal);
  }
}

function actionTimeoutMs(session) {
  return session?.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
}

function locatorDescription(op) {
  return op.locator === undefined ? undefined : describeLocator(op.locator);
}

function actionErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isPlaywrightTimeout(error) {
  return error?.name === "TimeoutError" || /Timeout \d+ms exceeded/i.test(actionErrorMessage(error));
}

function isInfrastructureError(error) {
  const message = actionErrorMessage(error);
  return (
    /Target page, context or browser has been closed/i.test(message) ||
    /Browser has been closed/i.test(message) ||
    /browser has disconnected/i.test(message)
  );
}

function actionTimeoutError(op) {
  return new AttestError("E_WEB_ACTION_TIMEOUT", "Web action timed out", {
    i: op.i,
    kind: op.kind,
    locator: locatorDescription(op)
  });
}

function actionFailedError(error, op) {
  return new AttestError("E_WEB_ACTION_FAILED", "Web action failed", {
    i: op.i,
    kind: op.kind,
    locator: locatorDescription(op),
    cause: actionErrorMessage(error)
  });
}

function infrastructureError(error, op) {
  return new InfraError("E_WEB_ACTION_INFRA", "Web browser became unavailable during action", {
    i: op.i,
    kind: op.kind,
    locator: locatorDescription(op),
    cause: actionErrorMessage(error)
  });
}

function okDetail(op, detail = {}) {
  return Object.freeze({
    ok: true,
    detail: Object.freeze({
      i: op.i,
      kind: op.kind,
      ...detail
    })
  });
}

function redactUrl(session, url) {
  return session?.redactor?.redactUrl?.(url) ?? url;
}

async function translateActionError(fn, op) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AttestError) {
      throw error;
    }

    if (isInfrastructureError(error)) {
      throw infrastructureError(error, op);
    }

    if (isPlaywrightTimeout(error)) {
      throw actionTimeoutError(op);
    }

    throw actionFailedError(error, op);
  }
}

function unsupportedLifecycle(op) {
  return new UnsupportedOpError("E_UNSUPPORTED_OP", "Web surface does not support app lifecycle", {
    i: op.i,
    kind: op.kind,
    missing: ["app_lifecycle"]
  });
}

function unsupportedRawBlock(op) {
  return new UnsupportedOpError("E_RAW_BLOCK_UNSUPPORTED", "Raw op does not contain a web script block", {
    i: op.i,
    kind: op.kind,
    keys: Object.keys(op.block ?? {})
  });
}

function wheelDeltaFor(direction) {
  switch (direction) {
    case "up":
      return Object.freeze({ deltaX: 0, deltaY: -SWIPE_DELTA_PX });
    case "down":
      return Object.freeze({ deltaX: 0, deltaY: SWIPE_DELTA_PX });
    case "left":
      return Object.freeze({ deltaX: -SWIPE_DELTA_PX, deltaY: 0 });
    case "right":
      return Object.freeze({ deltaX: SWIPE_DELTA_PX, deltaY: 0 });
    default:
      throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported swipe direction", {
        direction,
        accepted: ["up", "down", "left", "right"]
      });
  }
}

function networkOffline(mode) {
  switch (mode) {
    case "offline":
      return true;
    case "online":
      return false;
    default:
      throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported network mode", {
        mode,
        accepted: ["online", "offline"]
      });
  }
}

async function navigate(session, op, { signal }) {
  const timeout = actionTimeoutMs(session);
  const url = new URL(op.target.path, session.baseUrl).href;
  await translateActionError(
    () => session.page.goto(url, { waitUntil: "domcontentloaded", timeout }),
    op
  );
  const ready = await convergeOnLocator(session, op.ready, { signal });

  if (!ready.ok) {
    throw new AttestError("E_WEB_READY_TIMEOUT", "Navigation ready locator did not converge", {
      i: op.i,
      kind: op.kind,
      locator: ready.locator,
      expected: "visible",
      observed: ready.observed ? "visible" : "hidden",
      convergeMs: ready.elapsedMs,
      attempts: ready.attempts
    });
  }

  return okDetail(op, { url: redactUrl(session, url), readyMs: ready.elapsedMs });
}

async function withLocator(session, op, action) {
  const locator = toLocator(session.page, op.locator);
  return action(locator, actionTimeoutMs(session));
}

async function click(session, op) {
  return translateActionError(
    () => withLocator(session, op, (locator, timeout) => locator.click({ timeout })),
    op
  );
}

async function longPress(session, op) {
  return translateActionError(
    () =>
      withLocator(session, op, (locator, timeout) =>
        locator.click({ delay: LONG_PRESS_DELAY_MS, timeout })
      ),
    op
  );
}

async function fill(session, op) {
  return translateActionError(
    () => withLocator(session, op, (locator, timeout) => locator.fill(String(op.value), { timeout })),
    op
  );
}

async function clear(session, op) {
  return translateActionError(
    () => withLocator(session, op, (locator, timeout) => locator.fill("", { timeout })),
    op
  );
}

async function scrollUntilVisible(session, op, { signal }) {
  await translateActionError(
    () => withLocator(session, op, (locator, timeout) => locator.scrollIntoViewIfNeeded({ timeout })),
    op
  );
  const result = await convergeOnLocator(session, op.locator, { signal });
  if (!result.ok) {
    throw new AttestError("E_WEB_ACTION_TIMEOUT", "Element did not become visible after scroll", {
      i: op.i,
      kind: op.kind,
      locator: result.locator
    });
  }
}

async function swipe(session, op) {
  const { deltaX, deltaY } = wheelDeltaFor(op.direction);

  return translateActionError(async () => {
    if (op.locator !== undefined) {
      await withLocator(session, op, async (locator, timeout) => {
        await locator.scrollIntoViewIfNeeded({ timeout });
        const box = await locator.boundingBox({ timeout });
        if (box !== null) {
          await session.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        }
      });
    }

    await session.page.mouse.wheel(deltaX, deltaY);
  }, op);
}

async function setPermission(session, op) {
  return translateActionError(async () => {
    if (op.value === false || op.value === "denied") {
      await session.context.clearPermissions();
      return;
    }

    await session.context.grantPermissions([op.name], { origin: session.baseUrl.origin });
  }, op);
}

async function setClipboard(session, op) {
  return translateActionError(async () => {
    await session.context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: session.baseUrl.origin
    });
    await session.page.evaluate((value) => navigator.clipboard.writeText(value), String(op.value));
  }, op);
}

async function executeRaw(session, op) {
  if (typeof op.block?.script !== "string" || op.block.script.length === 0) {
    throw unsupportedRawBlock(op);
  }

  await translateActionError(() => session.page.evaluate(op.block.script), op);
}

export async function executeAct(session, op, { signal } = {}) {
  throwIfAborted(signal);

  if (!ACT_KINDS.has(op?.kind)) {
    throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported web action op", {
      i: op?.i,
      kind: op?.kind
    });
  }

  // Actions use Playwright actionability with explicit timeouts. Assertions and
  // readiness checks are different: they go through converge so their elapsed
  // convergence time is visible in the run record.
  switch (op.kind) {
    case "navigate":
      return navigate(session, op, { signal });
    case "back":
      await translateActionError(() => session.page.goBack({ timeout: actionTimeoutMs(session) }), op);
      return okDetail(op);
    case "click":
      await click(session, op);
      return okDetail(op, { locator: describeLocator(op.locator) });
    case "long_press":
      await longPress(session, op);
      return okDetail(op, { locator: describeLocator(op.locator) });
    case "fill":
      await fill(session, op);
      return okDetail(op, { locator: describeLocator(op.locator) });
    case "clear":
      await clear(session, op);
      return okDetail(op, { locator: describeLocator(op.locator) });
    case "press_key":
      await translateActionError(() => session.page.keyboard.press(op.key), op);
      return okDetail(op, { key: op.key });
    case "swipe":
      await swipe(session, op);
      return okDetail(op, { direction: op.direction });
    case "scroll_until_visible":
      await scrollUntilVisible(session, op, { signal });
      return okDetail(op, { locator: describeLocator(op.locator) });
    case "select_option":
      await translateActionError(
        () =>
          withLocator(session, op, (locator, timeout) =>
            locator.selectOption(String(op.value), { timeout })
          ),
        op
      );
      return okDetail(op, { locator: describeLocator(op.locator), value: op.value });
    case "upload_file":
      await translateActionError(
        () => withLocator(session, op, (locator, timeout) => locator.setInputFiles(op.path, { timeout })),
        op
      );
      return okDetail(op, { locator: describeLocator(op.locator) });
    case "set_permission":
      await setPermission(session, op);
      return okDetail(op, { name: op.name, value: op.value });
    case "set_network":
      await translateActionError(() => session.context.setOffline(networkOffline(op.mode)), op);
      return okDetail(op, { mode: op.mode });
    case "set_clipboard":
      await setClipboard(session, op);
      return okDetail(op);
    case "app_background":
    case "app_foreground":
      throw unsupportedLifecycle(op);
    case "raw":
      await executeRaw(session, op);
      return okDetail(op);
    default:
      throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported web action op", {
        i: op.i,
        kind: op.kind
      });
  }
}
