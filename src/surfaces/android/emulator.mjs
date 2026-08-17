import path from "node:path";

import { InfraError, UsageError } from "../../errors.mjs";
import { converge } from "../../runtime/converge.mjs";
import { ADB_COMMANDS, buildAdbCommand, resolveAdbPath } from "./commands.mjs";
import { runAdb } from "./exec.mjs";

// Boot gating reads these in order. `adb wait-for-device` is deliberately NOT
// the gate: it returns as soon as adbd answers, which happens long before the
// package manager can install anything and before the launcher is drawn. A run
// that starts there fails on the first tap and looks like a scenario bug.
export const BOOT_PROPS = Object.freeze(["sys.boot_completed", "dev.bootcomplete"]);

// No leading hyphen, for the same reason the serial pattern forbids one: an AVD
// named "-avd" or "-no-window" would be read back by the emulator as a flag
// rather than as a name.
const AVD_NAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/u;
const SERIAL_LINE_RE = /^(\S+)\s+device\b/u;

function emulatorBinaryName(platform) {
  return platform === "win32" ? "emulator.exe" : "emulator";
}

/**
 * Locate the emulator binary the same way adb is located, from the SDK root
 * rather than from PATH, so a shell is never consulted.
 */
export function resolveEmulatorPath({ env = {}, platform = process.platform, exists = null } = {}) {
  const binary = emulatorBinaryName(platform);
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter(
    (value) => typeof value === "string" && value.length > 0
  );

  if (platform === "win32" && typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.length > 0) {
    roots.push(path.join(env.LOCALAPPDATA, "Android", "Sdk"));
  }
  if (platform !== "win32" && typeof env.HOME === "string" && env.HOME.length > 0) {
    roots.push(path.join(env.HOME, "Android", "Sdk"));
  }

  const candidates = roots.map((root) => path.join(root, "emulator", binary));
  if (typeof exists !== "function") {
    return candidates.length > 0 ? candidates[0] : binary;
  }

  const found = candidates.find((candidate) => exists(candidate) === true);
  if (found !== undefined) {
    return found;
  }

  throw new UsageError("E_EMULATOR_NOT_FOUND", "Could not locate the Android emulator binary", {
    searched: candidates,
    remediation: "Set ANDROID_HOME or ANDROID_SDK_ROOT to an SDK directory that contains the emulator directory."
  });
}

export function assertAvdName(name) {
  if (typeof name !== "string" || !AVD_NAME_RE.test(name)) {
    throw new UsageError("E_AVD_NAME_INVALID", "AVD name must be a plain identifier", {
      value: typeof name === "string" ? name : null
    });
  }

  return name;
}

/**
 * An emulator that will not boot is INFRASTRUCTURE, never a scenario failure.
 *
 * This distinction is the whole of criterion 1. Reporting a dead emulator as a
 * failing scenario is how a gate teaches its operator to ignore red, which is
 * worse than having no gate at all.
 */
function bootFailure(reason, details = {}) {
  return new InfraError("E_EMULATOR_BOOT_FAILED", `Android emulator did not become ready: ${reason}`, {
    reason,
    ...details,
    remediation:
      "Check `emulator -accel-check` returns 0, that the AVD exists in `emulator -list-avds`, " +
      "and that no stale emulator process is holding the port."
  });
}

export function parseDeviceSerials(stdout) {
  return Object.freeze(
    String(stdout ?? "")
      .split(/\r?\n/u)
      .slice(1)
      .map((line) => SERIAL_LINE_RE.exec(line.trim()))
      .filter(Boolean)
      .map((match) => match[1])
  );
}

async function listSerials(deps, adbPath) {
  const result = await deps.runAdb(buildAdbCommand(ADB_COMMANDS.devices, {}, { adbPath }));
  return parseDeviceSerials(result.stdout);
}

async function propValue(deps, adbPath, serial, prop, signal) {
  try {
    const result = await deps.runAdb(buildAdbCommand(ADB_COMMANDS.getProp, { serial, prop }, { adbPath }), {
      signal
    });
    return String(result.stdout ?? "").trim();
  } catch {
    // A property read failing mid boot is expected, adbd may not be up yet.
    return "";
  }
}

/**
 * Gate on the device actually being usable, not on adbd answering.
 */
export async function waitForBoot({ serial, adbPath, deps, signal, timeoutMs = 180_000, intervalMs = 1000 } = {}) {
  const runtime = { runAdb, ...deps };

  const outcome = await converge({
    signal,
    timeoutMs,
    intervalMs,
    probe: async () => {
      const values = [];
      for (const prop of BOOT_PROPS) {
        values.push(await propValue(runtime, adbPath, serial, prop, signal));
      }
      return { ok: values.includes("1") };
    }
  });

  if (outcome?.ok !== true) {
    throw bootFailure("boot properties never reported completion", { serial, props: [...BOOT_PROPS], timeoutMs });
  }

  return Object.freeze({ ok: true, serial });
}

/**
 * Start an AVD, gate on full boot, and hand back a stop function.
 *
 * `spawnEmulator` is injected so the whole lifecycle is unit testable with no
 * emulator present, on any OS.
 */
export async function startEmulator({
  avd,
  env = {},
  adbPath = null,
  emulatorPath = null,
  deps = {},
  signal,
  bootTimeoutMs = 180_000,
  extraArgs = []
} = {}) {
  const name = assertAvdName(avd);
  const runtime = { runAdb, ...deps };
  const adb = adbPath ?? resolveAdbPath({ env });
  const emulator = emulatorPath ?? resolveEmulatorPath({ env });

  const before = new Set(await listSerials(runtime, adb));

  const handle = await runtime.spawnEmulator({
    command: emulator,
    args: ["-avd", name, "-no-boot-anim", ...extraArgs],
    env
  });

  let serial = null;
  try {
    const appeared = await converge({
      signal,
      timeoutMs: bootTimeoutMs,
      intervalMs: 1000,
      probe: async () => {
        const now = await listSerials(runtime, adb);
        const fresh = now.find((candidate) => !before.has(candidate));
        if (fresh === undefined) {
          return { ok: false };
        }
        serial = fresh;
        return { ok: true, value: fresh };
      }
    });

    if (appeared?.ok !== true || serial === null) {
      throw bootFailure("no new device serial appeared", { avd: name, bootTimeoutMs });
    }

    await waitForBoot({ serial, adbPath: adb, deps: runtime, signal, timeoutMs: bootTimeoutMs });
  } catch (error) {
    await stopEmulator({ serial, adbPath: adb, deps: runtime, handle }).catch(() => {});
    throw error;
  }

  return Object.freeze({
    serial,
    avd: name,
    adbPath: adb,
    stop: () => stopEmulator({ serial, adbPath: adb, deps: runtime, handle })
  });
}

export async function stopEmulator({ serial, adbPath, deps = {}, handle = null, signal } = {}) {
  const runtime = { runAdb, ...deps };
  let stopped = false;

  if (typeof serial === "string" && serial.length > 0) {
    try {
      await runtime.runAdb(buildAdbCommand(ADB_COMMANDS.emuKill, { serial }, { adbPath }), { signal });
      stopped = true;
    } catch {
      // Fall through to the process handle. `emu kill` failing is expected when
      // the emulator is already gone, and it must not mask the original error
      // on the failure path that called us.
    }
  }

  if (!stopped && typeof handle?.kill === "function") {
    handle.kill();
  }

  return Object.freeze({ ok: true, serial: serial ?? null, viaAdb: stopped });
}
