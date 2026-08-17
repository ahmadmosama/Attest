import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createIdbBackend } from "../../../src/surfaces/ios/backend.mjs";
import { IDB_COMMANDS, buildIdbCommand, normalizeElements, parseTargets } from "../../../src/surfaces/ios/idb.mjs";
import { createIosSurface } from "../../../src/surfaces/ios/adapter.mjs";
import { DESCRIBE_ALL_STDOUT, FIXTURE_UDID, LIST_TARGETS_STDOUT, createFakeIdb } from "../../helpers/fake-idb.mjs";
import { fakeSimulatorLease } from "../../helpers/fake-simctl.mjs";

const UDID = FIXTURE_UDID;

describe("the idb command layer", () => {
  test("every command is argv, never a string, so nothing is ever handed to a shell", () => {
    const commands = [
      buildIdbCommand(IDB_COMMANDS.listTargets, {}),
      buildIdbCommand(IDB_COMMANDS.describeAll, { udid: UDID }),
      buildIdbCommand(IDB_COMMANDS.tap, { udid: UDID, x: 10, y: 20 }),
      buildIdbCommand(IDB_COMMANDS.text, { udid: UDID, text: "hello world" }),
      buildIdbCommand(IDB_COMMANDS.swipe, { udid: UDID, x1: 1, y1: 2, x2: 3, y2: 4 }),
      buildIdbCommand(IDB_COMMANDS.launchApp, { udid: UDID, bundleId: "test.attest.fixture" }),
      buildIdbCommand(IDB_COMMANDS.screenshot, { udid: UDID, outputPath: "/tmp/shot.png" })
    ];

    for (const command of commands) {
      assert.equal(typeof command.command, "string");
      assert.ok(Array.isArray(command.args), "args must be an array");
      assert.ok(
        command.args.every((arg) => typeof arg === "string"),
        "every arg must already be a string"
      );
      assert.ok(Object.isFrozen(command));
    }
  });

  test("the argv matches idb's actual CLI", () => {
    // Pinned against idb's own command modules, not against what would be
    // convenient here. If idb renames a subcommand this test is where it shows
    // up, rather than in a macOS run three weeks later.
    assert.deepEqual(buildIdbCommand(IDB_COMMANDS.listTargets, {}).args, ["list-targets", "--json"]);
    assert.deepEqual(buildIdbCommand(IDB_COMMANDS.describeAll, { udid: UDID }).args, [
      "ui",
      "describe-all",
      "--udid",
      UDID
    ]);
    assert.deepEqual(buildIdbCommand(IDB_COMMANDS.tap, { udid: UDID, x: 195, y: 122 }).args, [
      "ui",
      "tap",
      "195",
      "122",
      "--duration",
      "0.1",
      "--udid",
      UDID
    ]);
    assert.deepEqual(buildIdbCommand(IDB_COMMANDS.text, { udid: UDID, text: "hello world" }).args, [
      "ui",
      "text",
      "hello world",
      "--udid",
      UDID
    ]);
    assert.deepEqual(buildIdbCommand(IDB_COMMANDS.terminateApp, { udid: UDID, bundleId: "a.b.c" }).args, [
      "terminate",
      "a.b.c",
      "--udid",
      UDID
    ]);
  });

  test("text with a space stays ONE argv element, because idb has no device side shell", () => {
    // The counterpart to the Android trap. `adb shell input text` is joined and
    // re-split by /system/bin/sh on the device, so it needs quoting; idb takes
    // the string as one argument, so quoting it would type the quotes.
    const args = buildIdbCommand(IDB_COMMANDS.text, { udid: UDID, text: "hello world" }).args;

    assert.ok(args.includes("hello world"));
    assert.ok(!args.some((arg) => arg.includes("'")), "must not be quoted the way the adb path is");
  });

  test("a target is never defaulted to whichever simulator happens to be booted", () => {
    // idb will happily target "the only booted simulator". On a runner with two
    // of them that is a green run against a simulator nobody chose.
    assert.throws(() => buildIdbCommand(IDB_COMMANDS.describeAll, {}), { code: "E_IDB_UDID_REQUIRED" });
    assert.throws(() => buildIdbCommand(IDB_COMMANDS.tap, { x: 1, y: 2 }), { code: "E_IDB_UDID_REQUIRED" });
  });

  test("hostile input is refused rather than escaped into the argv", () => {
    for (const udid of ["--udid", "; rm -rf /", "not-a-uuid", `${UDID} extra`]) {
      assert.throws(() => buildIdbCommand(IDB_COMMANDS.describeAll, { udid }), { code: "E_IDB_COMMAND_INVALID" });
    }

    assert.throws(() => buildIdbCommand(IDB_COMMANDS.launchApp, { udid: UDID, bundleId: "--force" }), {
      code: "E_IDB_COMMAND_INVALID"
    });
    assert.throws(() => buildIdbCommand(IDB_COMMANDS.tap, { udid: UDID, x: -1, y: 0 }), {
      code: "E_IDB_COMMAND_INVALID"
    });
    assert.throws(() => buildIdbCommand(IDB_COMMANDS.tap, { udid: UDID, x: 1.5, y: 0 }), {
      code: "E_IDB_COMMAND_INVALID"
    });
    assert.throws(() => buildIdbCommand("teleport", { udid: UDID }), { code: "E_IDB_COMMAND_INVALID" });
  });
});

