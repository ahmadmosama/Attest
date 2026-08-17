import path from "node:path";

import { UsageError } from "../../errors.mjs";

export const ADB_COMMANDS = Object.freeze({
  devices: "devices",
  getState: "get_state",
  waitForDevice: "wait_for_device",
  getProp: "get_prop",
  install: "install",
  uninstall: "uninstall",
  forceStop: "force_stop",
  startActivity: "start_activity",
  screencap: "screencap",
  screenrecord: "screenrecord",
  uiDump: "ui_dump",
  pull: "pull",
  readFile: "read_file",
  removeFile: "remove_file",
  inputTap: "input_tap",
  inputSwipe: "input_swipe",
  inputText: "input_text",
  inputKeyevent: "input_keyevent",
  emuKill: "emu_kill"
});

const ADB_COMMAND_SET = new Set(Object.values(ADB_COMMANDS));

// A serial looks like emulator-5554 or a device id. It is deliberately narrow:
// this value reaches an argv array, and a permissive pattern is how a stray
// flag would ride in as a serial. The leading character may not be a hyphen,
// otherwise "-s" or "-e" would be accepted as a serial and would then be read
// by adb as a flag rather than as a device.
const SERIAL_RE = /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/u;
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
const COMPONENT_RE = /^[A-Za-z][A-Za-z0-9_.]*\/[A-Za-z0-9_.$]+$/u;
const PROP_RE = /^[A-Za-z0-9_.]+$/u;
const KEYEVENT_RE = /^[A-Z0-9_]+$/u;
const EXTRA_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
// Free text. A newline would end the device side command, so it is refused
// rather than escaped: a scenario that wants to send Enter has press_key.
const TEXT_RE = /^[^\r\n]*$/u;
const URI_RE = /^[a-z][a-z0-9+.-]*:\/\/[^\s'\r\n]*$/u;
const MAX_KEYEVENTS = 200;

// Device side paths are POSIX and always absolute. The host side never appears
// in an argv we construct for the device, which is the half that MSYS rewrote.
const DEVICE_PATH_RE = /^\/[A-Za-z0-9._/-]*$/u;

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function commandError(reason, details = {}) {
  return new UsageError("E_ADB_COMMAND_INVALID", "Invalid adb command request", {
    reason,
    ...details
  });
}

function assertKnownCommand(kind) {
  if (!ADB_COMMAND_SET.has(kind)) {
    throw commandError("unknown_command", { command: kind, accepted: Object.values(ADB_COMMANDS) });
  }
}

function matching(value, pattern, field) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw commandError("invalid_value", { field, value: typeof value === "string" ? value : null });
  }

  return value;
}

// Mandatory, never defaulted. Defaulting the serial is exactly how a command
// silently lands on a second attached device, which on a shared CI box means a
// green run that tested nothing.
function requireSerial(serial) {
  if (typeof serial !== "string" || serial.trim().length === 0) {
    throw new UsageError("E_ADB_SERIAL_REQUIRED", "An explicit device serial is required for this adb command", {
      remediation: "Pass the serial reported by `adb devices`, for example emulator-5554."
    });
  }

  return matching(serial, SERIAL_RE, "serial");
}

function devicePath(value, field) {
  return matching(value, DEVICE_PATH_RE, field);
}

function assertArgv(args) {
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    throw commandError("args_not_string_array", {});
  }

  return args;
}

function adbEnv(serial, env) {
  // ANDROID_SERIAL alongside -s is belt and braces. Any adb sub invocation that
  // loses the flag still cannot wander onto another device.
  return Object.freeze({ ...env, ANDROID_SERIAL: serial });
}

const DEFAULT_SDK_SUBPATHS = Object.freeze(["platform-tools"]);

function adbBinaryName(platform) {
  return platform === "win32" ? "adb.exe" : "adb";
}

function candidateSdkRoots(env, platform) {
  const roots = [];
  if (typeof env.ANDROID_HOME === "string" && env.ANDROID_HOME.length > 0) {
    roots.push(env.ANDROID_HOME);
  }
  if (typeof env.ANDROID_SDK_ROOT === "string" && env.ANDROID_SDK_ROOT.length > 0) {
    roots.push(env.ANDROID_SDK_ROOT);
  }
  if (platform === "win32" && typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.length > 0) {
    roots.push(path.join(env.LOCALAPPDATA, "Android", "Sdk"));
  }
  if (platform !== "win32" && typeof env.HOME === "string" && env.HOME.length > 0) {
    roots.push(path.join(env.HOME, "Android", "Sdk"));
  }
  return roots;
}

