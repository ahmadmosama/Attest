import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import yaml from "yaml";

import { UnsupportedOpError } from "../../src/errors.mjs";
import { createIosSurface } from "../../src/surfaces/ios/adapter.mjs";
import { IOS_COMMANDS, buildSimctlCommand } from "../../src/surfaces/ios/commands.mjs";
import { SURFACE_PORT_METHODS, assertImplementsSurfacePort } from "../../src/surfaces/port.mjs";
import { createFakeSimctl, fakeSimulatorLease } from "../helpers/fake-simctl.mjs";

const IOS_WORKFLOW = ".github/workflows/ios.yml";
const CHECK_WORKFLOW = ".github/workflows/check.yml";

function memoryBundle() {
  const written = new Map();

  return Object.freeze({
    dir: null,
    write(relPath, data) {
      written.set(relPath, data);
      return Object.freeze({ kind: relPath, path: relPath, bytes: Buffer.byteLength(String(data)) });
    },
    written: () => written
  });
}

function context(bundle) {
  return Object.freeze({
    runId: "ios-acceptance",
    scenarioId: "ios.acceptance",
    surface: "ios",
    bundle,
    timeouts: Object.freeze({ stepMs: 500 }),
    now: () => new Date("2026-08-17T00:00:00.000Z")
  });
}

async function withSession(fn) {
  const sim = createFakeSimctl();
  const bundle = memoryBundle();
  const adapter = createIosSurface({
    lease: fakeSimulatorLease(),
    bundleId: "test.attest.fixture",
    deps: { runSimctl: sim.runSimctl, describeElements: sim.describeElements, tap: sim.tap, type: sim.type }
  });
  const session = await adapter.open(context(bundle));

  try {
    return await fn({ adapter, session, sim, bundle });
  } finally {
    await adapter.close(session);
  }
}

