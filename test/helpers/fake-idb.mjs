import { UsageError } from "../../src/errors.mjs";

/**
 * A committed transcript of what `idb` actually emits.
 *
 * The keys are idb's own, taken from its `ACCESSIBILITY_KEY_BY_NAME` map:
 * AXLabel, AXUniqueId, AXValue, AXFrame, title, role, role_description,
 * subrole, help, placeholder, alongside `type`, `enabled`, `frame` and
 * `custom_actions`. Transcribed rather than paraphrased, because a fixture that
 * matches the normaliser instead of matching the tool proves only that the
 * normaliser is self consistent.
 */
export const DESCRIBE_ALL_STDOUT = JSON.stringify([
  {
    AXFrame: "{{0, 0}, {390, 844}}",
    AXUniqueId: "checkout_root",
    frame: { y: 0, x: 0, width: 390, height: 844 },
    role_description: "application",
    AXLabel: "Fixture",
    content_required: false,
    type: "Application",
    title: null,
    help: null,
    custom_actions: [],
    AXValue: null,
    enabled: true,
    role: "AXApplication",
    subrole: null
  },
  {
    AXFrame: "{{20, 100}, {350, 44}}",
    AXUniqueId: "place_order",
    frame: { y: 100, x: 20, width: 350, height: 44 },
    role_description: "button",
    AXLabel: "Place order",
    content_required: false,
    type: "Button",
    title: null,
    help: null,
    custom_actions: [],
    AXValue: null,
    enabled: true,
    role: "AXButton",
    subrole: null
  },
  {
    AXFrame: "{{20, 260}, {350, 40}}",
    AXUniqueId: "note_field",
    frame: { y: 260, x: 20, width: 350, height: 40 },
    role_description: "text field",
    AXLabel: "",
    content_required: false,
    type: "TextField",
    title: null,
    help: null,
    custom_actions: [],
    AXValue: "hello",
    enabled: true,
    role: "AXTextField",
    subrole: null
  },
  {
    AXFrame: "{{20, 320}, {350, 44}}",
    AXUniqueId: "disabled_action",
    frame: { y: 320, x: 20, width: 350, height: 44 },
    role_description: "button",
    AXLabel: "Refund",
    content_required: false,
    type: "Button",
    title: null,
    help: null,
    custom_actions: [],
    AXValue: null,
    enabled: false,
    role: "AXButton",
    subrole: null
  },
  {
    // Laid out at zero size. Present in the tree, not on the screen.
    AXFrame: "{{0, 0}, {0, 0}}",
    AXUniqueId: "collapsed_banner",
    frame: { y: 0, x: 0, width: 0, height: 0 },
    role_description: "static text",
    AXLabel: "Offline",
    content_required: false,
    type: "StaticText",
    title: null,
    help: null,
    custom_actions: [],
    AXValue: null,
    enabled: true,
    role: "AXStaticText",
    subrole: null
  }
]);

// `idb list-targets --json` is newline delimited JSON objects, not a JSON array.
export const LIST_TARGETS_STDOUT = [
  '{"name": "iPhone 17", "udid": "A1B2C3D4-1111-2222-3333-444455556666", "state": "Booted", "type": "simulator", "os_version": "iOS 26.1", "architecture": "arm64"}',
  '{"name": "iPad Pro", "udid": "B2C3D4E5-1111-2222-3333-444455556666", "state": "Shutdown", "type": "simulator", "os_version": "iOS 26.1", "architecture": "arm64"}',
  ""
].join("\n");

export const FIXTURE_UDID = "A1B2C3D4-1111-2222-3333-444455556666";

/**
 * A scripted idb transport. It answers the real argv the backend builds, so
 * every layer above the process executes for real.
 */
export function createFakeIdb({ describeAll = DESCRIBE_ALL_STDOUT, failArgv = [] } = {}) {
  const transcript = [];
  const failures = new Set(failArgv);
  let elements = describeAll;

  return Object.freeze({
    async runIdb(command) {
      if (command?.command !== "idb" && typeof command?.command !== "string") {
        throw new UsageError("E_IDB_COMMAND_INVALID", "idb command must carry a command string", {});
      }

      if (!Array.isArray(command.args) || command.args.some((item) => typeof item !== "string")) {
        // The real layer refuses this too. Refused here so a regression to
        // string commands cannot pass by being handed to a lenient fake.
        throw new UsageError("E_IDB_COMMAND_INVALID", "idb args must be an array of strings", {});
      }

      const line = command.args.join(" ");
      transcript.push(Object.freeze({ command: command.command, args: Object.freeze([...command.args]), line }));

      if (failures.has(line)) {
        throw new UsageError("E_IDB_COMMAND_FAILED", "scripted idb failure", { argv: command.args });
      }

      if (line.startsWith("ui describe-all")) {
        return Object.freeze({ exitCode: 0, stdout: elements, stderr: "" });
      }

      if (line.startsWith("list-targets")) {
        return Object.freeze({ exitCode: 0, stdout: LIST_TARGETS_STDOUT, stderr: "" });
      }

      return Object.freeze({ exitCode: 0, stdout: "", stderr: "" });
    },

    setDescribeAll(next) {
      elements = next;
    },

    transcript() {
      return Object.freeze([...transcript]);
    },

    lines() {
      return Object.freeze(transcript.map((entry) => entry.line));
    }
  });
}
