import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { InfraError } from "../../../src/errors.mjs";
import { createDeviceLease } from "../../../src/surfaces/android/device.mjs";
import { createFakeAdb } from "../../helpers/fake-adb.mjs";

const ADB = "/opt/android/platform-tools/adb";

function leaseWith(options = {}, adbOptions = {}) {
  const adb = createFakeAdb(adbOptions);
  const started = [];
  const stopped = [];

  const lease = createDeviceLease({
    adbPath: ADB,
    bootTimeoutMs: 2000,
    ...options,
    deps: {
      runAdb: adb.runAdb,
      async startEmulator({ avd }) {
        started.push(avd);
        return Object.freeze({
          serial: "emulator-5556",
          avd,
          adbPath: ADB,
          stop: async () => {
            stopped.push(avd);
            return Object.freeze({ ok: true });
          }
        });
      },
      ...options.deps
    }
  });

  return { lease, adb, started, stopped };
}

describe("android device lease", () => {
  test("an explicit serial attaches without starting an emulator", async () => {
    const { lease, started } = leaseWith({ serial: "emulator-5554", avd: "attest_pixel7_a35" });
    const device = await lease.acquire();

    assert.equal(device.serial, "emulator-5554");
    assert.equal(device.startedByLease, false);
    assert.deepEqual(started, []);
  });

  test("no serial starts the configured AVD once and reuses it", async () => {
    const { lease, started } = leaseWith({ avd: "attest_pixel7_a35" });

    const first = await lease.acquire();
    const second = await lease.acquire();

    assert.equal(first.serial, "emulator-5556");
    assert.equal(second.serial, first.serial);
    // One boot for the whole run. A second boot of the same AVD is refused by
    // Android, so a per scenario boot would hang the second scenario forever.
    assert.deepEqual(started, ["attest_pixel7_a35"]);
  });

  test("the APK installs once for the whole run, not once per scenario", async () => {
    const { lease, adb } = leaseWith({
      serial: "emulator-5554",
      apkPath: "C:\\builds\\fixture.apk",
      packageName: "attest.selfverify"
    });

    await lease.acquire();
    await lease.acquire();
    await lease.acquire();

    const installs = adb.transcript().filter((entry) => entry.args.includes("install"));
    assert.equal(installs.length, 1);
    assert.deepEqual(installs[0].args, ["-s", "emulator-5554", "install", "-r", "-g", "C:\\builds\\fixture.apk"]);
  });

  test("install can be turned off for an already installed build", async () => {
    const { lease, adb } = leaseWith({ serial: "emulator-5554", apkPath: "a.apk", install: false });
    const device = await lease.acquire();

    assert.equal(device.installed, false);
    assert.equal(adb.transcript().some((entry) => entry.args.includes("install")), false);
  });

  test("shutdown stops an emulator this lease started", async () => {
    const { lease, stopped } = leaseWith({ avd: "attest_pixel7_a35" });

    await lease.acquire();
    const result = await lease.shutdown();

    assert.equal(result.stopped, true);
    assert.deepEqual(stopped, ["attest_pixel7_a35"]);
  });

  test("shutdown never kills a device the lease merely attached to", async () => {
    const { lease, stopped } = leaseWith({ serial: "emulator-5554" });

    await lease.acquire();
    const result = await lease.shutdown();

    assert.equal(result.stopped, false);
    assert.deepEqual(stopped, []);
  });

  test("no device and no avd is an infrastructure error naming the fix", async () => {
    const { lease } = leaseWith({}, { serials: [] });

    await assert.rejects(
      () => lease.acquire(),
      (error) => {
        assert(error instanceof InfraError);
        assert.equal(error.code, "E_ANDROID_NO_DEVICE");
        assert.match(error.details.remediation, /android\.avd/);
        return true;
      }
    );
  });

  test("more than one attached device is refused rather than picked", async () => {
    const { lease } = leaseWith({}, { serials: ["emulator-5554", "emulator-5556"] });

    await assert.rejects(
      () => lease.acquire(),
      (error) => {
        assert.equal(error.code, "E_ANDROID_DEVICE_AMBIGUOUS");
        assert.deepEqual(error.details.serials, ["emulator-5554", "emulator-5556"]);
        return true;
      }
    );
  });

  test("a configured serial that is not attached names what is attached", async () => {
    const { lease } = leaseWith({ serial: "emulator-9999" }, { serials: ["emulator-5554"] });

    await assert.rejects(
      () => lease.acquire(),
      (error) => {
        assert.equal(error.code, "E_ANDROID_SERIAL_UNREACHABLE");
        assert.deepEqual(error.details.attached, ["emulator-5554"]);
        return true;
      }
    );
  });

  test("an emulator that never boots is infrastructure, not a scenario failure", async () => {
    const adb = createFakeAdb({ booted: false });
    const lease = createDeviceLease({
      adbPath: ADB,
      serial: "emulator-5554",
      bootTimeoutMs: 300,
      deps: { runAdb: adb.runAdb }
    });

    await assert.rejects(
      () => lease.acquire(),
      (error) => {
        assert(error instanceof InfraError);
        assert.equal(error.code, "E_EMULATOR_BOOT_FAILED");
        assert.match(error.details.remediation, /accel-check/);
        return true;
      }
    );
  });

  test("a failed acquire is not cached, so the next scenario gets a real attempt", async () => {
    let serials = [];
    const adb = createFakeAdb();
    const lease = createDeviceLease({
      adbPath: ADB,
      bootTimeoutMs: 2000,
      deps: {
        runAdb: async (command, options) => {
          if (command.args.includes("devices")) {
            return Object.freeze({
              exitCode: 0,
              stdout: ["List of devices attached", ...serials.map((s) => `${s}\tdevice`)].join("\n"),
              stderr: ""
            });
          }
          return adb.runAdb(command, options);
        }
      }
    });

    await assert.rejects(() => lease.acquire(), { code: "E_ANDROID_NO_DEVICE" });

    serials = ["emulator-5554"];
    const device = await lease.acquire();
    assert.equal(device.serial, "emulator-5554");
  });

  test("a failed install is reported as infrastructure with the apk path", async () => {
    const { lease } = leaseWith(
      { serial: "emulator-5554", apkPath: "broken.apk" },
      { failCommands: ["-s emulator-5554 install -r -g broken.apk"] }
    );

    await assert.rejects(
      () => lease.acquire(),
      (error) => {
        assert(error instanceof InfraError);
        assert.equal(error.code, "E_ANDROID_INSTALL_FAILED");
        assert.equal(error.details.apkPath, "broken.apk");
        return true;
      }
    );
  });
});