/**
 * Locate the adb binary without ever consulting PATH through a shell.
 *
 * `exists` is injected so this stays a pure function of its inputs and can be
 * asserted on a machine with no SDK at all.
 */
export function resolveAdbPath({ env = {}, platform = process.platform, exists = null } = {}) {
  const binary = adbBinaryName(platform);
  const roots = candidateSdkRoots(env, platform);
  const candidates = roots.flatMap((root) => DEFAULT_SDK_SUBPATHS.map((sub) => path.join(root, sub, binary)));

  if (typeof exists !== "function") {
    return candidates.length > 0 ? candidates[0] : binary;
  }

  const found = candidates.find((candidate) => exists(candidate) === true);
  if (found !== undefined) {
    return found;
  }

  throw new UsageError("E_ADB_NOT_FOUND", "Could not locate the adb binary", {
    searched: candidates,
    remediation: "Set ANDROID_HOME or ANDROID_SDK_ROOT to the Android SDK directory that contains platform-tools."
  });
}

/**
 * Build one adb invocation as data.
 *
 * The return value is always `{ command, args, env }` with `args` an ARRAY.
 * There is no code path here that produces a command string, because a string
 * is what would need a shell, and a shell is what rewrites device paths on
 * Git Bash and what makes argument injection possible.
 */
export function adbCommand({ serial = null, args, adbPath = "adb", env = null } = {}) {
  assertArgv(args);
  const prefix = serial === null ? [] : ["-s", requireSerial(serial)];

  return deepFreeze({
    command: adbPath,
    args: [...prefix, ...args],
    env: serial === null ? Object.freeze({ ...env }) : adbEnv(serial, env)
  });
}

export function shellCommand({ serial, argv, adbPath = "adb", env = null } = {}) {
  assertArgv(argv);
  return adbCommand({ serial: requireSerial(serial), args: ["shell", ...argv], adbPath, env });
}

function buildOne(kind, input, adbPath, env) {
  const cmd = (args) => adbCommand({ serial: input.serial, args, adbPath, env });
  const sh = (argv) => shellCommand({ serial: input.serial, argv, adbPath, env });

  // `devices` is the only command that legitimately has no device scope,
  // because it is the one that discovers them.
  if (kind === ADB_COMMANDS.devices) {
    return adbCommand({ args: ["devices", "-l"], adbPath, env });
  }

  // Validated up front for every device scoped command, so a builder cannot
  // reach its argv construction without a serial having been checked.
  requireSerial(input.serial);

  if (kind === ADB_COMMANDS.getState) {
    return cmd(["get-state"]);
  }
  if (kind === ADB_COMMANDS.waitForDevice) {
    return cmd(["wait-for-device"]);
  }
  if (kind === ADB_COMMANDS.getProp) {
    return sh(["getprop", matching(input.prop, PROP_RE, "prop")]);
  }
  if (kind === ADB_COMMANDS.install) {
    return cmd(["install", "-r", "-g", matching(input.apkPath, /^.+$/u, "apkPath")]);
  }
  if (kind === ADB_COMMANDS.uninstall) {
    return cmd(["uninstall", matching(input.packageName, PACKAGE_RE, "packageName")]);
  }
  if (kind === ADB_COMMANDS.forceStop) {
    return sh(["am", "force-stop", matching(input.packageName, PACKAGE_RE, "packageName")]);
  }
  if (kind === ADB_COMMANDS.startActivity) {
    return sh(startActivityArgv(input));
  }
  if (kind === ADB_COMMANDS.screencap) {
    return cmd(["exec-out", "screencap", "-p"]);
  }
  if (kind === ADB_COMMANDS.screenrecord) {
    return sh(["screenrecord", "--time-limit", String(recordSeconds(input)), devicePath(input.devicePath, "devicePath")]);
  }
  if (kind === ADB_COMMANDS.uiDump) {
    return sh(["uiautomator", "dump", devicePath(input.devicePath, "devicePath")]);
  }
  if (kind === ADB_COMMANDS.pull) {
    return cmd(["pull", devicePath(input.devicePath, "devicePath"), matching(input.hostPath, /^.+$/u, "hostPath")]);
  }
  // exec-out streams the file's bytes back on stdout, so no host path is ever
  // handed to adb. That is what keeps the Git Bash path rewriting trap out of
  // the evidence path entirely, rather than working around it.
  if (kind === ADB_COMMANDS.readFile) {
    return cmd(["exec-out", "cat", devicePath(input.devicePath, "devicePath")]);
  }
  if (kind === ADB_COMMANDS.removeFile) {
    return sh(["rm", "-f", devicePath(input.devicePath, "devicePath")]);
  }
  if (kind === ADB_COMMANDS.inputTap) {
    return sh(["input", "tap", String(coordinate(input, "x")), String(coordinate(input, "y"))]);
  }
  if (kind === ADB_COMMANDS.inputSwipe) {
    return sh([
      "input",
      "swipe",
      String(coordinate(input, "x1")),
      String(coordinate(input, "y1")),
      String(coordinate(input, "x2")),
      String(coordinate(input, "y2")),
      String(swipeDurationMs(input))
    ]);
  }
  if (kind === ADB_COMMANDS.inputText) {
    return sh(["input", "text", deviceShellArg(matching(input.text, TEXT_RE, "text"))]);
  }
  if (kind === ADB_COMMANDS.inputKeyevent) {
    // `input keyevent` accepts several keycodes in one invocation, which is how
    // clearing a field stays one adb round trip instead of one per character.
    return sh(["input", "keyevent", ...keyevents(input)]);
  }

  return cmd(["emu", "kill"]);
}

