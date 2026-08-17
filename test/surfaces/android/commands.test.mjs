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
    buildAdbCommand(
      ADB_COMMANDS.startActivity,
      {
        serial: SERIAL,
        component: "com.attest.fixture/.MainActivity",
        data: "attest-fixture://customers",
        extras: { attest_api_base: "http://10.0.2.2:54321" }
      },
      opts
    ),
    buildAdbCommand(ADB_COMMANDS.uiDump, { serial: SERIAL, devicePath: "/sdcard/ui.xml" }, opts),
    buildAdbCommand(ADB_COMMANDS.readFile, { serial: SERIAL, devicePath: "/sdcard/ui.xml" }, opts),
    buildAdbCommand(ADB_COMMANDS.pull, { serial: SERIAL, devicePath: "/sdcard/ui.xml", hostPath: "C:\\runs\\ui.xml" }, opts),
    buildAdbCommand(ADB_COMMANDS.inputTap, { serial: SERIAL, x: 120, y: 340 }, opts),
    buildAdbCommand(
      ADB_COMMANDS.inputSwipe,
      { serial: SERIAL, x1: 540, y1: 1600, x2: 540, y2: 400, durationMs: 300 },
      opts
    ),
    buildAdbCommand(ADB_COMMANDS.inputText, { serial: SERIAL, text: "hello world" }, opts),
    buildAdbCommand(ADB_COMMANDS.inputKeyevent, { serial: SERIAL, keyevents: ["KEYCODE_MOVE_END", "KEYCODE_DEL"] }, opts),
    buildAdbCommand(ADB_COMMANDS.screencap, { serial: SERIAL }, opts),
    buildAdbCommand(ADB_COMMANDS.screenrecord, { serial: SERIAL, devicePath: "/sdcard/rec.mp4", seconds: 180 }, opts),
    buildAdbCommand(ADB_COMMANDS.removeFile, { serial: SERIAL, devicePath: "/sdcard/rec.mp4" }, opts),
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

  test("no snapshot entry needs a HOST shell to be correct", async () => {
    const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
    for (const entry of snapshot) {
      assert.equal(Array.isArray(entry.args), true);
      // The host side never sees a shell, so a metacharacter in an argv element
      // cannot be interpreted here. What this catches is a builder that started
      // concatenating: an argument holding a space or a metacharacter must be
      // one the device shell will receive whole, which means it is quoted.
      for (const arg of entry.args) {
        if (/[;&|><`$\s]/u.test(arg)) {
          assert.match(arg, /^'.*'$/u, `unquoted device shell argument: ${arg}`);
        }
      }
    }
  });

  test("free text is quoted for the DEVICE shell, which adb always involves", () => {
    // `adb shell` joins argv with spaces and hands the string to /system/bin/sh
    // on the device, so `input text hello world` would type only "hello".
    const typed = buildAdbCommand(ADB_COMMANDS.inputText, { serial: SERIAL, text: "hello world" }, { adbPath: ADB });
    assert.equal(typed.args.at(-1), "'hello world'");

    const quoted = buildAdbCommand(ADB_COMMANDS.inputText, { serial: SERIAL, text: "it's fine" }, { adbPath: ADB });
    assert.equal(quoted.args.at(-1), "'it'\\''s fine'");

    // A newline would terminate the device side command, so it is refused
    // rather than escaped. press_key covers sending Enter.
    assert.throws(() => buildAdbCommand(ADB_COMMANDS.inputText, { serial: SERIAL, text: "a\nb" }), {
      code: "E_ADB_COMMAND_INVALID"
    });
  });

  test("keyevent lists are bounded and validated per entry", () => {
    const cleared = buildAdbCommand(
      ADB_COMMANDS.inputKeyevent,
      { serial: SERIAL, keyevents: ["KEYCODE_MOVE_END", "KEYCODE_DEL", "KEYCODE_DEL"] },
      { adbPath: ADB }
    );
    assert.deepEqual(cleared.args.slice(-3), ["KEYCODE_MOVE_END", "KEYCODE_DEL", "KEYCODE_DEL"]);

    assert.throws(
      () => buildAdbCommand(ADB_COMMANDS.inputKeyevent, { serial: SERIAL, keyevents: [] }),
      { code: "E_ADB_COMMAND_INVALID" }
    );
    assert.throws(
      () => buildAdbCommand(ADB_COMMANDS.inputKeyevent, { serial: SERIAL, keyevent: "rm -rf /" }),
      { code: "E_ADB_COMMAND_INVALID" }
    );
  });

  test("an activity start always names the component, even for a deeplink", () => {
    const started = buildAdbCommand(
      ADB_COMMANDS.startActivity,
      { serial: SERIAL, component: "com.attest.fixture/.MainActivity", data: "attest-fixture://customers" },
      { adbPath: ADB }
    );

    // Without -n the intent resolver picks the handler, which can be a chooser
    // dialog or another app entirely.
    assert(started.args.includes("-n"));
    assert(started.args.includes("com.attest.fixture/.MainActivity"));
    assert.throws(
      () => buildAdbCommand(ADB_COMMANDS.startActivity, { serial: SERIAL, component: "com.attest.fixture/.MainActivity", data: "not a uri" }),
      { code: "E_ADB_COMMAND_INVALID" }
    );
  });

  test("an intent extra key that is not a plain identifier is refused", () => {
    assert.throws(
      () =>
        buildAdbCommand(ADB_COMMANDS.startActivity, {
          serial: SERIAL,
          component: "com.attest.fixture/.MainActivity",
          extras: { "bad key": "value" }
        }),
      { code: "E_ADB_COMMAND_INVALID" }
    );
  });

  test("a swipe duration outside the accepted range is refused", () => {
    assert.throws(
      () => buildAdbCommand(ADB_COMMANDS.inputSwipe, { serial: SERIAL, x1: 0, y1: 0, x2: 1, y2: 1, durationMs: 60000 }),
      { code: "E_ADB_COMMAND_INVALID" }
    );
  });
});
