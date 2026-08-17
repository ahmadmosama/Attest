import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, describe, test } from "node:test";

import { startFixtureApp } from "../../fixtures/self-verify/app/server.mjs";
import { createDbDriver } from "../../src/db/registry.mjs";
import { createDbHooks } from "../../src/db/hooks.mjs";
import { createPgClient } from "../../src/db/drivers/postgres/connect.mjs";
import { tenantPrefixFor } from "../../src/db/tenancy.mjs";
import { InfraError } from "../../src/errors.mjs";
import { createBundle } from "../../src/evidence/bundle.mjs";
import { createAndroidSurface } from "../../src/surfaces/android/adapter.mjs";
import { createDeviceLease } from "../../src/surfaces/android/device.mjs";
import { ADB_COMMANDS, buildAdbCommand } from "../../src/surfaces/android/commands.mjs";
import { runAdb } from "../../src/surfaces/android/exec.mjs";
import {
  FIXTURE_ACTIVITY,
  FIXTURE_APK,
  FIXTURE_DEEPLINK,
  FIXTURE_PACKAGE,
  skipUnlessAndroid
} from "../helpers/android.mjs";
import { createFakeAdb } from "../helpers/fake-adb.mjs";
import { skipUnlessPostgres, withPostgresSlotLock } from "../helpers/postgres.mjs";

const ROOTS = [];
const SURFACE = "android";
const STEP_TIMEOUT_MS = 20000;
const LIVE_TIMEOUT_MS = 300000;

const READY_LOCATOR = Object.freeze({ strategy: "testId", value: "customer_list" });
const CREATE_ORDER_LOCATOR = Object.freeze({ strategy: "testId", value: "create_order_action" });

after(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(path.join(process.cwd(), `test/acceptance/${label}-`));
  ROOTS.push(root);
  return root;
}

function schemaName(runId) {
  return `p5_${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`;
}

function tenantEntities(schema) {
  return Object.freeze(
    ["order_items", "order_audit", "orders", "customers"].map((table) =>
      Object.freeze({ schema, table, tenantColumn: "tenant_key" })
    )
  );
}

function keyColumns(schema) {
  return Object.freeze({
    [`${schema}.customers`]: ["tenant_key", "id"],
    [`${schema}.orders`]: ["tenant_key", "id"],
    [`${schema}.order_items`]: ["tenant_key", "order_id", "line_number"],
    [`${schema}.order_audit`]: ["tenant_key", "id"]
  });
}

// Exactly what tapping "Create order" in the APK must produce in Postgres.
function createExpectations(schema) {
  return Object.freeze([
    Object.freeze({
      entity: `${schema}.orders`,
      op: "insert",
      count: 1,
      where: { id: "order_300", customer_id: "cust_a", status: "created", total_cents: 9900 }
    }),
    Object.freeze({
      entity: `${schema}.order_items`,
      op: "insert",
      count: 1,
      where: { order_id: "order_300", line_number: 1, sku: "new_lamp", quantity: 2, unit_cents: 3000 }
    }),
    Object.freeze({
      entity: `${schema}.order_items`,
      op: "insert",
      count: 1,
      where: { order_id: "order_300", line_number: 2, sku: "new_shade", quantity: 1, unit_cents: 3900 }
    }),
    Object.freeze({
      entity: `${schema}.order_audit`,
      op: "insert",
      count: 1,
      where: { action: "created" }
    })
  ]);
}

async function dropSchema(target, schema) {
  const client = await createPgClient(target);
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end().catch(() => {});
  }
}

function androidContext(bundle, runId) {
  return Object.freeze({
    runId,
    scenarioId: "android.phase05",
    surface: SURFACE,
    headed: false,
    bundle,
    timeouts: Object.freeze({ stepMs: STEP_TIMEOUT_MS }),
    now: () => new Date("2026-08-17T00:00:00.000Z")
  });
}

function apiBaseFor(url) {
  // 10.0.2.2 is the emulator's alias for the host loopback interface, which is
  // exactly where the fixture server binds its ephemeral port.
  return url.replace("127.0.0.1", "10.0.2.2").replace("localhost", "10.0.2.2");
}