function coordinate(input, field) {
  const value = input?.[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw commandError("invalid_coordinate", { field, value: typeof value === "number" ? value : null });
  }
  return value;
}

/**
 * Quote one value for the DEVICE side shell.
 *
 * The host side never sees a shell, and that is what DROID-03 is about. The
 * device side is different and cannot be avoided: `adb shell` joins the argv
 * with spaces and hands the result to /system/bin/sh on the device. So
 * `input text hello world` types only "hello". Free text and URIs are quoted
 * here so the device shell hands the whole value to `input` as one argument.
 * Everything else in this file is validated against a pattern with no spaces
 * and no metacharacters, so nothing else needs quoting.
 */
export function deviceShellArg(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function startActivityArgv(input) {
  const argv = ["am", "start", "-W"];

  if (input.data !== undefined && input.data !== null) {
    argv.push("-a", "android.intent.action.VIEW", "-d", deviceShellArg(matching(input.data, URI_RE, "data")));
  }

  // The component is always explicit, even for a deeplink. Letting the intent
  // resolver pick a handler is how a run silently launches a chooser dialog,
  // or another app, and then fails on the first locate.
  argv.push("-n", matching(input.component, COMPONENT_RE, "component"));

  for (const [key, value] of extraPairs(input.extras)) {
    argv.push("--es", key, deviceShellArg(value));
  }

  return argv;
}

function extraPairs(extras) {
  if (extras === undefined || extras === null) {
    return [];
  }

  const entries = extras instanceof Map ? [...extras.entries()] : Object.entries(extras);
  return entries.map(([key, value]) => [
    matching(key, EXTRA_KEY_RE, "extras.key"),
    matching(value, TEXT_RE, `extras.${key}`)
  ]);
}

function keyevents(input) {
  const values = input?.keyevents ?? [input?.keyevent];

  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_KEYEVENTS) {
    throw commandError("invalid_keyevent_count", { count: Array.isArray(values) ? values.length : null });
  }

  return values.map((value) => matching(value, KEYEVENT_RE, "keyevent"));
}

// `input swipe` takes the press duration in milliseconds. A long press is the
// same command with the same start and end point and a longer duration, which
// is why this is bounded rather than free: an unbounded duration would be a
// fixed wait wearing a different hat.
function swipeDurationMs(input) {
  const value = input?.durationMs ?? 300;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) {
    throw commandError("invalid_swipe_duration", { value: typeof value === "number" ? value : null });
  }
  return value;
}

function recordSeconds(input) {
  const value = input?.seconds ?? 180;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 180) {
    throw commandError("invalid_record_seconds", { value: typeof value === "number" ? value : null });
  }
  return value;
}

/**
 * The catalogue entry point. `kind` must be one of ADB_COMMANDS.
 */
export function buildAdbCommand(kind, input = {}, { adbPath = "adb", env = null } = {}) {
  assertKnownCommand(kind);
  return buildOne(kind, input, adbPath, env);
}