describe("Phase 7 iOS acceptance", () => {
  test("IOS-02: the adapter implements the surface port and drives a session on this host", async () => {
    // The whole point of IOS-02. This host is Windows, the simulator does not
    // exist here, and the adapter is still fully exercised, so it cannot rot
    // between the CI runs that are the only place it can execute.
    await withSession(async ({ adapter, session, sim }) => {
      assert.doesNotThrow(() => assertImplementsSurfacePort(adapter));
      for (const method of SURFACE_PORT_METHODS) {
        assert.equal(typeof adapter[method], "function", method);
      }

      const opened = await adapter.execute(session, {
        i: 0,
        kind: "navigate",
        target: { deeplink: "attest://checkout" },
        ready: { strategy: "accessibilityId", value: "checkout_root" }
      });
      assert.equal(opened.ok, true);

      const asserted = await adapter.execute(session, {
        i: 1,
        kind: "expect_text",
        locator: { strategy: "accessibilityId", value: "cart_count" },
        equals: "1"
      });
      assert.equal(asserted.ok, true);

      const typedInto = await adapter.execute(session, {
        i: 2,
        kind: "fill",
        locator: { strategy: "accessibilityId", value: "note_field" },
        value: "hello there"
      });
      assert.equal(typedInto.ok, true);
      assert.deepEqual([...sim.typed()], ["hello there"]);

      // The tap point is the integer centre of the element frame, computed by
      // the adapter rather than by the simulator.
      assert.deepEqual([...sim.taps()], [{ x: 195, y: 280, longPress: false }]);
    });
  });

  test("IOS-02: every simctl invocation is an argv array, never a shell string", async () => {
    await withSession(async ({ adapter, session, sim }) => {
      await adapter.execute(session, {
        i: 0,
        kind: "navigate",
        target: { deeplink: "attest://checkout" },
        ready: { strategy: "accessibilityId", value: "checkout_root" }
      });
      await adapter.execute(session, {
        i: 1,
        kind: "click",
        locator: { strategy: "accessibilityId", value: "place_order" }
      });
      await adapter.collectEvidence(session, "failure");

      const transcript = sim.transcript();
      assert(transcript.length > 0);
      for (const entry of transcript) {
        assert.equal(Array.isArray(entry.args), true, entry.args.join(" "));
        for (const arg of entry.args) {
          assert.equal(typeof arg, "string");
        }
        // Every command targets the booted simulator explicitly, the same rule
        // ANDROID_SERIAL enforces on the other mobile surface.
        assert(entry.args.includes("SIM-0001") || entry.args.includes("list"), entry.args.join(" "));
      }
    });
  });

  test("IOS-02: an undeclared capability is refused by name", async () => {
    await withSession(async ({ adapter, session }) => {
      for (const [op, capability] of [
        [{ i: 10, kind: "upload_file", locator: { strategy: "accessibilityId", value: "x" }, path: "a" }, "file_upload"],
        [{ i: 11, kind: "set_network", mode: "offline" }, "network_control"],
        [{ i: 12, kind: "set_permission", name: "geolocation", value: true }, "permission_control"]
      ]) {
        await assert.rejects(async () => adapter.execute(session, op), (error) => {
          assert(error instanceof UnsupportedOpError);
          assert.equal(error.code, "E_UNSUPPORTED_OP");
          assert(error.details.missing.includes(capability));
          return true;
        });
      }
    });
  });

  test("the .app versus .ipa contract still holds, with the full explanation", () => {
    // A device .ipa cannot be installed on a simulator, and the error says so
    // rather than failing somewhere confusing.
    assert.throws(
      () =>
        buildSimctlCommand(IOS_COMMANDS.installApp, {
          xcodeVersion: "26.1",
          runtimeName: "iOS",
          runtimeVersion: "26.1",
          device: "SIM-0001",
          appPath: "build/Runner.ipa"
        }),
      (error) => {
        assert.equal(error.code, "E_IOS_DEVICE_ARTIFACT");
        assert.match(error.message, /cannot install a device \.ipa/u);
        assert.match(error.message, /generic\/platform=iOS Simulator/u);
        return true;
      }
    );
  });

  test("IOS-01: the iOS workflow selects a toolchain by floor, asserts it, and blocks", async () => {
    const text = await readFile(IOS_WORKFLOW, "utf8");
    const workflow = yaml.parse(text);

    assert.equal(workflow.jobs.ios["runs-on"].startsWith("macos"), true);

    // Never continue-on-error. A surface that silently skips is how a gate
    // becomes a lie, and this is the one surface nobody can check locally.
    assert.doesNotMatch(text, /^\s*continue-on-error:/mu);

    const steps = workflow.jobs.ios.steps.map((step) => `${step.name ?? ""} ${step.run ?? ""}`).join("\n");
    assert.match(steps, /xcode-select -switch/u);
    assert.match(steps, /simctl list runtimes/u);

    // A FLOOR, not an exact pin. The first real run on 2026-08-18 proved why:
    // Xcode 26.1.1 was installed and the iOS 26.1 runtime was simply not on the
    // image (it ships 26.2, 26.4 and 26.5). An exact pin breaks on every image
    // rotation, and that treadmill ends with somebody deleting the pin.
    assert.equal(workflow.env.IOS_RUNTIME_MIN !== undefined, true, "a runtime floor must be declared");
    assert.equal(workflow.env.XCODE_MIN !== undefined, true, "an Xcode floor must be declared");
    assert.equal(workflow.env.IOS_RUNTIME_VERSION, undefined, "the exact runtime pin must be gone");

    // What prevents silent drift is not the pin, it is that the RESOLVED
    // toolchain is reported. A green job has to say what it ran on.
    assert.match(steps, /GITHUB_STEP_SUMMARY/u);
    assert.match(steps, /select-ios-runtime\.mjs/u);

    // The toolchain is settled before the suite, not during it.
    const names = workflow.jobs.ios.steps.map((step) => step.name ?? "");
    assert(
      names.indexOf("Select Xcode and the simulator runtime") < names.indexOf("Run the iOS scenarios"),
      names.join(" | ")
    );
    // So is idb: "the companion is unreachable" must not surface as a locator
    // miss thirty steps in that reads like the app is broken.
    assert(
      names.indexOf("Assert idb can actually see the booted simulator") < names.indexOf("Run the iOS scenarios"),
      names.join(" | ")
    );

    // And the simulator is shut down even when the run failed.
    const shutdown = workflow.jobs.ios.steps.find((step) => step.name === "Shut the simulator down");
    assert.equal(shutdown.if, "always()");
  });

  test("the boot step uses the resolved runtime identifier, never one rebuilt from a version", async () => {
    const workflow = yaml.parse(await readFile(IOS_WORKFLOW, "utf8"));
    const boot = workflow.jobs.ios.steps.find((step) => step.name === "Boot the simulator");

    // "iOS 26.4" reports version 26.4.1 and identifier iOS-26-4. Rebuilding the
    // id from a version string yields iOS-26-4-1 and simctl create fails with an
    // unhelpful "invalid runtime".
    assert.match(boot.run, /\$\{RUNTIME_ID\}/u);
    assert.doesNotMatch(boot.run, /SimRuntime\.iOS-\$\{/u);
  });

  test("the check workflow runs the gate on both host families with a real Postgres", async () => {
    const workflow = yaml.parse(await readFile(CHECK_WORKFLOW, "utf8"));

    // Two jobs, not one matrix. GitHub runs `services:` containers on Linux
    // ONLY, so the old matrix leg on Windows never had a database: it ran the
    // suite with its DB half silently skipping, then failed on `docker exec`.
    // The hosts genuinely differ in how they get a Postgres and a matrix hid it.
    const linux = workflow.jobs.linux;
    const windows = workflow.jobs.windows;

    assert.equal(linux["runs-on"], "ubuntu-latest");
    assert.equal(windows["runs-on"], "windows-latest");
    // Which is DROID-03's second half: the Android contract tests pass on Linux
    // as well as on Windows.

    // Only the Linux job may use a service container.
    assert.equal(linux.services.postgres.image, "postgres:17");
    assert.equal(windows.services, undefined, "service containers do not run on Windows runners");

    for (const [name, job] of Object.entries({ linux, windows })) {
      const steps = job.steps.map((step) => `${step.name ?? ""} ${step.run ?? ""}`).join("\n");

      // Both legs get a REAL server. A green suite whose database half quietly
      // skipped is exactly what this project refuses, on either host.
      assert.match(steps, /wal_level/u, name);
      assert.match(steps, /logical/u, name);
      assert.match(steps, /pg_replication_slots/u, name);
      assert.match(job.env.ATTEST_PG_URL, /^postgres:\/\//u, name);

      // And the leak check runs even when the suite failed, because a leaked
      // slot outlives the run.
      const leak = job.steps.find((step) => (step.name ?? "").includes("replication slot"));
      assert.equal(leak.if, "always()", name);
    }
  });

  test("the Windows job discovers its PostgreSQL service rather than hardcoding a version", async () => {
    const workflow = yaml.parse(await readFile(CHECK_WORKFLOW, "utf8"));
    const steps = workflow.jobs.windows.steps.map((step) => step.run ?? "").join("\n");

    // The service name carries its major version and that rotates with the
    // runner image. A hardcoded postgresql-x64-17 becomes a broken job the week
    // the image moves to 18, which is the same class of bug as the exact iOS
    // runtime pin.
    assert.match(steps, /Get-Service -Name "postgresql\*"/u);
    assert.doesNotMatch(steps, /postgresql-x64-\d+/u);
  });
});
