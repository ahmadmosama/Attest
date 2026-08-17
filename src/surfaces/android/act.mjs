import { AttestError, UnsupportedOpError } from "../../errors.mjs";
import { converge } from "../../runtime/converge.mjs";
import { ADB_COMMANDS, adbCommand, shellCommand } from "./commands.mjs";
import { tapPoint } from "./hierarchy.mjs";
import { describeLocator, findByQuery, toAndroidQuery } from "./locate.mjs";
import { dumpHierarchy, resolveNode, run } from "./session.mjs";

const LONG_PRESS_MS = 750;
const SWIPE_MS = 300;
const SWIPE_FRACTION = 0.35;
const MAX_CLEAR_KEYS = 200;

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

// The shared vocabulary is browser shaped, so the mapping is written out rather
// than inferred. An unmapped key is refused by name: silently sending the wrong
// keycode is worse than failing.
const KEY_EVENTS = Object.freeze({
  Enter: "KEYCODE_ENTER",
  Escape: "KEYCODE_ESCAPE",
  Tab: "KEYCODE_TAB",
  Backspace: "KEYCODE_DEL",
  Delete: "KEYCODE_FORWARD_DEL",
  ArrowUp: "KEYCODE_DPAD_UP",
  ArrowDown: "KEYCODE_DPAD_DOWN",
  ArrowLeft: "KEYCODE_DPAD_LEFT",
  ArrowRight: "KEYCODE_DPAD_RIGHT",
  Home: "KEYCODE_MOVE_HOME",
  End: "KEYCODE_MOVE_END",
  PageUp: "KEYCODE_PAGE_UP",
  PageDown: "KEYCODE_PAGE_DOWN",
  Space: "KEYCODE_SPACE",
  Back: "KEYCODE_BACK"
});

const KEYCODE_RE = /^KEYCODE_[A-Z0-9_]+$/u;
const SWIPE_DIRECTIONS = Object.freeze(["up", "down", "left", "right"]);

function abortReason(signal) {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw abortReason(signal);
  }
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

function unsupported(op, code, message, details = {}) {
  return new UnsupportedOpError(code, message, { i: op.i, kind: op.kind, ...details });
}

function keyeventFor(op) {
  const key = op.key;

  if (typeof key === "string" && KEYCODE_RE.test(key)) {
    return key;
  }

  const mapped = KEY_EVENTS[key];
  if (mapped === undefined) {
    throw unsupported(op, "E_ANDROID_KEY_UNSUPPORTED", "Android surface has no keycode for this key", {
      key,
      accepted: Object.keys(KEY_EVENTS),
      remediation: "Use one of the accepted key names, or pass an explicit KEYCODE_ name."
    });
  }

  return mapped;
}

async function tapNode(session, node, { signal }) {
  const point = tapPoint(node);
  await run(session, ADB_COMMANDS.inputTap, { x: point.x, y: point.y }, { signal });
  return point;
}

async function startActivity(session, { data = null, signal }) {
  if (typeof session.component !== "string" || session.component.length === 0) {
    throw new AttestError("E_ANDROID_COMPONENT_REQUIRED", "Android surface needs a launch component", {
      remediation:
        "Set android.package and android.activity in the config so the adapter knows which activity to start."
    });
  }

  return run(
    session,
    ADB_COMMANDS.startActivity,
    {
      component: session.component,
      ...(data === null ? {} : { data }),
      ...(session.extras === null || session.extras === undefined ? {} : { extras: session.extras })
    },
    { signal }
  );
}

async function navigate(session, op, { signal }) {
  const deeplink = op.target?.deeplink ?? null;

  if (deeplink === null && op.target?.path !== undefined) {
    throw unsupported(op, "E_ANDROID_SCREEN_PATH", "Android screens are reached by deeplink, not by URL path", {
      path: op.target.path,
      remediation: "Give this screen a deeplink in the android bindings file."
    });
  }

  await startActivity(session, { data: deeplink, signal });

  if (op.ready === undefined) {
    return okDetail(op, { deeplink });
  }

  const ready = await resolveNode(session, op.ready, { signal, i: op.i, kind: op.kind });
  return okDetail(op, { deeplink, readyMs: ready.convergeMs, ready: ready.query.description });
}

