import { Buffer } from "node:buffer";

import { UsageError } from "../../src/errors.mjs";

// One screen: a ready marker, an unambiguous button, a text field, a pair of
// ambiguous rows and an element with no frame. The same surface the Android
// fake carries, so the two conformance runs exercise the same shapes.
export const DEFAULT_ELEMENTS = Object.freeze([
  Object.freeze({
    identifier: "checkout_root",
    type: "XCUIElementTypeOther",
    label: "",
    enabled: true,
    frame: { x: 0, y: 0, width: 390, height: 800 }
  }),
  Object.freeze({
    identifier: "place_order",
    type: "XCUIElementTypeButton",
    label: "Place order",
    enabled: true,
    frame: { x: 20, y: 100, width: 350, height: 44 }
  }),
  Object.freeze({
    identifier: "cart_count",
    type: "XCUIElementTypeStaticText",
    label: "1",
    enabled: true,
    frame: { x: 20, y: 200, width: 40, height: 20 }
  }),
  Object.freeze({
    identifier: "note_field",
    type: "XCUIElementTypeTextField",
    label: "",
    value: "hello",
    enabled: true,
    hasFocus: true,
    frame: { x: 20, y: 260, width: 350, height: 40 }
  }),
  Object.freeze({
    identifier: "disabled_action",
    type: "XCUIElementTypeButton",
    label: "Refund",
    enabled: false,
    frame: { x: 20, y: 320, width: 350, height: 44 }
  })
]);

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cf000001010100b5fbb6e40000000049454e44ae426082",
  "hex"
);

/**
 * A scripted simctl and accessibility source.
 *
 * It answers the real argv the adapter builds, so command construction, locate,
 * ambiguity refusal, tap arithmetic and evidence writing all execute for real.
 * Only the simulator is simulated, which is the point: IOS-02 exists so the
 * adapter cannot rot between the CI runs that are the only place it can
 * actually execute.
 */
export function createFakeSimctl({ elements = DEFAULT_ELEMENTS, failCommands = [] } = {}) {
  const transcript = [];
  const taps = [];
  const typed = [];
  const failures = new Set(failCommands);
  let current = elements;

  function record(args) {
    transcript.push(Object.freeze({ args: Object.freeze([...args]), at: transcript.length }));
  }

  return Object.freeze({
    async runSimctl(command, { encoding = "utf8" } = {}) {
      if (!Array.isArray(command?.args) || command.args.some((item) => typeof item !== "string")) {
        // The real command layer refuses this too. The fake refuses it so a
        // regression to string commands cannot pass the conformance run.
        throw new UsageError("E_IOS_COMMAND_INVALID", "simctl args must be an array of strings", {});
      }

      record(command.args);
      const line = command.args.join(" ");

      if (failures.has(line)) {
        throw new UsageError("E_IOS_COMMAND_FAILED", "scripted simctl failure", { argv: command.args });
      }

      if (command.args.includes("screenshot")) {
        return Object.freeze({ exitCode: 0, bytes: PNG_BYTES, stdout: encoding === "buffer" ? PNG_BYTES : "" });
      }

      return Object.freeze({ exitCode: 0, stdout: "", stderr: "" });
    },

    async describeElements() {
      return current;
    },

    async tap({ point, longPress }) {
      taps.push(Object.freeze({ ...point, longPress: longPress === true }));
      return Object.freeze({ ok: true });
    },

    async type({ text }) {
      typed.push(text);
      return Object.freeze({ ok: true });
    },

    setElements(next) {
      current = next;
    },

    transcript() {
      return Object.freeze([...transcript]);
    },

    taps() {
      return Object.freeze([...taps]);
    },

    typed() {
      return Object.freeze([...typed]);
    }
  });
}

export function fakeSimulatorLease({ deviceId = "SIM-0001" } = {}) {
  return Object.freeze({
    async acquire() {
      return Object.freeze({
        deviceId,
        xcodeVersion: "26.1",
        runtimeName: "iOS",
        runtimeVersion: "26.1",
        bundleId: "test.attest.fixture",
        screenshotDir: "/tmp/attest-ios"
      });
    },
    async shutdown() {
      return Object.freeze({ ok: true, stopped: false });
    }
  });
}
