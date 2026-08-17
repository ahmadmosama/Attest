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

  test("IOS-01: the iOS workflow pins both versions, asserts the runtime, and blocks", async () => {
    const text = await readFile(IOS_WORKFLOW, "utf8");
    const workflow = yaml.parse(text);

    assert.equal(workflow.jobs.ios["runs-on"].startsWith("macos"), true);

    // Never continue-on-error. A surface that silently skips is how a gate
    // becomes a lie, and this is the one surface nobody can check locally.
    assert.doesNotMatch(text, /^\s*continue-on-error:/mu);

    const steps = workflow.jobs.ios.steps.map((step) => `${step.name ?? ""} ${step.run ?? ""}`).join("\n");
    // Pinned, not trusted from the image: runner image issue 13853 had Xcode
    // shipping ahead of its matching runtime.
    assert.match(steps, /xcode-select -switch/u);
    assert.match(steps, /simctl list runtimes/u);
    // The runtime assertion runs before the suite, not during it.
    const names = workflow.jobs.ios.steps.map((step) => step.name ?? "");
    assert(
      names.indexOf("Assert the simulator runtime exists") < names.indexOf("Run the iOS scenarios"),
      names.join(" | ")
    );
    // And the simulator is shut down even when the run failed.
    const shutdown = workflow.jobs.ios.steps.find((step) => step.name === "Shut the simulator down");
    assert.equal(shutdown.if, "always()");
  });

  test("the check workflow runs the gate on both host families with a real Postgres", async () => {
    const workflow = yaml.parse(await readFile(CHECK_WORKFLOW, "utf8"));
    const job = workflow.jobs.check;

    assert.deepEqual(job.strategy.matrix.os, ["ubuntu-latest", "windows-latest"]);
    // Which is DROID-03's second half: the Android contract tests pass on Linux
    // as well as on Windows.
    assert.equal(job.strategy["fail-fast"], false);
    assert.equal(job.services.postgres.image, "postgres:17");

    const steps = job.steps.map((step) => `${step.name ?? ""} ${step.run ?? ""}`).join("\n");
    // The DB tests must RUN rather than skip: a green suite whose database half
    // quietly skipped is exactly what this project refuses.
    assert.match(steps, /wal_level = logical/u);
    assert.match(steps, /pg_replication_slots/u);
  });
});