describe("normalising what idb returns", () => {
  test("idb's accessibility keys map onto the shape the locator matches over", () => {
    const elements = normalizeElements(DESCRIBE_ALL_STDOUT);

    const button = elements.find((element) => element.identifier === "place_order");
    assert.equal(button.label, "Place order", "AXLabel becomes label");
    assert.equal(button.type, "Button");
    assert.equal(button.enabled, true);
    assert.deepEqual(button.frame, { x: 20, y: 100, width: 350, height: 44 });

    const field = elements.find((element) => element.identifier === "note_field");
    assert.equal(field.value, "hello", "AXValue becomes value, which is where typed text lands");

    const disabled = elements.find((element) => element.identifier === "disabled_action");
    assert.equal(disabled.enabled, false);
    assert.ok(disabled.frame !== null, "a disabled element still has a frame, so it is still locatable");
  });

  test("a zero sized element has no frame, so it can never be tapped", () => {
    const collapsed = normalizeElements(DESCRIBE_ALL_STDOUT).find(
      (element) => element.identifier === "collapsed_banner"
    );

    // It is in the tree. It is not on the screen. Treating it as visible is how
    // a locator resolves to something no user could touch.
    assert.equal(collapsed.frame, null);
  });

  test("output that is not the flat array is refused, not coerced to empty", () => {
    // An empty tree and an unparseable one are different facts. Flattening them
    // reports "the element is not there" for a broken companion, which sends
    // whoever is paged to the wrong place entirely.
    assert.throws(() => normalizeElements('{"AXLabel": "nested"}'), { code: "E_IDB_COMMAND_INVALID" });
    assert.throws(() => normalizeElements("null"), { code: "E_IDB_COMMAND_INVALID" });
  });

  test("list-targets is newline delimited JSON, not a JSON array", () => {
    const targets = parseTargets(LIST_TARGETS_STDOUT);

    assert.equal(targets.length, 2);
    assert.equal(targets[0].udid, UDID);
    assert.equal(targets[0].state, "Booted");
    assert.equal(targets[0].osVersion, "iOS 26.1");
    // A partial final line is what a killed companion leaves behind. Dropped,
    // rather than throwing away the targets that did parse.
    assert.equal(parseTargets(`${LIST_TARGETS_STDOUT}\n{"udid": "trunc`).length, 2);
  });
});

