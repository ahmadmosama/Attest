import { InfraError } from "../../errors.mjs";
import { ADB_COMMANDS, buildAdbCommand, resolveAdbPath } from "./commands.mjs";
import { parseDeviceSerials, startEmulator, waitForBoot } from "./emulator.mjs";
import { runAdb } from "./exec.mjs";

const DEFAULT_BOOT_TIMEOUT_MS = 180_000;

function noDeviceError(details) {
  return new InfraError("E_ANDROID_NO_DEVICE", "No Android device is available for this run", {
    ...details,
    remediation:
      "Set android.avd to an AVD name so the run starts one, or attach a device and set android.serial."
  });
}

function ambiguousDeviceError(serials) {
  // Picking one of several attached devices is the same class of mistake as
  // taking the first of several matching nodes: the run would pass or fail
  // against something nobody chose.
  return new InfraError("E_ANDROID_DEVICE_AMBIGUOUS", "More than one Android device is attached", {
    serials: [...serials],
    remediation: "Set android.serial to the device this run should use."
  });
}

function missingSerialError(serial, attached) {
  return new InfraError("E_ANDROID_SERIAL_UNREACHABLE", "The configured Android serial is not attached", {
    serial,
    attached: [...attached],
    remediation: "Check `adb devices`. Remove android.serial to have the run start android.avd instead."
  });
}

function adbStderr(error) {
  return typeof error?.details?.stderr === "string" ? error.details.stderr.trim() : "";
}

// Android refuses to update an installed app whose signing certificate changed.
// It is the single most common install failure during development and the
// error text is the only thing that says so, which is why it is matched by name
// rather than guessed at.
function isSignatureMismatch(error) {
  return /INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/iu.test(adbStderr(error));
}

function installFailedError(error, apkPath, packageName) {
  const stderr = adbStderr(error);

  return new InfraError("E_ANDROID_INSTALL_FAILED", "Installing the app under test failed", {
    apkPath,
    packageName,
    cause: error instanceof Error ? error.message : String(error),
    // adb puts the actual reason in stderr. Dropping it would leave an operator
    // with "install failed" and nothing to act on.
    stderr,
    remediation: isSignatureMismatch(error)
      ? `A different build of ${packageName ?? "this package"} is installed and was signed with another key. Uninstall it, or set android.package to the package this APK actually declares.`
      : "Check the APK is a debug or otherwise installable build for this device's ABI and API level."
  });
}

/**
 * A run scoped Android device.
 *
 * One emulator per run, not one per scenario. The suite creates adapters per
 * scenario, so without this the second scenario would try to boot a second
 * instance of the same AVD, which Android refuses, and the run would hang
 * waiting for a serial that can never appear.
 *
 * Every process boundary is injected (`deps`), so the whole lifecycle is
 * assertable on a machine with no SDK.
 */
export function createDeviceLease({
  avd = null,
  serial = null,
  apkPath = null,
  packageName = null,
  install = true,
  env = {},
  adbPath = null,
  bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS,
  deps = {}
} = {}) {
  const runtime = { runAdb, startEmulator, ...deps };
  let acquiring = null;
  let started = null;

  async function listSerials(adb, signal) {
    const result = await runtime.runAdb(buildAdbCommand(ADB_COMMANDS.devices, {}, { adbPath: adb }), { signal });
    return parseDeviceSerials(result.stdout);
  }

  async function attachExisting(adb, signal) {
    const attached = await listSerials(adb, signal);

    if (serial !== null) {
      if (!attached.includes(serial)) {
        throw missingSerialError(serial, attached);
      }
      await waitForBoot({ serial, adbPath: adb, deps: runtime, signal, timeoutMs: bootTimeoutMs });
      return serial;
    }

    if (attached.length === 1) {
      await waitForBoot({ serial: attached[0], adbPath: adb, deps: runtime, signal, timeoutMs: bootTimeoutMs });
      return attached[0];
    }

    if (attached.length > 1) {
      throw ambiguousDeviceError(attached);
    }

    throw noDeviceError({ attached: [] });
  }

  async function bootAvd(adb, signal) {
    const handle = await runtime.startEmulator({
      avd,
      env,
      adbPath: adb,
      deps: runtime,
      signal,
      bootTimeoutMs
    });
    started = handle;
    return handle.serial;
  }

  async function runInstall(adb, deviceSerial, signal) {
    return runtime.runAdb(
      buildAdbCommand(ADB_COMMANDS.install, { serial: deviceSerial, apkPath }, { adbPath: adb }),
      { signal }
    );
  }

  async function installApp(adb, deviceSerial, signal) {
    if (apkPath === null || install === false) {
      return false;
    }

    try {
      await runInstall(adb, deviceSerial, signal);
      return true;
    } catch (error) {
      // A signature mismatch is recoverable and only recoverable this way, so
      // the uninstall is done here rather than left to the operator. It is
      // scoped to the package the config named: nothing else on the device is
      // touched, and any other install failure is reported rather than retried.
      if (!isSignatureMismatch(error) || typeof packageName !== "string" || packageName.length === 0) {
        throw installFailedError(error, apkPath, packageName);
      }

      try {
        await runtime.runAdb(
          buildAdbCommand(ADB_COMMANDS.uninstall, { serial: deviceSerial, packageName }, { adbPath: adb }),
          { signal }
        );
        await runInstall(adb, deviceSerial, signal);
        return true;
      } catch (retryError) {
        throw installFailedError(retryError, apkPath, packageName);
      }
    }
  }

  async function provision({ signal } = {}) {
    const adb = adbPath ?? resolveAdbPath({ env });
    // An explicit serial always wins, so a CI job that already booted an
    // emulator is never second guessed by this lease.
    const deviceSerial =
      serial === null && typeof avd === "string" && avd.length > 0
        ? await bootAvd(adb, signal)
        : await attachExisting(adb, signal);
    const installed = await installApp(adb, deviceSerial, signal);

    return Object.freeze({
      serial: deviceSerial,
      adbPath: adb,
      installed,
      startedByLease: started !== null
    });
  }

  return Object.freeze({
    acquire({ signal } = {}) {
      // Memoised, so N scenarios share one boot and one install. A failed
      // provision is not cached: the next scenario gets a real second attempt
      // rather than a replay of the first failure.
      if (acquiring === null) {
        acquiring = provision({ signal }).catch((error) => {
          acquiring = null;
          throw error;
        });
      }

      return acquiring;
    },

    async shutdown() {
      // Only ever stop what this lease started. Killing a device the operator
      // attached, or one CI booted, would be a surprise with no upside.
      const handle = started;
      started = null;
      acquiring = null;

      if (handle === null) {
        return Object.freeze({ ok: true, stopped: false });
      }

      try {
        await handle.stop();
      } catch {
        // Shutdown is best effort and must never mask a run result.
      }

      return Object.freeze({ ok: true, stopped: true });
    }
  });
}
