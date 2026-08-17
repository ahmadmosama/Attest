import { UsageError } from "../../errors.mjs";

/**
 * The real iOS backend: `idb`, Meta's iOS Development Bridge.
 *
 * Chosen after looking for what actually exists (2026-08-18):
 *
 *   facebook/idb                 5.3k stars, pushed the same week, not archived.
 *                                A CLI over simulators AND devices with a real
 *                                accessibility tree, tap, text and swipe. It is
 *                                the iOS analogue of adb, which makes it the
 *                                analogue of the backend Android already uses.
 *   appium/WebDriverAgent        maintained, but it is an XCUITest server that
 *                                has to be built and hosted per run, and it
 *                                arrives with the Appium stack this project
 *                                already declined for Android (decision C6).
 *   facebookarchive/WebDriverAgent  archived in 2019.
 *   wix/AppleSimulatorUtils      permissions and media only, no UI tree.
 *   cameroncooke/XcodeBuildMCP   an MCP server for agents, not a test backend.
 *
 * So idb, for the same reason adb won on Android: one binary, argv only, no
 * server lifecycle, and a tree that carries stable identifiers.
 *
 * This module is PURE command construction plus response normalisation. It
 * spawns nothing, so it is asserted against committed transcripts on a machine
 * with no macOS, which is the whole of IOS-02.
 */

export const IDB_COMMANDS = Object.freeze({
  listTargets: "list_targets",
  bootTarget: "boot_target",
  installApp: "install_app",
  launchApp: "launch_app",
  terminateApp: "terminate_app",
  describeAll: "describe_all",
  tap: "tap",
  text: "text",
  swipe: "swipe",
  key: "key",
  screenshot: "screenshot",
  shutdownTarget: "shutdown_target"
});

const COMMAND_SET = new Set(Object.values(IDB_COMMANDS));

// A simulator udid is a UUID. Narrow on purpose: this value reaches an argv
// array, and a permissive pattern is how a stray flag rides in as a target.
const UDID_RE = /^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/u;
const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/u;
const TEXT_RE = /^[^\r\n]*$/u;

function commandError(reason, details = {}) {
  return new UsageError("E_IDB_COMMAND_INVALID", "Invalid idb command request", { reason, ...details });
}

function matching(value, pattern, field) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw commandError("invalid_value", { field, value: typeof value === "string" ? value : null });
  }

  return value;
}

// Mandatory, never defaulted. idb happily targets "the only booted simulator",
// and defaulting to that is how a command lands on a simulator nobody chose,
// which on a CI runner with two of them is a green run that tested nothing.
function requireUdid(udid) {
  if (typeof udid !== "string" || udid.trim().length === 0) {
    throw new UsageError("E_IDB_UDID_REQUIRED", "An explicit simulator udid is required for this idb command", {
      remediation: "Pass the udid reported by `idb list-targets`, or by `simctl create`."
    });
  }

  return matching(udid, UDID_RE, "udid");
}

function coordinate(input, field) {
  const value = input?.[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw commandError("invalid_coordinate", { field, value: typeof value === "number" ? value : null });
  }

  return String(value);
}

function durationSeconds(input) {
  const value = input?.durationSeconds ?? 0.1;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 10) {
    throw commandError("invalid_duration", { value: typeof value === "number" ? value : null });
  }

  return String(value);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function idbCommand(args, { idbPath = "idb" } = {}) {
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    throw commandError("args_not_string_array", {});
  }

  return deepFreeze({ command: idbPath, args: [...args], env: {} });
}

/**
 * Build one idb invocation as data.
 *
 * Always `{ command, args, env }` with args an ARRAY. There is no path here
 * that produces a command string, for the reason the adb layer gives: a string
 * needs a shell, and a shell is what makes argument injection possible.
 */
