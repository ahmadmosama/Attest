import assert from "node:assert/strict";
import test from "node:test";

import { loadBindings } from "../../src/bindings/load.mjs";
import { compileScenarioFile, compileScenarioText } from "../../src/ir/compile.mjs";
import { defineDbCapabilities } from "../../src/capabilities/db-caps.mjs";
import { defineSurfaceCapabilities } from "../../src/capabilities/surface-caps.mjs";
import { lower } from "../../src/lower/lower.mjs";

const FIXTURE_DIR = "test/fixtures/bindings";

function surfaceCaps(supports) {
  return defineSurfaceCapabilities({ surface: "web", supports });
}

function dbCaps(overrides = {}) {
  return defineDbCapabilities({
    driver: "postgres",
    capture: "logical_slot",
    deltaAssertion: true,
    boundedPolling: true,
    beforeImages: "full",
    ordering: true,
    txAttribution: true,
    watermarkFencing: "inline",
    transactionalTeardown: true,
    ...overrides
  });
}

async function webBindings() {
  return loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" });
}

function compileText(text) {
  const result = compileScenarioText(text, { file: "inline.attest.yaml" });
  assert.equal(result.diagnostics.ok, true);
  return result.ir;
}

function uploadIr({ withDelta = false } = {}) {
  const steps = [
    {
      index: 0,
      op: "upload_file",
      value: { target: "field:email", path: "avatar_png" },
      capabilities: ["file_upload"],
      refs: ["field:email"],
      pos: { line: 4, col: 5 }
    },
    ...(!withDelta
      ? []
      : [
          {
            index: 1,
            op: "delta_window",
            value: { open: true },
            capabilities: [],
            refs: [],
            pos: { line: 5, col: 5 }
          },
          {
            index: 2,
            op: "delta_window",
            value: { close: { require_no_unexplained: true } },
            capabilities: ["db.delta_assertion"],
            refs: [],
            pos: { line: 6, col: 5 }
          }
        ])
  ];

  return {
    irVersion: 1,
    id: withDelta ? "checkout.mixed" : "checkout.upload",
    file: "inline.attest.yaml",
    requirements: ["REQ-CHK-001"],
    tags: [],
    capabilities: withDelta ? ["db.delta_assertion", "file_upload"] : ["file_upload"],
    refs: ["field:email"],
    seed: null,
    suppressions: [],
    rawUses: [],
    steps
  };
}

test("missing database capability is a named compile error before execution", async () => {
  const compiled = await compileScenarioFile("test/fixtures/scenarios/checkout_guest_purchase.attest.yaml");
  const result = lower(compiled.ir, {
    surface: "web",
    bindings: await webBindings(),
    surfaceCaps: surfaceCaps(["file_upload"]),
    dbCaps: dbCaps({ driver: "bigquery", deltaAssertion: false }),
    app: "shopdemo"
  });

  assert.equal(result.kind, "error");
  assert.equal(result.error.code, "E_DELTA_UNSUPPORTED");
  assert.equal(result.error.details.driver, "bigquery");
  assert.equal(result.error.details.stepIndex, 12);
  assert.deepEqual(result.error.details.capabilities, ["db.delta_assertion"]);
});

test("missing UI capability is an explicit SkipDecision", async () => {
  const scenario = uploadIr();
  const result = lower(scenario, {
    surface: "web",
    bindings: await webBindings(),
    surfaceCaps: surfaceCaps([]),
    dbCaps: dbCaps(),
    app: "shopdemo"
  });

  assert.equal(result.kind, "skip");
  assert.equal(result.skip.reason, "capability_missing");
  assert.deepEqual(result.skip.capabilities, ["file_upload"]);
});

test("database miss wins when db and UI capabilities are both missing", async () => {
  const scenario = uploadIr({ withDelta: true });
  const result = lower(scenario, {
    surface: "web",
    bindings: await webBindings(),
    surfaceCaps: surfaceCaps([]),
    dbCaps: dbCaps({ driver: "bigquery", deltaAssertion: false }),
    app: "shopdemo"
  });

  assert.equal(result.kind, "error");
  assert.equal(result.error.code, "E_DELTA_UNSUPPORTED");
  assert.deepEqual(result.error.details.capabilities, ["db.delta_assertion"]);
});

test("unbound SemanticRef becomes E_UNBOUND_REF with surface and bindings file", async () => {
  const scenario = compileText(`
id: checkout.unbound
requirement: [REQ-CHK-001]
steps:
  - tap: button:missing
`);
  const result = lower(scenario, {
    surface: "web",
    bindings: await webBindings(),
    surfaceCaps: surfaceCaps([]),
    dbCaps: dbCaps(),
    app: "shopdemo"
  });

  assert.equal(result.kind, "error");
  assert.equal(result.error.code, "E_UNBOUND_REF");
  assert.equal(result.error.details.ref, "button:missing");
  assert.equal(result.error.details.surface, "web");
  assert.match(result.error.details.file, /web\.yaml$/);
});

test("lower module does not import node fs APIs", async () => {
  const text = await import("node:fs/promises").then((fs) => fs.readFile("src/lower/lower.mjs", "utf8"));

  assert.doesNotMatch(text, /node:fs/);
});
