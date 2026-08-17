import { Buffer } from "node:buffer";

import { AdbError } from "../../src/surfaces/android/exec.mjs";
import { InfraError } from "../../src/errors.mjs";

// A one screen app: a ready marker, two unambiguous buttons, an editable
// field, a pair of ambiguous rows, and a node with no bounds. Enough surface
// to exercise locate, ambiguity refusal, tap arithmetic and text assertions.
export const DEFAULT_HIERARCHY = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="attest.selfverify" bounds="[0,0][1080,2400]" enabled="true">
    <node index="0" resource-id="attest.selfverify:id/customer_list" class="android.widget.TextView" text="2 customers" content-desc="" bounds="[0,100][1080,200]" enabled="true" />
    <node index="1" resource-id="attest.selfverify:id/create_order_action" class="android.widget.Button" text="Create order" content-desc="create order" bounds="[40,300][540,420]" clickable="true" enabled="true" />
    <node index="2" resource-id="attest.selfverify:id/delete_customer_action" class="android.widget.Button" text="Delete customer" content-desc="" bounds="[540,300][1040,420]" clickable="true" enabled="false" />
    <node index="3" resource-id="attest.selfverify:id/note_field" class="android.widget.EditText" text="hello" content-desc="" bounds="[40,500][1040,600]" enabled="true" focused="true" />
    <node index="4" resource-id="attest.selfverify:id/customer_row" class="android.widget.TextView" text="Ada Lovelace" bounds="[40,700][1040,800]" enabled="true" />
    <node index="5" resource-id="attest.selfverify:id/customer_row" class="android.widget.TextView" text="Katherine Johnson" bounds="[40,800][1040,900]" enabled="true" />
    <node index="6" resource-id="attest.selfverify:id/offscreen" class="android.widget.TextView" text="offscreen" enabled="true" />
  </node>
</hierarchy>
`;

// A one pixel PNG. Real bytes matter because the evidence path asserts a non
// zero artifact size.
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cf000001010100b5fbb6e40000000049454e44ae426082",
  "hex"
);

function joined(args) {
  return args.join(" ");
}

function shellArgvOf(args) {
  const index = args.indexOf("shell");
  return index === -1 ? null : args.slice(index + 1);
}

/**
 * A scripted adb transport.
 *
 * It answers the real argv the adapter builds, so command construction,
 * hierarchy parsing, locate, ambiguity refusal, tap arithmetic and evidence
 * writing all execute for real. Only the device is simulated, which is the
 * same seam `startEmulator` already takes for `spawnEmulator`.
 */
export function createFakeAdb({
  hierarchy = DEFAULT_HIERARCHY,
  serials = ["emulator-5554"],
  booted = true,
  failCommands = [],
  recordingBytes = Buffer.from("fake mp4 bytes")
} = {}) {
  const transcript = [];
  const files = new Map();
  const failures = new Set(failCommands);
  let currentHierarchy = hierarchy;

  function record(args) {
    transcript.push(Object.freeze({ args: Object.freeze([...args]), at: transcript.length }));
  }

  function ok(stdout = "", encoding = "utf8") {
    const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout), "utf8");
    return Object.freeze({
      exitCode: 0,
      stdout: encoding === "buffer" ? bytes : bytes.toString("utf8"),
      stderr: ""
    });
  }

  function fail(args, stderr) {
    return new AdbError("E_ADB_COMMAND_FAILED", "adb command failed.", {
      exitCode: 1,
      argv: [...args],
      stderr
    });
  }

  function assertArgv(command) {
    if (!Array.isArray(command?.args) || command.args.some((item) => typeof item !== "string")) {
      // The real exec seam refuses this too. The fake refuses it so a
      // regression to string commands cannot pass the conformance run.
      throw new TypeError("runAdb requires args to be an array of strings");
    }
  }

  function handleShell(args, argv, encoding) {
    const line = joined(argv);

    if (argv[0] === "getprop") {
      return ok(booted ? "1" : "");
    }
    if (argv[0] === "uiautomator" && argv[1] === "dump") {
      files.set(argv[2], currentHierarchy);
      return ok(`UI hierchary dumped to: ${argv[2]}`);
    }
    if (argv[0] === "rm") {
      files.delete(argv.at(-1));
      return ok("");
    }
    if (argv[0] === "screenrecord") {
      files.set(argv.at(-1), recordingBytes);
      return ok("");
    }
    if (argv[0] === "input" || argv[0] === "am") {
      return ok("");
    }

    throw fail(args, `unsupported device command: ${line}`);
  }

  function handle(command, { encoding = "utf8" } = {}) {
    assertArgv(command);
    const args = command.args;
    record(args);

    if (failures.has(joined(args))) {
      throw fail(args, "scripted failure");
    }

    if (args[0] === "devices") {
      return ok(["List of devices attached", ...serials.map((serial) => `${serial}\tdevice`)].join("\n"));
    }

    const shellArgv = shellArgvOf(args);
    if (shellArgv !== null) {
      return handleShell(args, shellArgv, encoding);
    }

    const execOut = args.indexOf("exec-out");
    if (execOut !== -1) {
      const rest = args.slice(execOut + 1);
      if (rest[0] === "screencap") {
        return ok(PNG_BYTES, encoding);
      }
      if (rest[0] === "cat") {
        const content = files.get(rest[1]);
        if (content === undefined) {
          throw fail(args, `cat: ${rest[1]}: No such file or directory`);
        }
        return ok(Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"), encoding);
      }
    }

    if (args.includes("install") || args.includes("wait-for-device") || args.includes("emu")) {
      return ok("Success");
    }
    if (args.includes("get-state")) {
      return ok("device");
    }

    throw fail(args, `unsupported adb command: ${joined(args)}`);
  }

  return Object.freeze({
    async runAdb(command, options = {}) {
      if (options.signal?.aborted === true) {
        throw new InfraError("E_ADB_ABORTED", "adb invocation was aborted.", { argv: command?.args ?? [] });
      }

      return handle(command, options);
    },

    startAdb(command) {
      assertArgv(command);
      record(command.args);
      const shellArgv = shellArgvOf(command.args);
      if (shellArgv?.[0] === "screenrecord") {
        files.set(shellArgv.at(-1), recordingBytes);
      }

      return Object.freeze({
        argv: Object.freeze([...command.args]),
        async stop() {
          return 0;
        }
      });
    },

    setHierarchy(next) {
      currentHierarchy = next;
    },

    transcript() {
      return Object.freeze([...transcript]);
    },

    deviceFiles() {
      return new Map(files);
    }
  });
}

export function fakeDeviceLease({ serial = "emulator-5554", adbPath = "/opt/android/platform-tools/adb" } = {}) {
  return Object.freeze({
    async acquire() {
      return Object.freeze({ serial, adbPath, installed: true, startedByLease: false });
    },
    async shutdown() {
      return Object.freeze({ ok: true, stopped: false });
    }
  });
}
