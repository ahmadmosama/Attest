import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { InfraError } from "../../../src/errors.mjs";
import {
  BOOT_PROPS,
  assertAvdName,
  parseDeviceSerials,
  resolveEmulatorPath,
  startEmulator,
  stopEmulator,
  waitForBoot
} from "../../../src/surfaces/android/emulator.mjs";

const ADB = "/sdk/platform-tools/adb";
const EMU = "/sdk/emulator/emulator";
const SERIAL = "emulator-5554";

const DEVICES_HEADER = "List of devices attached";

function devicesOutput(serials) {
  return [DEVICES_HEADER, ...serials.map((serial) => `${serial}\tdevice product:sdk_gphone64_x86_64`)].join("\n");
}

// A scripted adb. Each call is recorded so a test can assert not just the
// outcome but which commands were actually issued and in what order.
function fakeAdb({ devicesSequence = [], props = {}, failEmuKill = false } = {}) {
  const calls = [];
  let devicesIndex = 0;

  return {
    calls,
    runAdb: async (command) => {
      calls.push(command.args);
      const args = command.args;

      if (args.includes("devices")) {
        const serials = devicesSequence[Math.min(devicesIndex, devicesSequence.length - 1)] ?? [];
        devicesIndex += 1;
        return { exitCode: 0, stdout: devicesOutput(serials), stderr: "" };
      }

      if (args.includes("getprop")) {
        const prop = args.at(-1);
        const value = typeof props[prop] === "function" ? props[prop]() : (props[prop] ?? "");
        return { exitCode: 0, stdout: `${value}\n`, stderr: "" };
      }

      if (args.includes("emu")) {
        if (failEmuKill) {
          throw new Error("emu kill failed");
        }
        return { exitCode: 0, stdout: "OK", stderr: "" };
      }

      return { exitCode: 0, stdout: "", stderr: "" };
    }
  };
}

function fakeSpawn() {
  const spawned = [];
  let killed = 0;
  return {
    spawned,
    killedCount: () => killed,
    spawnEmulator: async (request) => {
      spawned.push(request);
      return { kill: () => { killed += 1; } };
    }
  };
}

describe("android emulator lifecycle", () => {
  test("parseDeviceSerials reads only fully booted device lines", () => {
    const stdout = [
      DEVICES_HEADER,
      "emulator-5554\tdevice product:x",
      "emulator-5556\toffline",
      "emulator-5558\tunauthorized",
      ""
    ].join("\n");
    assert.deepEqual([...parseDeviceSerials(stdout)], ["emulator-5554"]);
  });

  test("an AVD name that is not a plain identifier is refused", () => {
    for (const name of ["a b", "avd;rm", "-avd", ""]) {
      assert.throws(() => assertAvdName(name), { code: "E_AVD_NAME_INVALID" });
    }
    assert.equal(assertAvdName("attest_pixel7_a35"), "attest_pixel7_a35");
  });

  test("resolveEmulatorPath names the fix when the SDK cannot be found", () => {
    assert.throws(() => resolveEmulatorPath({ env: {}, platform: "linux", exists: () => false }), {
      code: "E_EMULATOR_NOT_FOUND"
    });
    assert.match(
      resolveEmulatorPath({ env: { ANDROID_HOME: "/sdk" }, platform: "linux", exists: () => true }),
      /emulator/u
    );
  });

  test("boot gating waits for a boot property, not merely for adbd to answer", async () => {
    let reads = 0;
    const adb = fakeAdb({
      props: {
        "sys.boot_completed": () => {
          reads += 1;
          return reads >= 3 ? "1" : "";
        }
      }
    });

    const result = await waitForBoot({
      serial: SERIAL,
      adbPath: ADB,
      deps: adb,
      timeoutMs: 5000,
      intervalMs: 1
    });

    assert.equal(result.ok, true);
    // It must have polled rather than accepted the first answer.
    assert.equal(reads >= 3, true);
    assert.equal(BOOT_PROPS.includes("sys.boot_completed"), true);
  });

  test("an emulator that never reports boot is an infrastructure error with a remediation hint", async () => {
    const adb = fakeAdb({ props: { "sys.boot_completed": () => "" } });

    await assert.rejects(
      () => waitForBoot({ serial: SERIAL, adbPath: ADB, deps: adb, timeoutMs: 30, intervalMs: 1 }),
      (error) => {
        // This is criterion 1. A dead emulator must never be reported as a
        // failing scenario, or the operator learns to ignore red.
        assert.equal(error instanceof InfraError, true);
        assert.equal(error.code, "E_EMULATOR_BOOT_FAILED");
        assert.match(error.details.remediation, /accel-check/u);
        return true;
      }
    );
  });

  test("startEmulator spawns the AVD, waits for a new serial, gates on boot, and returns a stop handle", async () => {
    const adb = fakeAdb({
      devicesSequence: [[], [], [SERIAL]],
      props: { "sys.boot_completed": () => "1" }
    });
    const spawn = fakeSpawn();

    const handle = await startEmulator({
      avd: "attest_pixel7_a35",
      adbPath: ADB,
      emulatorPath: EMU,
      deps: { ...adb, ...spawn },
      bootTimeoutMs: 5000
    });

    assert.equal(handle.serial, SERIAL);
    assert.equal(spawn.spawned.length, 1);
    assert.equal(spawn.spawned[0].command, EMU);
    assert.deepEqual(spawn.spawned[0].args.slice(0, 2), ["-avd", "attest_pixel7_a35"]);
    // argv, never a command string
    assert.equal(Array.isArray(spawn.spawned[0].args), true);

    const stopped = await handle.stop();
    assert.equal(stopped.viaAdb, true);
    assert.equal(adb.calls.some((args) => args.includes("emu") && args.includes("kill")), true);
  });

  test("a device that was already attached before start is not mistaken for the new one", async () => {
    const preexisting = "emulator-5600";
    const adb = fakeAdb({
      devicesSequence: [[preexisting], [preexisting], [preexisting, SERIAL]],
      props: { "sys.boot_completed": () => "1" }
    });

    const handle = await startEmulator({
      avd: "attest_pixel7_a35",
      adbPath: ADB,
      emulatorPath: EMU,
      deps: { ...adb, ...fakeSpawn() },
      bootTimeoutMs: 5000
    });

    assert.equal(handle.serial, SERIAL);
  });

  test("a failed boot still tears the emulator down rather than leaking the process", async () => {
    const adb = fakeAdb({ devicesSequence: [[], [SERIAL]], props: { "sys.boot_completed": () => "" } });
    const spawn = fakeSpawn();

    await assert.rejects(
      () =>
        startEmulator({
          avd: "attest_pixel7_a35",
          adbPath: ADB,
          emulatorPath: EMU,
          deps: { ...adb, ...spawn },
          bootTimeoutMs: 40
        }),
      { code: "E_EMULATOR_BOOT_FAILED" }
    );

    assert.equal(adb.calls.some((args) => args.includes("emu") && args.includes("kill")), true);
  });

  test("stopEmulator falls back to killing the process when emu kill fails", async () => {
    const adb = fakeAdb({ failEmuKill: true });
    let killed = 0;
    const result = await stopEmulator({
      serial: SERIAL,
      adbPath: ADB,
      deps: adb,
      handle: { kill: () => { killed += 1; } }
    });

    assert.equal(result.viaAdb, false);
    assert.equal(killed, 1);
  });
});
