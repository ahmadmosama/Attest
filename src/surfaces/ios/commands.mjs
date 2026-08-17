import { UsageError } from "../../errors.mjs";

export const IOS_COMMANDS = Object.freeze({
  listRuntimes: "list_runtimes",
  assertRuntime: "assert_runtime",
  bootSimulator: "boot_simulator",
  installApp: "install_app",
  launchApp: "launch_app",
  screenshot: "screenshot",
  shutdown: "shutdown"
});

const IOS_COMMAND_SET = new Set(Object.values(IOS_COMMANDS));
const VERSION_RE = /^\d+(?:\.\d+){0,2}$/u;

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
  return new UsageError("E_IOS_COMMAND_INVALID", "Invalid iOS command request", {
    reason,
    ...details
  });
}

function iosDeviceArtifact(value) {
  throw new UsageError(
    "E_IOS_DEVICE_ARTIFACT",
    `'${value}' is a device build. The iOS Simulator cannot install a device .ipa. Build for ` +
      "`generic/platform=iOS Simulator` and pass the resulting .app bundle " +
      "(a directory, or that directory zipped) instead.",
    { value }
  );
}

function assertKnownCommand(kind) {
  if (!IOS_COMMAND_SET.has(kind)) {
    throw commandError("unknown_command", {
      command: kind,
      accepted: Object.values(IOS_COMMANDS)
    });
  }
}

function nonEmptyString(input, field) {
  if (typeof input?.[field] !== "string" || input[field].trim().length === 0) {
    throw commandError("missing_string", { field });
  }

  return input[field];
}

function pinnedVersion(input, field) {
  const value = nonEmptyString(input, field);
  if (!VERSION_RE.test(value)) {
    throw commandError("invalid_version", { field, value });
  }

  return value;
}

function developerDirFor(xcodeVersion) {
  return `/Applications/Xcode_${xcodeVersion}.app/Contents/Developer`;
}

function runtimeIdentifier({ runtimeName, runtimeVersion }) {
  return `${runtimeName} ${runtimeVersion}`;
}

function baseSession(input) {
  const xcodeVersion = pinnedVersion(input, "xcodeVersion");
  const runtimeVersion = pinnedVersion(input, "runtimeVersion");
  const runtimeName = nonEmptyString(input, "runtimeName");

  return Object.freeze({
    xcodeVersion,
    runtimeName,
    runtimeVersion,
    developerDir: developerDirFor(xcodeVersion),
    runtimeIdentifier: runtimeIdentifier({ runtimeName, runtimeVersion })
  });
}

function baseEnv(session, extra = {}) {
  return deepFreeze({
    DEVELOPER_DIR: session.developerDir,
    ATTEST_XCODE_VERSION: session.xcodeVersion,
    ATTEST_IOS_RUNTIME: session.runtimeIdentifier,
    ...extra
  });
}

function commandDescription({ command = "xcrun", args, env }) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw commandError("args_must_be_array");
  }

  return deepFreeze({
    command,
    args: [...args],
    env: { ...env }
  });
}

function appBundlePath(input) {
  const appPath = nonEmptyString(input, "appPath");
  if (appPath.toLowerCase().endsWith(".ipa")) {
    iosDeviceArtifact(appPath);
  }

  if (!appPath.toLowerCase().endsWith(".app")) {
    throw commandError("app_path_must_be_app_bundle", { appPath });
  }

  return appPath;
}

function listRuntimesCommand(input) {
  const session = baseSession(input);
  return commandDescription({
    args: ["simctl", "list", "runtimes", "available"],
    env: baseEnv(session)
  });
}

function assertRuntimeCommand(input) {
  const session = baseSession(input);
  return commandDescription({
    args: ["simctl", "list", "runtimes", "available"],
    env: baseEnv(session, {
      ATTEST_EXPECTED_IOS_RUNTIME: session.runtimeIdentifier
    })
  });
}

function simulatorNameCommand(input, action) {
  const session = baseSession(input);
  const simulatorName = nonEmptyString(input, "simulatorName");
  return commandDescription({
    args: ["simctl", action, simulatorName],
    env: baseEnv(session)
  });
}

function bootCommand(input) {
  return simulatorNameCommand(input, "boot");
}

function shutdownCommand(input) {
  return simulatorNameCommand(input, "shutdown");
}

function deviceTarget(input) {
  return nonEmptyString(input, "device");
}

function installCommand(input) {
  const session = baseSession(input);
  return commandDescription({
    args: ["simctl", "install", deviceTarget(input), appBundlePath(input)],
    env: baseEnv(session)
  });
}

function launchCommand(input) {
  const session = baseSession(input);
  return commandDescription({
    args: ["simctl", "launch", deviceTarget(input), nonEmptyString(input, "bundleId")],
    env: baseEnv(session)
  });
}

function screenshotCommand(input) {
  const session = baseSession(input);
  return commandDescription({
    args: ["simctl", "io", deviceTarget(input), "screenshot", nonEmptyString(input, "screenshotPath")],
    env: baseEnv(session)
  });
}

export function buildSessionCapabilities(input = {}) {
  const session = baseSession(input);
  const simulatorName = nonEmptyString(input, "simulatorName");
  const bundleId = nonEmptyString(input, "bundleId");

  return deepFreeze({
    surface: "ios",
    runner: "simulator",
    xcode: {
      version: session.xcodeVersion,
      developerDir: session.developerDir
    },
    runtime: {
      name: session.runtimeName,
      version: session.runtimeVersion,
      identifier: session.runtimeIdentifier
    },
    simulator: {
      name: simulatorName
    },
    app: {
      bundleId
    },
    commands: Object.values(IOS_COMMANDS)
  });
}

export function buildSimctlCommand(kind, input = {}) {
  assertKnownCommand(kind);

  switch (kind) {
    case IOS_COMMANDS.listRuntimes:
      return listRuntimesCommand(input);
    case IOS_COMMANDS.assertRuntime:
      return assertRuntimeCommand(input);
    case IOS_COMMANDS.bootSimulator:
      return bootCommand(input);
    case IOS_COMMANDS.installApp:
      return installCommand(input);
    case IOS_COMMANDS.launchApp:
      return launchCommand(input);
    case IOS_COMMANDS.screenshot:
      return screenshotCommand(input);
    case IOS_COMMANDS.shutdown:
      return shutdownCommand(input);
    default:
      throw commandError("unknown_command", { command: kind });
  }
}