export function buildIdbCommand(kind, input = {}, options = {}) {
  if (!COMMAND_SET.has(kind)) {
    throw commandError("unknown_command", { command: kind, accepted: Object.values(IDB_COMMANDS) });
  }

  if (kind === IDB_COMMANDS.listTargets) {
    return idbCommand(["list-targets", "--json"], options);
  }

  // Validated up front for every target scoped command.
  const udid = requireUdid(input.udid);
  const target = ["--udid", udid];

  switch (kind) {
    case IDB_COMMANDS.bootTarget:
      return idbCommand(["boot", udid], options);
    case IDB_COMMANDS.shutdownTarget:
      return idbCommand(["shutdown", udid], options);
    case IDB_COMMANDS.installApp:
      return idbCommand(["install", matching(input.appPath, /^.+$/u, "appPath"), ...target], options);
    case IDB_COMMANDS.launchApp:
      return idbCommand(
        [
          "launch",
          // Foregrounding an already running app is a different intent from a
          // cold start, and idb needs to be told which.
          ...(input.foregroundIfRunning === true ? ["-f"] : []),
          matching(input.bundleId, BUNDLE_ID_RE, "bundleId"),
          ...target
        ],
        options
      );
    case IDB_COMMANDS.terminateApp:
      return idbCommand(["terminate", matching(input.bundleId, BUNDLE_ID_RE, "bundleId"), ...target], options);
    case IDB_COMMANDS.describeAll:
      // The flat element array, which is what the locator matches over. The
      // nested format would have to be flattened here anyway.
      return idbCommand(["ui", "describe-all", ...target], options);
    case IDB_COMMANDS.tap:
      return idbCommand(
        ["ui", "tap", coordinate(input, "x"), coordinate(input, "y"), "--duration", durationSeconds(input), ...target],
        options
      );
    case IDB_COMMANDS.text:
      // idb takes the text as one argv element, so unlike `adb shell input
      // text` there is no device side shell to quote for.
      return idbCommand(["ui", "text", matching(input.text, TEXT_RE, "text"), ...target], options);
    case IDB_COMMANDS.swipe:
      return idbCommand(
        [
          "ui",
          "swipe",
          coordinate(input, "x1"),
          coordinate(input, "y1"),
          coordinate(input, "x2"),
          coordinate(input, "y2"),
          ...target
        ],
        options
      );
    case IDB_COMMANDS.key:
      return idbCommand(["ui", "key", coordinate(input, "keycode"), ...target], options);
    default:
      return idbCommand(["screenshot", matching(input.outputPath, /^.+$/u, "outputPath"), ...target], options);
  }
}

/**
 * idb's accessibility element to the shape the locator matches over.
 *
 * The key names are idb's, taken from its own ACCESSIBILITY_KEY_BY_NAME:
 * AXLabel, AXUniqueId, AXValue, title, role, role_description, subrole, help,
 * placeholder, plus `type`, `enabled` and a `frame` object.
 *
 * AXUniqueId is where `accessibilityIdentifier` arrives, which is why both
 * portable locator strategies map to it.
 */
export function normalizeElement(element) {
  if (element === null || typeof element !== "object") {
    return null;
  }

  const frame = element.frame;
  const hasFrame =
    frame !== null &&
    typeof frame === "object" &&
    ["x", "y", "width", "height"].every((key) => Number.isFinite(frame[key]));

  return Object.freeze({
    identifier: typeof element.AXUniqueId === "string" ? element.AXUniqueId : "",
    type: typeof element.type === "string" ? element.type : "",
    label: typeof element.AXLabel === "string" ? element.AXLabel : "",
    value: typeof element.AXValue === "string" ? element.AXValue : null,
    title: typeof element.title === "string" ? element.title : "",
    role: typeof element.role === "string" ? element.role : "",
    subrole: typeof element.subrole === "string" ? element.subrole : "",
    enabled: element.enabled !== false,
    // A zero sized frame is not on screen, and treating it as visible is how a
    // locator resolves to something nobody can tap.
    frame: hasFrame && frame.width > 0 && frame.height > 0
      ? Object.freeze({ x: frame.x, y: frame.y, width: frame.width, height: frame.height })
      : null
  });
}

export function normalizeElements(payload) {
  const elements = typeof payload === "string" ? JSON.parse(payload) : payload;

  if (!Array.isArray(elements)) {
    throw commandError("describe_all_not_an_array", {
      received: typeof elements,
      remediation: "Attest reads the flat `idb ui describe-all` output. Do not pass --format nested."
    });
  }

  return Object.freeze(elements.map((element) => normalizeElement(element)).filter(Boolean));
}

/**
 * `idb list-targets --json` emits one JSON object per line, not a JSON array.
 */
export function parseTargets(stdout) {
  return Object.freeze(
    String(stdout ?? "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .map((target) =>
        Object.freeze({
          udid: target.udid ?? null,
          name: target.name ?? null,
          state: target.state ?? null,
          osVersion: target.os_version ?? target.osVersion ?? null,
          type: target.target_type ?? target.type ?? null
        })
      )
  );
}