function screenBounds(nodes) {
  const root = nodes.find((node) => node.bounds !== null);
  if (root === undefined) {
    throw new AttestError("E_ANDROID_NO_SCREEN_BOUNDS", "The hierarchy carried no node with bounds", {});
  }

  return root.bounds;
}

function swipeVector(bounds, direction) {
  const centerX = Math.floor((bounds.left + bounds.right) / 2);
  const centerY = Math.floor((bounds.top + bounds.bottom) / 2);
  const dx = Math.floor(bounds.width * SWIPE_FRACTION);
  const dy = Math.floor(bounds.height * SWIPE_FRACTION);

  // "down" means reveal what is further down the content, which on a touch
  // screen is a finger moving up. Matching the web adapter's wheel semantics is
  // what lets one scenario mean the same thing on both surfaces.
  switch (direction) {
    case "down":
      return Object.freeze({ x1: centerX, y1: centerY + dy, x2: centerX, y2: centerY - dy });
    case "up":
      return Object.freeze({ x1: centerX, y1: centerY - dy, x2: centerX, y2: centerY + dy });
    case "right":
      return Object.freeze({ x1: centerX + dx, y1: centerY, x2: centerX - dx, y2: centerY });
    case "left":
      return Object.freeze({ x1: centerX - dx, y1: centerY, x2: centerX + dx, y2: centerY });
    default:
      throw new UnsupportedOpError("E_UNSUPPORTED_OP", "Unsupported swipe direction", {
        direction,
        accepted: SWIPE_DIRECTIONS
      });
  }
}

async function swipeOver(session, bounds, direction, { signal }) {
  const vector = swipeVector(bounds, direction);
  await run(session, ADB_COMMANDS.inputSwipe, { ...vector, durationMs: SWIPE_MS }, { signal });
  return vector;
}

async function swipe(session, op, { signal }) {
  const bounds =
    op.locator === undefined
      ? screenBounds(await dumpHierarchy(session, { signal }))
      : (await resolveNode(session, op.locator, { signal, i: op.i, kind: op.kind })).node.bounds;

  await swipeOver(session, bounds, op.direction, { signal });
  return okDetail(op, { direction: op.direction });
}

async function scrollUntilVisible(session, op, { signal }) {
  const query = toAndroidQuery(op.locator);
  let last = null;

  const result = await converge({
    signal,
    timeoutMs: session.stepTimeoutMs,
    intervalMs: session.dumpIntervalMs,
    probe: async () => {
      const nodes = await dumpHierarchy(session, { signal });
      last = findByQuery(nodes, query, { requireVisible: true });
      if (last.ok === true) {
        return Object.freeze({ ok: true, value: last });
      }

      await swipeOver(session, screenBounds(nodes), "down", { signal });
      return Object.freeze({ ok: false });
    }
  });

  if (result.ok !== true) {
    throw new AttestError("E_ANDROID_SCROLL_EXHAUSTED", "Element never became visible while scrolling", {
      i: op.i,
      kind: op.kind,
      locator: query.description,
      convergeMs: result.elapsedMs,
      attempts: result.attempts
    });
  }

  return okDetail(op, { locator: query.description, convergeMs: result.elapsedMs });
}

async function fill(session, op, { signal }) {
  const resolved = await resolveNode(session, op.locator, { signal, i: op.i, kind: op.kind });
  await tapNode(session, resolved.node, { signal });
  await run(session, ADB_COMMANDS.inputText, { text: String(op.value) }, { signal });
  return okDetail(op, { locator: resolved.query.description });
}

async function clear(session, op, { signal }) {
  const resolved = await resolveNode(session, op.locator, { signal, i: op.i, kind: op.kind });
  const length = resolved.node.text.length;

  if (length > MAX_CLEAR_KEYS) {
    throw new AttestError("E_ANDROID_CLEAR_TOO_LONG", "Field holds more text than clear can delete", {
      i: op.i,
      kind: op.kind,
      locator: resolved.query.description,
      length,
      limit: MAX_CLEAR_KEYS,
      remediation: "Clear this field through a raw escape hatch with a written reason."
    });
  }

  await tapNode(session, resolved.node, { signal });

  if (length > 0) {
    // One adb call, not one per character: `input keyevent` takes a list.
    await run(
      session,
      ADB_COMMANDS.inputKeyevent,
      { keyevents: ["KEYCODE_MOVE_END", ...Array.from({ length }, () => "KEYCODE_DEL")] },
      { signal }
    );
  }

  return okDetail(op, { locator: resolved.query.description, deleted: length });
}