async function liveLease(device, { apkPath = null, install = false } = {}) {
  const lease = createDeviceLease({
    serial: device.serial,
    adbPath: device.adbPath,
    apkPath,
    packageName: FIXTURE_PACKAGE,
    install,
    bootTimeoutMs: 120000
  });

  await lease.acquire();
  return lease;
}

describe("Phase 5 Android acceptance", () => {
  test("Criterion 1: an emulator that will not boot is an infrastructure error with a remediation hint", async () => {
    // No emulator involved. A transport that answers adb but never reports the
    // boot properties is exactly the shape of a half started emulator, and the
    // point is that it lands as infrastructure rather than as a red scenario.
    const adb = createFakeAdb({ booted: false });
    const lease = createDeviceLease({
      serial: "emulator-5554",
      adbPath: "adb",
      bootTimeoutMs: 300,
      deps: { runAdb: adb.runAdb }
    });

    await assert.rejects(
      () => lease.acquire(),
      (error) => {
        assert(error instanceof InfraError, "an unbootable emulator must never be a scenario failure");
        assert.equal(error.code, "E_EMULATOR_BOOT_FAILED");
        assert.match(error.details.remediation, /accel-check/u);
        assert.match(error.details.remediation, /list-avds/u);
        return true;
      }
    );

    // And it gated on the boot properties, not on adbd answering. wait-for-device
    // returns long before the package manager can install anything.
    const lines = adb.transcript().map((entry) => entry.args.join(" "));
    assert(lines.some((line) => line.includes("getprop sys.boot_completed")), lines.join("\n"));
  });

  test("Criterion 1 (live): one command starts the AVD, boot gates, and shuts it down", { timeout: LIVE_TIMEOUT_MS }, async (t) => {
    const device = await skipUnlessAndroid(t);
    if (device === null) {
      return;
    }

    const lease = await liveLease(device);
    try {
      const acquired = await lease.acquire();
      assert.equal(acquired.serial, device.serial);

      // Boot gating means usable, not merely answering: the package manager
      // must be up, which is what sys.boot_completed reports.
      const booted = await runAdb(
        buildAdbCommand(
          ADB_COMMANDS.getProp,
          { serial: device.serial, prop: "sys.boot_completed" },
          { adbPath: device.adbPath }
        )
      );
      assert.equal(booted.stdout.trim(), "1");
    } finally {
      // This lease attached rather than booted, so shutdown must NOT kill a
      // device it did not start.
      const stopped = await lease.shutdown();
      assert.equal(stopped.stopped, false);
    }
  });

  test(
    "Criterion 2 (live): the scenario passes on the emulator against the installed APK and Postgres agrees",
    { timeout: LIVE_TIMEOUT_MS },
    async (t) => {
      const device = await skipUnlessAndroid(t, { requireApk: true });
      if (device === null) {
        return;
      }

      const live = await skipUnlessPostgres(t);
      if (live === null) {
        return;
      }

      await withPostgresSlotLock(live, async () => {
        const runId = "20260817T000000Z-05000002";
        const schema = schemaName(runId);
        const tenantKey = tenantPrefixFor({ runId, scenarioId: "android.phase05", surface: SURFACE });
        const app = await startFixtureApp({ target: live.target, schema, env: process.env, tenantKey });
        const root = await tempRoot("phase05-c2");
        const bundle = await createBundle({ root, runId });
        const lease = await liveLease(device, { apkPath: path.resolve(FIXTURE_APK), install: true });

        const driver = createDbDriver({
          target: live.target,
          runId,
          scenarioId: "android.phase05",
          config: {
            entities: tenantEntities(schema),
            keyColumns: keyColumns(schema),
            surface: SURFACE,
            logger: false
          }
        });
        const hooks = createDbHooks({
          driver,
          ruleset: null,
          config: { tenantEntities: tenantEntities(schema), ruleHealthPath: null },
          runId
        });

        const adapter = createAndroidSurface({
          lease,
          packageName: FIXTURE_PACKAGE,
          activity: FIXTURE_ACTIVITY,
          extras: { attest_api_base: apiBaseFor(app.url) }
        });
        const ctx = androidContext(bundle, runId);
        const session = await adapter.open(ctx);

        try {
          // The scenario file is not edited between surfaces. These are the
          // same steps the web run performs, resolved through android.yaml.
          const opened = await adapter.execute(session, {
            i: 0,
            kind: "navigate",
            target: { deeplink: FIXTURE_DEEPLINK },
            ready: READY_LOCATOR
          });
          assert.equal(opened.ok, true);

          const visible = await adapter.execute(session, { i: 1, kind: "expect_visible", locator: READY_LOCATOR });
          assert.equal(visible.ok, true);

          const windowCtx = {
            runId,
            scenarioId: "android.phase05",
            surface: SURFACE,
            entities: tenantEntities(schema)
          };
          // The runtime always hands the DB hooks the step's signal, and the
          // Postgres driver requires one, so the harness supplies the same
          // shape rather than a shortcut the real runner never takes.
          const windowOptions = { signal: new AbortController().signal, ctx: windowCtx };
          await hooks.onWindowOpen(
            { kind: "db_window_open", seq: 0, scenarioId: "android.phase05", surface: SURFACE },
            windowOptions
          );

          const tapped = await adapter.execute(session, { i: 2, kind: "click", locator: CREATE_ORDER_LOCATOR });
          assert.equal(tapped.ok, true);

          // This assertion is load bearing, not decoration. `input tap` returns
          // as soon as the touch is dispatched, so the app's HTTP write is
          // still in flight. The change window is fenced by watermark rows, and
          // the close marker is written before the close converges, so a write
          // that lands after it falls outside the fence and is invisible to the
          // delta. Asserting the app's own outcome first is what a correctly
          // written scenario does, and it is why `sleep` is banned: convergence
          // on a real signal, not a guessed duration.
          const status = await adapter.execute(session, {
            i: 3,
            kind: "expect_text",
            locator: { strategy: "testId", value: "status_text" },
            equals: "order created"
          });
          assert.equal(status.ok, true);

          // The write came from the device, over HTTP, into the same Postgres
          // the web fixture writes to. Nothing about this assertion is mobile
          // specific, which is the whole claim of the milestone.
          const closed = await hooks.onWindowClose(
            {
              kind: "db_window_close",
              seq: 0,
              scenarioId: "android.phase05",
              surface: SURFACE,
              expect: createExpectations(schema),
              requireNoUnexplained: true
            },
            windowOptions
          );

          assert.equal(closed.delta.counts.unexplained, 0, JSON.stringify(closed.delta.unexplained ?? []));
          assert(closed.delta.counts.expected >= 4, JSON.stringify(closed.delta.counts));
        } finally {
          await adapter.close(session).catch(() => {});
          await hooks.teardown({ signal: new AbortController().signal }).catch(() => {});
          await app.close().catch(() => {});
          await dropSchema(live.target, schema).catch(() => {});
          await lease.shutdown().catch(() => {});
        }
      });
    }
  );

  test(
    "Criterion 3 (live): a failed step leaves a screenshot, a recording and the hierarchy of the failing step",
    { timeout: LIVE_TIMEOUT_MS },
    async (t) => {
      const device = await skipUnlessAndroid(t, { requireApk: true });
      if (device === null) {
        return;
      }

      const runId = "20260817T000000Z-05000003";
      const root = await tempRoot("phase05-c3");
      const bundle = await createBundle({ root, runId });
      const lease = await liveLease(device, { apkPath: path.resolve(FIXTURE_APK), install: true });
      const adapter = createAndroidSurface({
        lease,
        packageName: FIXTURE_PACKAGE,
        activity: FIXTURE_ACTIVITY,
        recordSeconds: 20
      });
      const ctx = androidContext(bundle, runId);
      const session = await adapter.open(ctx);

      try {
        await adapter.execute(session, {
          i: 0,
          kind: "navigate",
          target: { deeplink: FIXTURE_DEEPLINK },
          ready: READY_LOCATOR
        });

        // A locator no screen of this app renders. The failure is the point.
        await assert.rejects(
          async () =>
            adapter.execute(session, {
              i: 1,
              kind: "click",
              locator: { strategy: "testId", value: "attest_deliberately_missing" }
            }),
          (error) => {
            assert.equal(error.code, "E_ANDROID_NOT_FOUND");
            assert.equal(error.details.locator, "id=attest_deliberately_missing");
            return true;
          }
        );

        const reference = await adapter.collectEvidence(session, "failure", { bundle });
        assert(reference !== null && reference.bytes > 0, "a failed step must leave a screenshot");
      } finally {
        await adapter.close(session).catch(() => {});
        await lease.shutdown().catch(() => {});
      }

      const artifacts = bundle.manifest().map((artifact) => artifact.path);
      assert(artifacts.some((file) => file.endsWith("failure.png")), artifacts.join("\n"));
      assert(artifacts.some((file) => file.endsWith("failure-hierarchy.xml")), artifacts.join("\n"));
      assert(artifacts.some((file) => file.endsWith("recording.mp4")), artifacts.join("\n"));

      // The dump has to be the real tree of the failing screen, not a stub.
      const hierarchyPath = artifacts.find((file) => file.endsWith("failure-hierarchy.xml"));
      const xml = await readFile(path.join(bundle.dir, hierarchyPath), "utf8");
      assert.match(xml, /customer_list/u);

      const recordingPath = artifacts.find((file) => file.endsWith("recording.mp4"));
      const recording = await readFile(path.join(bundle.dir, recordingPath));
      // An mp4 carries an ftyp box in its first bytes. A recording killed
      // rather than interrupted leaves an unplayable file, which is evidence
      // that looks present and is not.
      assert(recording.includes(Buffer.from("ftyp")), "the recording must be a finalised mp4");
    }
  );

  test("Criterion 4: adb is always an argv array with an explicit serial, on any OS", async () => {
    const adb = createFakeAdb();
    const adapter = createAndroidSurface({
      lease: Object.freeze({
        async acquire() {
          return Object.freeze({ serial: "emulator-5554", adbPath: "/opt/android/platform-tools/adb" });
        },
        async shutdown() {
          return Object.freeze({ ok: true });
        }
      }),
      packageName: FIXTURE_PACKAGE,
      activity: FIXTURE_ACTIVITY,
      deps: { runAdb: adb.runAdb, startAdb: adb.startAdb }
    });

    const session = await adapter.open(androidContext(null, "20260817T000000Z-05000004"));
    await adapter.execute(session, {
      i: 0,
      kind: "navigate",
      target: { deeplink: FIXTURE_DEEPLINK },
      ready: READY_LOCATOR
    });
    await adapter.execute(session, { i: 1, kind: "click", locator: CREATE_ORDER_LOCATOR });
    await adapter.close(session);

    const transcript = adb.transcript();
    assert(transcript.length > 0);

    for (const entry of transcript) {
      assert.equal(Array.isArray(entry.args), true, "adb args must be an array, never a command string");
      for (const arg of entry.args) {
        assert.equal(typeof arg, "string");
      }
      // Explicit serial on every single invocation. Defaulting is how a command
      // lands on a second attached device and the run tests nothing.
      assert.equal(entry.args[0], "-s", entry.args.join(" "));
      assert.equal(entry.args[1], "emulator-5554");
    }

    // Nothing outside the exec seam is allowed to spawn a process, which is
    // what keeps the Git Bash path rewriting trap structurally impossible.
    const sources = ["commands", "adapter", "act", "assert", "evidence", "device", "locate", "session", "hierarchy"];
    for (const name of sources) {
      const text = await readFile(path.join("src", "surfaces", "android", `${name}.mjs`), "utf8");
      assert.doesNotMatch(text, /node:child_process/u, `${name}.mjs must not spawn`);
      assert.doesNotMatch(text, /setTimeout/u, `${name}.mjs must not use a fixed wait`);
    }
  });
});
