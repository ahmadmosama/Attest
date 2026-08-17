import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, test } from "node:test";

import { AttestError, UnsupportedOpError } from "../../../src/errors.mjs";
import { createAndroidSurface } from "../../../src/surfaces/android/adapter.mjs";
import { SURFACE_PORT_METHODS, assertImplementsSurfacePort } from "../../../src/surfaces/port.mjs";
import { createFakeAdb, fakeDeviceLease } from "../../helpers/fake-adb.mjs";

const STEP_TIMEOUT_MS = 400;

function memoryBundle() {
  const written = new Map();

  return Object.freeze({
    dir: null,
    write(relPath, data) {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      written.set(relPath, bytes);
      return Object.freeze({ kind: relPath, path: relPath, bytes: bytes.byteLength });
    },
    written() {
      return written;
    }
  });
}

function context(bundle) {
  return Object.freeze({
    runId: "android-adapter",
    scenarioId: "android.adapter",
    surface: "android",
    headed: false,
    bundle,
    timeouts: Object.freeze({ stepMs: STEP_TIMEOUT_MS }),
    now: () => new Date("2026-08-17T00:00:00.000Z")
  });
}

async function withSession(fn, adbOptions = {}, surfaceOptions = {}) {
  const adb = createFakeAdb(adbOptions);
  const bundle = memoryBundle();
  const adapter = createAndroidSurface({
    lease: fakeDeviceLease(),
    packageName: "attest.selfverify",
    activity: ".MainActivity",
    deps: { runAdb: adb.runAdb, startAdb: adb.startAdb },
    ...surfaceOptions
  });
  const ctx = context(bundle);
  const session = await adapter.open(ctx);

  try {
    return await fn({ adapter, session, adb, bundle, ctx });
  } finally {
    await adapter.close(session);
  }
}

function argvLines(adb) {
  return adb.transcript().map((entry) => entry.args.join(" "));
}