async function selectOption(session, op, { signal }) {
  const resolved = await resolveNode(session, op.locator, { signal, i: op.i, kind: op.kind });
  await tapNode(session, resolved.node, { signal });

  // The opened list is just more nodes, so the option is located the same way
  // everything else is, ambiguity refusal included.
  const option = await resolveNode(
    session,
    Object.freeze({ strategy: "roleName", role: "text", name: String(op.value) }),
    { signal, i: op.i, kind: op.kind }
  );
  await tapNode(session, option.node, { signal });

  return okDetail(op, { locator: resolved.query.description, value: op.value });
}

async function executeRaw(session, op, { signal }) {
  const shellArgv = op.block?.shell;
  const adbArgv = op.block?.adb;

  if (Array.isArray(shellArgv) && shellArgv.every((item) => typeof item === "string")) {
    await session.runtime.runAdb(rawShell(session, shellArgv), { signal });
    return okDetail(op, { raw: "shell" });
  }

  if (Array.isArray(adbArgv) && adbArgv.every((item) => typeof item === "string")) {
    await session.runtime.runAdb(rawAdb(session, adbArgv), { signal });
    return okDetail(op, { raw: "adb" });
  }

  throw unsupported(op, "E_RAW_BLOCK_UNSUPPORTED", "Raw op does not carry an android argv block", {
    keys: Object.keys(op.block ?? {}),
    accepted: ["shell", "adb"]
  });
}

// The escape hatch passes argv through unquoted on purpose. It is the one op
// that carries a written reason and is counted in the run record, so the
// operator has taken responsibility for what it sends. It is still an argv
// array, so the HOST shell is not involved here either.
function rawShell(session, argv) {
  return shellCommand({ serial: session.serial, argv, adbPath: session.adbPath });
}

function rawAdb(session, argv) {
  return adbCommand({ serial: session.serial, args: argv, adbPath: session.adbPath });
}

export async function executeAct(session, op, { signal } = {}) {
  throwIfAborted(signal);

  switch (op.kind) {
    case "navigate":
      return navigate(session, op, { signal });
    case "back":
      await run(session, ADB_COMMANDS.inputKeyevent, { keyevent: "KEYCODE_BACK" }, { signal });
      return okDetail(op);
    case "click": {
      const resolved = await resolveNode(session, op.locator, { signal, i: op.i, kind: op.kind });
      const point = await tapNode(session, resolved.node, { signal });
      return okDetail(op, { locator: resolved.query.description, x: point.x, y: point.y });
    }
    case "long_press": {
      const resolved = await resolveNode(session, op.locator, { signal, i: op.i, kind: op.kind });
      const point = tapPoint(resolved.node);
      await run(
        session,
        ADB_COMMANDS.inputSwipe,
        { x1: point.x, y1: point.y, x2: point.x, y2: point.y, durationMs: LONG_PRESS_MS },
        { signal }
      );
      return okDetail(op, { locator: resolved.query.description });
    }
    case "fill":
      return fill(session, op, { signal });
    case "clear":
      return clear(session, op, { signal });
    case "press_key":
      await run(session, ADB_COMMANDS.inputKeyevent, { keyevent: keyeventFor(op) }, { signal });
      return okDetail(op, { key: op.key });
    case "swipe":
      return swipe(session, op, { signal });
    case "scroll_until_visible":
      return scrollUntilVisible(session, op, { signal });
    case "select_option":
      return selectOption(session, op, { signal });
    case "app_background":
      await run(session, ADB_COMMANDS.inputKeyevent, { keyevent: "KEYCODE_HOME" }, { signal });
      return okDetail(op);
    case "app_foreground":
      await startActivity(session, { signal });
      return okDetail(op);
    case "raw":
      return executeRaw(session, op, { signal });
    default:
      throw unsupported(op, "E_UNSUPPORTED_OP", "Unsupported android action op", {
        locator: op.locator === undefined ? undefined : describeLocator(op.locator)
      });
  }
}
