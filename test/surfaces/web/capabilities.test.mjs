import assert from "node:assert/strict";
import test from "node:test";

import { assertKnownCapability } from "../../../src/capabilities/registry.mjs";
import {
  WEB_SURFACE_SUPPORTS,
  webSurfaceCapabilities
} from "../../../src/surfaces/web/capabilities.mjs";
import { compileScenarioText } from "../../../src/ir/compile.mjs";
import { defineDbCapabilities } from "../../../src/capabilities/db-caps.mjs";
import { loadBindings } from "../../../src/bindings/load.mjs";
import { lower } from "../../../src/lower/lower.mjs";

const FIXTURE_DIR = "test/fixtures/bindings";

function dbCaps() {
  return defineDbCapabilities({
    driver: "postgres",
    capture: "logical_slot",
    deltaAssertion: true,
    boundedPolling: true,
    beforeImages: "full",
    ordering: true,
    txAttribution: true,
    watermarkFencing: "inline",
    transactionalTeardown: true
  });
}

function compileText(text) {
  const result = compileScenarioText(text, { file: "inline.attest.yaml" });
  assert.equal(result.diagnostics.ok, true);
  return result.ir;
}

test("web surface capabilities declare exactly the Playwright chrome support set", () => {
  const descriptor = webSurfaceCapabilities();

  assert.equal(descriptor.surface, "web");
  assert.equal(Object.isFrozen(WEB_SURFACE_SUPPORTS), true);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.supports), true);
  assert.deepEqual(descriptor.supports, [
    "file_upload",
    "network_control",
    "permission_control",
    "clipboard_control",
    "clock_control",
    "raw_escape"
  ]);
  assert.equal(descriptor.has("file_upload"), true);
  assert.equal(descriptor.has("network_control"), true);
  assert.equal(descriptor.has("permission_control"), true);
  assert.equal(descriptor.has("clipboard_control"), true);
  assert.equal(descriptor.has("clock_control"), true);
  assert.equal(descriptor.has("raw_escape"), true);
  assert.equal(descriptor.has("app_lifecycle"), false);
  assert.equal(descriptor.has("db.delta_assertion"), false);
});

test("every web capability is registered", () => {
  for (const capability of WEB_SURFACE_SUPPORTS) {
    assert.equal(assertKnownCapability(capability), capability);
  }
});

test("app lifecycle demand lowers to skip on web", async () => {
  const ir = compileText(`
id: checkout.lifecycle
requirement: [REQ-WEB-001]
steps:
  - background: true
`);
  const bindings = await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" });
  const result = lower(ir, {
    surface: "web",
    bindings,
    surfaceCaps: webSurfaceCapabilities(),
    dbCaps: dbCaps(),
    app: "shopdemo"
  });

  assert.equal(result.kind, "skip");
  assert.equal(result.skip.reason, "capability_missing");
  assert.deepEqual(result.skip.capabilities, ["app_lifecycle"]);
});