describe("android surface adapter", () => {
  test("implements every surface port method", () => {
    const adapter = createAndroidSurface({ lease: fakeDeviceLease() });

    assert.doesNotThrow(() => assertImplementsSurfacePort(adapter));
    for (const method of SURFACE_PORT_METHODS) {
      assert.equal(typeof adapter[method], "function", method);
    }
  });

  test("preflight acquires the device so a dead emulator fails before any scenario", async () => {
    let acquired = 0;
    const adapter = createAndroidSurface({
      lease: Object.freeze({
        async acquire() {
          acquired += 1;
          return Object.freeze({ serial: "emulator-5554", adbPath: "adb" });
        },
        async shutdown() {
          return Object.freeze({ ok: true });
        }
      })
    });

    const result = await adapter.preflight(context(memoryBundle()));
    assert.deepEqual(result, { ok: true });
    assert.equal(acquired, 1);
  });

  test("preflight without a lease is an infrastructure error", async () => {
    const adapter = createAndroidSurface({});

    await assert.rejects(() => adapter.preflight(context(memoryBundle())), {
      code: "E_ANDROID_NO_DEVICE"
    });
  });

  test("navigate starts the activity by explicit component and converges on ready", async () => {
    await withSession(async ({ adapter, session, adb }) => {
      const result = await adapter.execute(session, {
        i: 0,
        kind: "navigate",
        target: { deeplink: "attest-selfverify://customers" },
        ready: { strategy: "testId", value: "customer_list" }
      });

      assert.equal(result.ok, true);
      assert.equal(result.detail.deeplink, "attest-selfverify://customers");
      assert.equal(Object.isFrozen(result.detail), true);

      const start = argvLines(adb).find((line) => line.includes("am start"));
      // The component is explicit even for a deeplink, so the intent resolver
      // can never put a chooser dialog in front of the app under test.
      assert.match(start, /-n attest\.selfverify\/\.MainActivity/u);
      assert.match(start, /-d 'attest-selfverify:\/\/customers'/u);
    });
  });

  test("a screen bound to a URL path is refused with the binding as the fix", async () => {
    await withSession(async ({ adapter, session }) => {
      await assert.rejects(
        async () => adapter.execute(session, { i: 0, kind: "navigate", target: { path: "/customers" } }),
        (error) => {
          assert(error instanceof UnsupportedOpError);
          assert.equal(error.code, "E_ANDROID_SCREEN_PATH");
          assert.match(error.details.remediation, /deeplink/);
          return true;
        }
      );
    });
  });

  test("click taps the integer centre of the resolved node", async () => {
    await withSession(async ({ adapter, session, adb }) => {
      const result = await adapter.execute(session, {
        i: 1,
        kind: "click",
        locator: { strategy: "testId", value: "create_order_action" }
      });

      // bounds [40,300][540,420] -> centre 290,360
      assert.equal(result.detail.x, 290);
      assert.equal(result.detail.y, 360);
      assert(argvLines(adb).includes("-s emulator-5554 shell input tap 290 360"));
    });
  });

  test("fill quotes the value for the device shell so a space is not a second argument", async () => {
    await withSession(async ({ adapter, session, adb }) => {
      await adapter.execute(session, {
        i: 2,
        kind: "fill",
        locator: { strategy: "testId", value: "note_field" },
        value: "hello world"
      });

      // adb shell joins argv with spaces before the DEVICE shell parses it, so
      // an unquoted "hello world" would type only "hello".
      assert(argvLines(adb).includes("-s emulator-5554 shell input text 'hello world'"));
    });
  });

  test("clear deletes exactly the characters the field holds, in one round trip", async () => {
    await withSession(async ({ adapter, session, adb }) => {
      const result = await adapter.execute(session, {
        i: 3,
        kind: "clear",
        locator: { strategy: "testId", value: "note_field" }
      });

      assert.equal(result.detail.deleted, 5);
      const keyevents = argvLines(adb).filter((line) => line.includes("input keyevent"));
      assert.equal(keyevents.length, 1);
      assert.equal((keyevents[0].match(/KEYCODE_DEL/gu) ?? []).length, 5);
    });
  });

  test("press_key maps the shared vocabulary and refuses an unmapped key by name", async () => {
    await withSession(async ({ adapter, session, adb }) => {
      await adapter.execute(session, { i: 4, kind: "press_key", key: "Enter" });
      assert(argvLines(adb).includes("-s emulator-5554 shell input keyevent KEYCODE_ENTER"));

      await adapter.execute(session, { i: 5, kind: "press_key", key: "KEYCODE_CAMERA" });
      assert(argvLines(adb).includes("-s emulator-5554 shell input keyevent KEYCODE_CAMERA"));

      await assert.rejects(async () => adapter.execute(session, { i: 6, kind: "press_key", key: "F13" }), {
        code: "E_ANDROID_KEY_UNSUPPORTED"
      });
    });
  });

  test("swipe down moves the finger up, matching the web wheel semantics", async () => {
    await withSession(async ({ adapter, session, adb }) => {
      await adapter.execute(session, { i: 7, kind: "swipe", direction: "down" });

      const swipe = argvLines(adb).find((line) => line.includes("input swipe"));
      const [x1, y1, x2, y2] = swipe.split(" ").slice(5, 9).map(Number);
      assert.equal(x1, x2, `expected a vertical swipe, got ${swipe}`);
      assert(y1 > y2, `expected the finger to travel up, got ${swipe}`);
    });
  });

  test("app lifecycle is real: HOME backgrounds and am start foregrounds", async () => {
    await withSession(async ({ adapter, session, adb }) => {
      await adapter.execute(session, { i: 8, kind: "app_background" });
      await adapter.execute(session, { i: 9, kind: "app_foreground" });

      const lines = argvLines(adb);
      assert(lines.includes("-s emulator-5554 shell input keyevent KEYCODE_HOME"));
      assert(lines.some((line) => line.includes("am start -W -n attest.selfverify/.MainActivity")));
    });
  });

  test("an undeclared capability raises E_UNSUPPORTED_OP naming what is missing", async () => {
    await withSession(async ({ adapter, session }) => {
      for (const [op, capability] of [
        [{ i: 10, kind: "upload_file", locator: { strategy: "testId", value: "note_field" }, path: "a.txt" }, "file_upload"],
        [{ i: 11, kind: "set_network", mode: "offline" }, "network_control"],
        [{ i: 12, kind: "set_permission", name: "geolocation", value: true }, "permission_control"],
        [{ i: 13, kind: "set_clipboard", value: "x" }, "clipboard_control"]
      ]) {
        await assert.rejects(
          async () => adapter.execute(session, op),
          (error) => {
            assert(error instanceof UnsupportedOpError);
            assert.equal(error.code, "E_UNSUPPORTED_OP");
            assert(error.details.missing.includes(capability));
            return true;
          }
        );
      }
    });
  });

  test("assertions converge and report expected, observed and convergence time", async () => {
    await withSession(async ({ adapter, session }) => {
      const visible = await adapter.execute(session, {
        i: 14,
        kind: "expect_visible",
        locator: { strategy: "testId", value: "customer_list" }
      });
      assert.equal(visible.ok, true);
      assert.equal(typeof visible.detail.convergeMs, "number");

      const text = await adapter.execute(session, {
        i: 15,
        kind: "expect_text",
        locator: { strategy: "testId", value: "customer_list" },
        equals: "2 customers"
      });
      assert.equal(text.ok, true);

      const count = await adapter.execute(session, {
        i: 16,
        kind: "expect_count",
        locator: { strategy: "testId", value: "customer_row" },
        equals: 2
      });
      assert.equal(count.ok, true);

      const hidden = await adapter.execute(session, {
        i: 17,
        kind: "expect_hidden",
        locator: { strategy: "testId", value: "nothing_here" }
      });
      assert.equal(hidden.ok, true);

      const disabled = await adapter.execute(session, {
        i: 18,
        kind: "expect_state",
        locator: { strategy: "testId", value: "delete_customer_action" },
        state: "disabled"
      });
      assert.equal(disabled.ok, true);
    });
  });

  test("a failed assertion names the locator, the expectation and what was observed", async () => {
    await withSession(async ({ adapter, session }) => {
      await assert.rejects(
        () =>
          adapter.execute(session, {
            i: 19,
            kind: "expect_text",
            locator: { strategy: "testId", value: "customer_list" },
            equals: "9 customers"
          }),
        (error) => {
          assert(error instanceof AttestError);
          assert.equal(error.code, "E_ANDROID_ASSERTION_FAILED");
          assert.equal(error.details.locator, "id=customer_list");
          assert.equal(error.details.expected, "9 customers");
          assert.equal(error.details.observed, "2 customers");
          assert(error.details.attempts >= 1);
          return true;
        }
      );
    });
  });

  test("the raw escape hatch takes an argv array and nothing else", async () => {
    await withSession(async ({ adapter, session, adb }) => {
      const result = await adapter.execute(session, {
        i: 20,
        kind: "raw",
        surface: "android",
        reason: "adapter test",
        block: { shell: ["input", "keyevent", "KEYCODE_BACK"] }
      });

      assert.equal(result.ok, true);
      assert(argvLines(adb).includes("-s emulator-5554 shell input keyevent KEYCODE_BACK"));

      await assert.rejects(
        async () => adapter.execute(session, { i: 21, kind: "raw", block: { script: "() => true" } }),
        (error) => {
          assert.equal(error.code, "E_RAW_BLOCK_UNSUPPORTED");
          assert.deepEqual(error.details.accepted, ["shell", "adb"]);
          return true;
        }
      );
    });
  });

  test("an aborted signal surfaces the abort reason rather than a scenario failure", async () => {
    await withSession(async ({ adapter, session }) => {
      const controller = new AbortController();
      const reason = new Error("android abort");
      controller.abort(reason);

      await assert.rejects(
        async () =>
          adapter.execute(
            session,
            { i: 22, kind: "click", locator: { strategy: "testId", value: "create_order_action" } },
            { signal: controller.signal }
          ),
        (error) => error === reason || error?.name === "AbortError"
      );
    });
  });

  test("a closed session refuses further ops", async () => {
    const adb = createFakeAdb();
    const adapter = createAndroidSurface({
      lease: fakeDeviceLease(),
      packageName: "attest.selfverify",
      deps: { runAdb: adb.runAdb, startAdb: adb.startAdb }
    });
    const session = await adapter.open(context(memoryBundle()));
    await adapter.close(session);

    await assert.rejects(
      async () => adapter.execute(session, { i: 23, kind: "back" }),
      { code: "E_SESSION_CLOSED" }
    );
  });

  test("a database window op that reached the surface is a harness error, not a no op", async () => {
    await withSession(async ({ adapter, session }) => {
      await assert.rejects(
        async () => adapter.execute(session, { i: 24, kind: "db_window_open", fence: "attest_watermark" }),
        { code: "E_DB_OP_AT_SURFACE" }
      );
    });
  });

  test("every adb invocation carries the serial as a flag and never needs a host shell", async () => {
    await withSession(async ({ adapter, session, adb }) => {
      await adapter.execute(session, {
        i: 25,
        kind: "click",
        locator: { strategy: "testId", value: "create_order_action" }
      });

      for (const entry of adb.transcript()) {
        assert.equal(Array.isArray(entry.args), true);
        for (const arg of entry.args) {
          assert.equal(typeof arg, "string");
        }
        assert.equal(entry.args[0], "-s", entry.args.join(" "));
        assert.equal(entry.args[1], "emulator-5554");
      }
    });
  });
});
