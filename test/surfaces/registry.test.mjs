import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { resolveConfig } from "../../src/config/resolve.mjs";
import { createBundle } from "../../src/evidence/bundle.mjs";
import { InfraError, UsageError } from "../../src/errors.mjs";
import { createExecutionPlan } from "../../src/lower/plan.mjs";
import { runSuite } from "../../src/runtime/suite.mjs";
import { createSurfaceRegistry, SURFACE_ADAPTER_MODES } from "../../src/surfaces/registry.mjs";

const APP = Object.freeze({ kind: "web_url", url: "https://example.test", surface: "web" });
const APK = Object.freeze({ kind: "android_apk", path: "build/app.apk", surface: "android" });
const START = new Date("2026-08-15T04:46:12.000Z");

function config(overrides = {}) {
  return resolveConfig({ file: { app: APP.url, ...overrides } });
}

function tinyPlan(surface) {
  return createExecutionPlan({
    scenarioId: `${surface}.adapter`,
    surface,
    app: surface === "web" ? APP.url : "build/app.apk",
    bindingsHash: "bindings",
    requirements: ["WEB-01"],
    capabilities: {
      demanded: ["raw_escape"],
      satisfiedBy: { surface: ["raw_escape"], db: [] }
    },
    rawOpCount: 1,
    ops: [{ i: 0, kind: "raw", surface, reason: "registry adapter classification test" }]
  });
}