describe("the idb backend as the adapter's deps", () => {
  function surfaceWithIdb(fake) {
    return {
      surface: createIosSurface({
        lease: fakeSimulatorLease({ deviceId: UDID }),
        bundleId: "test.attest.fixture",
        deps: {
          runSimctl: async () => Object.freeze({ exitCode: 0, stdout: "", bytes: Buffer.alloc(0) }),
          ...createIdbBackend({ runIdb: fake.runIdb })
        }
      }),
      fake
    };
  }

  test("a click resolves through a real describe-all and lands on the element's centre", async () => {
    const fake = createFakeIdb();
    const { surface } = surfaceWithIdb(fake);
    const session = await surface.open({});

    const result = await surface.execute(session, {
      i: 0,
      kind: "click",
      locator: { strategy: "testId", value: "place_order" }
    });

    assert.equal(result.ok, true);
    // 20 + 350/2 = 195, 100 + 44/2 = 122. The arithmetic runs for real against
    // the frame idb actually reports.
    assert.deepEqual(result.detail.x, 195);
    assert.deepEqual(result.detail.y, 122);
    assert.ok(fake.lines().includes(`ui tap 195 122 --duration 0.1 --udid ${UDID}`));
  });

  test("a long press is a held tap, which is how idb expresses one", async () => {
    const fake = createFakeIdb();
    const { surface } = surfaceWithIdb(fake);
    const session = await surface.open({});

    await surface.execute(session, {
      i: 0,
      kind: "long_press",
      locator: { strategy: "testId", value: "place_order" }
    });

    assert.ok(
      fake.lines().some((line) => line.startsWith("ui tap 195 122 --duration 0.5")),
      "0.5s is the iOS threshold for a recognised long press"
    );
  });

  test("a fill taps the field and then types through idb ui text", async () => {
    const fake = createFakeIdb();
    const { surface } = surfaceWithIdb(fake);
    const session = await surface.open({});

    await surface.execute(session, {
      i: 0,
      kind: "fill",
      locator: { strategy: "testId", value: "note_field" },
      value: "two words"
    });

    const lines = fake.lines();
    assert.ok(lines.some((line) => line.startsWith("ui tap 195 280")), "taps the field to focus it first");
    assert.ok(lines.includes(`ui text two words --udid ${UDID}`));
  });

  test("expect_state disabled is writable, which needs a disabled element to be locatable", async () => {
    const fake = createFakeIdb();
    const { surface } = surfaceWithIdb(fake);
    const session = await surface.open({});

    const result = await surface.execute(session, {
      i: 0,
      kind: "expect_state",
      locator: { strategy: "testId", value: "disabled_action" },
      state: "disabled"
    });

    assert.equal(result.ok, true);
  });

  test("a broken companion surfaces as a companion failure, not as a missing element", async () => {
    const fake = createFakeIdb();
    fake.setDescribeAll("Error: could not connect to companion\n");
    const { surface } = surfaceWithIdb(fake);
    const session = await surface.open({});

    // The distinction the whole error taxonomy rests on: infrastructure that
    // broke, versus an app that is wrong. Reported as the former, and fast,
    // rather than converging for the full step timeout on a locator miss.
    const started = Date.now();
    await assert.rejects(
      () => surface.execute(session, { i: 0, kind: "click", locator: { strategy: "testId", value: "place_order" } }),
      (error) => {
        assert.notEqual(error.code, "E_IOS_NOT_FOUND");
        return true;
      }
    );
    assert.ok(Date.now() - started < 5_000, "must not burn the step timeout on a broken companion");
  });

  test("with no runner wired in, the backend names what is missing and how to install it", async () => {
    const backend = createIdbBackend({});

    await assert.rejects(() => backend.describeElements({ deviceId: UDID }), (error) => {
      assert.equal(error.code, "E_IDB_UNAVAILABLE");
      assert.match(error.details.remediation, /idb-companion/u);
      return true;
    });
  });
});
