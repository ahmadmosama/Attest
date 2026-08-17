import { existsSync } from "node:fs";
import path from "node:path";

import { ADB_COMMANDS, buildAdbCommand, resolveAdbPath } from "../../src/surfaces/android/commands.mjs";
import { parseDeviceSerials } from "../../src/surfaces/android/emulator.mjs";
import { runAdb } from "../../src/surfaces/android/exec.mjs";

export const FIXTURE_APK = path.join(".attest", "fixture", "attest-selfverify.apk");
export const FIXTURE_PACKAGE = "attest.selfverify";
export const FIXTURE_ACTIVITY = ".MainActivity";
export const FIXTURE_DEEPLINK = "attest-selfverify://customers";

/**
 * Is a real Android device reachable right now?
 *
 * Returns a device, or a reason it is not available. The reason is printed by
 * the caller: a live check that quietly passes when no device is attached is
 * exactly the failure mode this project exists to refuse, so a skip has to say
 * what was not proven.
 */
export async function probeAndroidDevice({ env = process.env } = {}) {
  let adbPath;
  try {
    adbPath = resolveAdbPath({ env, exists: existsSync });
  } catch {
    return Object.freeze({ ok: false, reason: "Android tests skipped: no Android SDK (set ANDROID_HOME)" });
  }

  let serials;
  try {
    const result = await runAdb(buildAdbCommand(ADB_COMMANDS.devices, {}, { adbPath }));
    serials = parseDeviceSerials(result.stdout);
  } catch (error) {
    return Object.freeze({
      ok: false,
      reason: `Android tests skipped: adb could not list devices (${error?.code ?? "unknown"})`
    });
  }

  if (serials.length === 0) {
    return Object.freeze({
      ok: false,
      reason: "Android tests skipped: no device attached. Start the AVD, or run with ATTEST_ANDROID_AVD set."
    });
  }

  if (serials.length > 1) {
    return Object.freeze({
      ok: false,
      reason: `Android tests skipped: ${serials.length} devices attached, set ATTEST_ANDROID_SERIAL to choose one`
    });
  }

  return Object.freeze({ ok: true, reason: null, serial: env.ATTEST_ANDROID_SERIAL ?? serials[0], adbPath });
}

export function fixtureApkAvailable({ cwd = process.cwd() } = {}) {
  return existsSync(path.resolve(cwd, FIXTURE_APK));
}

export async function skipUnlessAndroid(t, { requireApk = false } = {}) {
  const probe = await probeAndroidDevice();

  if (!probe.ok) {
    t.skip(probe.reason);
    return null;
  }

  if (requireApk && !fixtureApkAvailable()) {
    t.skip(`Android tests skipped: build the fixture APK first with \`node tools/build-fixture-apk.mjs\` (${FIXTURE_APK})`);
    return null;
  }

  return probe;
}
