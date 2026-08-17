import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import {
  ADB_COMMANDS,
  adbCommand,
  buildAdbCommand,
  resolveAdbPath,
  shellCommand
} from "../../../src/surfaces/android/commands.mjs";
import { runAdb } from "../../../src/surfaces/android/exec.mjs";

const SERIAL = "emulator-5554";
const ADB = "/opt/android/platform-tools/adb";
const SNAPSHOT_PATH = path.join(process.cwd(), "test/surfaces/android/__snapshots__/adb-commands.json");
const COMMANDS_SOURCE = path.join(process.cwd(), "src/surfaces/android/commands.mjs");

const existsFromSdkRoot = (candidate) => candidate.includes("from-sdk-root");

// One full lifecycle, in the order a real Android run performs it. This is the
// transcript the committed snapshot pins.
function lifecycle() {
  const opts = { adbPath: ADB };
  return [
    buildAdbCommand(ADB_COMMANDS.devices, {}, opts),
    buildAdbCommand(ADB_COMMANDS.waitForDevice, { serial: SERIAL }, opts),
    buildAdbCommand(ADB_COMMANDS.getProp, { serial: SERIAL, prop: "sys.boot_completed" }, opts),
    buildAdbCommand(ADB_COMMANDS.install, { serial: SERIAL, apkPath: "C:\\builds\\fixture.apk" }, opts),
    buildAdbCommand(ADB_COMMANDS.startActivity, { serial: SERIAL, component: "com.attest.fixture/.MainActivity" }, opts),
    buildAdbCommand(ADB_COMMANDS.uiDump, { serial: SERIAL, devicePath: "/sdcard/ui.xml" }, opts),
    buildAdbCommand(ADB_COMMANDS.pull, { serial: SERIAL, devicePath: "/sdcard/ui.xml", hostPath: "C:\\runs\\ui.xml" }, opts),
    buildAdbCommand(ADB_COMMANDS.inputTap, { serial: SERIAL, x: 120, y: 340 }, opts),
    buildAdbCommand(ADB_COMMANDS.inputText, { serial: SERIAL, text: "hello" }, opts),
    buildAdbCommand(ADB_COMMANDS.screencap, { serial: SERIAL }, opts),
    buildAdbCommand(ADB_COMMANDS.forceStop, { serial: SERIAL, packageName: "com.attest.fixture" }, opts),
    buildAdbCommand(ADB_COMMANDS.emuKill, { serial: SERIAL }, opts)
  ];
}

describe("android adb command construction", () => {
  test("every built command is argv data, never a shell string", () => {
    for (const entry of lifecycle()) {
      assert.equal(typeof entry.command, "string");
      assert.equal(Array.isArray(entry.args), true, `args must be an array for ${entry.args}`);
      for (const arg of entry.args) {
        assert.equal(typeof arg, "string");
      }
      assert.equal(Object.isFrozen(entry), true);
    }
  });

  test("every device scoped command carries the serial twice, as a flag and in the environment", () => {
    for (const entry of lifecycle().slice(1)) {
      assert.equal(entry.args[0], "-s");
      assert.equal(entry.args[1], SERIAL);
      assert.equal(entry.env.ANDROID_SERIAL, SERIAL);
    }
  });

  test("a device scoped command without a serial is refused rather than defaulted", () => {
    // Defaulting is how a command silently lands on a second attached device.
    for (const kind of [ADB_COMMANDS.getState, ADB_COMMANDS.inputTap, ADB_COMMANDS.uiDump]) {
      assert.throws(() => buildAdbCommand(kind, { x: 1, y: 1, devicePath: "/sdcard/ui.xml" }), {
        code: "E_ADB_SERIAL_REQUIRED"
      });
    }
  });

  test("a serial carrying a flag or a shell metacharacter is refused", () => {
    for (const serial of ["-s", "emulator-5554; rm -rf /", "emu`whoami`", "a b"]) {
      assert.throws(() => adbCommand({ serial, args: ["get-state"] }), { code: "E_ADB_COMMAND_INVALID" });
    }
  });

  test("a device path that is not an absolute POSIX path is refused", () => {
    assert.throws(
      () => buildAdbCommand(ADB_COMMANDS.uiDump, { serial: SERIAL, devicePath: "C:\\sdcard\\ui.xml" }),
      { code: "E_ADB_COMMAND_INVALID" }
    );
  });

  test("a package name or component that is not a plain identifier is refused", () => {
    assert.throws(() => buildAdbCommand(ADB_COMMANDS.forceStop, { serial: SERIAL, packageName: "a; b" }), {
      code: "E_ADB_COMMAND_INVALID"
    });
    assert.throws(() => buildAdbCommand(ADB_COMMANDS.startActivity, { serial: SERIAL, component: "no-slash" }), {
      code: "E_ADB_COMMAND_INVALID"
    });
  });

  test("args must be an array of strings at every entry point", () => {
    assert.throws(() => adbCommand({ serial: SERIAL, args: "get-state" }), { code: "E_ADB_COMMAND_INVALID" });
    assert.throws(() => shellCommand({ serial: SERIAL, argv: [1, 2] }), { code: "E_ADB_COMMAND_INVALID" });
  });

  test("an unknown command kind is refused and names the accepted set", () => {
    assert.throws(() => buildAdbCommand("reboot_bootloader", { serial: SERIAL }), { code: "E_ADB_COMMAND_INVALID" });
  });

  test("resolveAdbPath prefers ANDROID_HOME then ANDROID_SDK_ROOT and names the fix when absent", () => {
    assert.match(
      resolveAdbPath({ env: { ANDROID_SDK_ROOT: "/from-sdk-root" }, platform: "linux", exists: existsFromSdkRoot }),
      /from-sdk-root/u
    );
    assert.throws(() => resolveAdbPath({ env: {}, platform: "linux", exists: () => false }), {
      code: "E_ADB_NOT_FOUND"
    });
  });

  test("the command module cannot spawn a process", async () => {
    const source = await readFile(COMMANDS_SOURCE, "utf8");
    assert.doesNotMatch(source, /node:child_process/u);
    assert.doesNotMatch(source, /\bexecSync\b|\bspawnSync\b/u);
  });

  test("runAdb refuses a command whose args is not an array", async () => {
    await assert.rejects(() => runAdb({ command: "adb", args: "devices" }), TypeError);
  });

  test("the lifecycle transcript matches the committed snapshot", async () => {
    const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
    assert.deepEqual(JSON.parse(JSON.stringify(lifecycle())), snapshot);
  });

  test("no snapshot entry needs a shell to be correct", async () => {
    const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
    for (const entry of snapshot) {
      assert.equal(Array.isArray(entry.args), true);
      // A shell metacharacter in an argv element is harmless because there is
      // no shell, but its presence in the snapshot would mean a builder had
      // started concatenating, which is the regression worth catching.
      for (const arg of entry.args) {
        assert.doesNotMatch(arg, /[;&|><`$]/u);
      }
    }
  });
});
