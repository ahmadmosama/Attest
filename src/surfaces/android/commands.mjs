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
  inputTap: "input_tap",
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
  return Object.freeze({ ...(env ?? {}), ANDROID_SERIAL: serial });
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
    env: serial === null ? Object.freeze({ ...(env ?? {}) }) : adbEnv(serial, env)
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
    return sh(["am", "start", "-W", "-n", matching(input.component, COMPONENT_RE, "component")]);
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
  if (kind === ADB_COMMANDS.inputTap) {
    return sh(["input", "tap", String(coordinate(input, "x")), String(coordinate(input, "y"))]);
  }
  if (kind === ADB_COMMANDS.inputText) {
    return sh(["input", "text", matching(input.text, /^[^\r\n]*$/u, "text")]);
  }
  if (kind === ADB_COMMANDS.inputKeyevent) {
    return sh(["input", "keyevent", matching(input.keyevent, KEYEVENT_RE, "keyevent")]);
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