async function withTemp(prefix, fn) {
  const root = await mkdtemp(path.join(process.cwd(), `test/surfaces/${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("registry exports frozen adapter modes", () => {
  assert.deepEqual(SURFACE_ADAPTER_MODES, ["real", "fake"]);
  assert.equal(Object.isFrozen(SURFACE_ADAPTER_MODES), true);
});

test("real web registry returns the web adapter descriptor and fresh web adapters", () => {
  const registry = createSurfaceRegistry({
    mode: "real",
    surfaces: ["web"],
    appArtifact: APP,
    config: config()
  });

  const descriptor = registry.descriptorFor("web");
  const first = registry.adapterFor({ surface: "web" });
  const second = registry.adapterFor({ surface: "web" });
  const adapterDescriptor = first.describeCapabilities();

  assert.equal(registry.mode, "real");
  assert.notEqual(first, second);
  assert.equal(descriptor.surface, "web");
  assert.deepEqual(descriptor.supports, adapterDescriptor.supports);
  assert.equal(descriptor.has("file_upload"), true);
  assert.equal(adapterDescriptor.has("file_upload"), true);
  assert.equal(descriptor.has("app_lifecycle"), false);
  assert.equal(adapterDescriptor.has("app_lifecycle"), false);
});

test("real android registry returns the android adapter descriptor", () => {
  const registry = createSurfaceRegistry({
    mode: "real",
    surfaces: ["android"],
    appArtifact: APK,
    config: config({ app: "build/app.apk", android: { package: "attest.selfverify", serial: "emulator-5554" } })
  });

  const descriptor = registry.descriptorFor("android");
  const adapter = registry.adapterFor({ surface: "android" });

  assert.deepEqual(descriptor.supports, ["app_lifecycle", "raw_escape"]);
  assert.deepEqual(adapter.describeCapabilities().supports, descriptor.supports);
  // The adb backend cannot do these honestly, so they are absent rather than
  // present and no-opped.
  assert.equal(descriptor.has("file_upload"), false);
  assert.equal(descriptor.has("network_control"), false);
  assert.equal(typeof registry.shutdown, "function");
});

test("android without a configured package is refused rather than inferred", () => {
  assert.throws(
    () =>
      createSurfaceRegistry({
        mode: "real",
        surfaces: ["android"],
        appArtifact: APK,
        config: config({ app: "build/app.apk" })
      }),
    (error) => {
      assert(error instanceof UsageError);
      assert.equal(error.code, "E_ANDROID_PACKAGE_REQUIRED");
      assert.match(error.details.remediation, /android\.package/);
      return true;
    }
  );
});

test("real ios is not implemented and points at the phase that lands it", () => {
  const registry = createSurfaceRegistry({
    mode: "real",
    surfaces: ["ios"],
    appArtifact: APK,
    config: config()
  });

  assert.deepEqual(registry.descriptorFor("ios").supports, []);

  assert.throws(
    () => registry.adapterFor({ surface: "ios" }),
    (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_ADAPTER_NOT_IMPLEMENTED");
      assert.equal(error.details.surface, "ios");
      assert.match(error.details.remediation, /macOS runner/);
      return true;
    }
  );
});

test("unimplemented adapter becomes a scenario infra_error through runSuite", async () => {
  await withTemp("registry-suite", async (root) => {
    const registry = createSurfaceRegistry({
      mode: "real",
      surfaces: ["ios"],
      appArtifact: APK,
      config: config()
    });

    const { record } = await runSuite({
      plans: [tinyPlan("ios")],
      adapterFor: registry.adapterFor,
      bundle: await createBundle({ root, runId: "20260815T044612Z-88888888" }),
      config: { timeouts: config().timeouts },
      now: () => START
    });

    assert.equal(record.scenarios.length, 1);
    assert.equal(record.scenarios[0].result, "infra_error");
    assert.equal(record.scenarios[0].error.code, "E_ADAPTER_NOT_IMPLEMENTED");
    assert.equal(record.counts.infra_error, 1);
  });
});

test("fake mode returns fake adapters and descriptors for every surface", () => {
  const registry = createSurfaceRegistry({
    mode: "fake",
    surfaces: ["web", "android", "ios"],
    appArtifact: APP,
    config: config(),
    env: {
      ATTEST_FAKE_SCRIPT: JSON.stringify({ supports: ["raw_escape", "file_upload"] })
    }
  });

  for (const surface of ["web", "android", "ios"]) {
    const descriptor = registry.descriptorFor(surface);
    const adapter = registry.adapterFor({ surface });

    assert.equal(descriptor.surface, surface);
    assert.equal(adapter.describeCapabilities().surface, surface);
    assert.deepEqual(descriptor.supports, ["raw_escape", "file_upload"]);
    assert.deepEqual(adapter.describeCapabilities().supports, descriptor.supports);
  }
});

test("mode resolution honors explicit option, env, fake script, then real default", () => {
  assert.equal(
    createSurfaceRegistry({ mode: "fake", env: { ATTEST_SURFACE_ADAPTER: "real" }, config: config() }).mode,
    "fake"
  );
  assert.equal(
    createSurfaceRegistry({
      env: { ATTEST_SURFACE_ADAPTER: "fake" },
      appArtifact: APP,
      config: config()
    }).mode,
    "fake"
  );
  assert.equal(
    createSurfaceRegistry({
      env: { ATTEST_FAKE_SCRIPT: JSON.stringify({}) },
      appArtifact: APP,
      config: config()
    }).mode,
    "fake"
  );
  assert.equal(createSurfaceRegistry({ appArtifact: APP, config: config() }).mode, "real");
});

test("unknown mode and real web without http target are usage errors", () => {
  assert.throws(
    () =>
      createSurfaceRegistry({
        mode: "simulated",
        appArtifact: APP,
        config: config()
      }),
    (error) => {
      assert(error instanceof UsageError);
      assert.equal(error.code, "E_SURFACE_ADAPTER_MODE");
      assert.deepEqual(error.details.accepted, ["real", "fake"]);
      return true;
    }
  );

  assert.throws(
    () =>
      createSurfaceRegistry({
        mode: "real",
        surfaces: ["web"],
        appArtifact: Object.freeze({ kind: "android_apk", path: "build/app.apk", surface: "android" }),
        config: config()
      }),
    (error) => {
      assert(error instanceof UsageError);
      assert.equal(error.code, "E_WEB_APP_REQUIRED");
      return true;
    }
  );
});
