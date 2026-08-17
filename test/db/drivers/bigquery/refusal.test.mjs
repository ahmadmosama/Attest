import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { defineSurfaceCapabilities } from "../../../../src/capabilities/surface-caps.mjs";
import { loadBindings } from "../../../../src/bindings/load.mjs";
import { compileScenarioFile } from "../../../../src/ir/compile.mjs";
import { lower } from "../../../../src/lower/lower.mjs";
import { bigQueryCapabilities } from "../../../../src/db/drivers/bigquery/capabilities.mjs";
import { sqliteCapabilities } from "../../../../src/db/drivers/sqlite/capabilities.mjs";

const FIXTURE_DIR = "test/fixtures/bindings";
const SCENARIO = "test/fixtures/scenarios/checkout_guest_purchase.attest.yaml";

async function lowerAgainst(dbCaps) {
  const compiled = await compileScenarioFile(SCENARIO);

  return lower(compiled.ir, {
    surface: "web",
    bindings: await loadBindings({ dir: FIXTURE_DIR, app: "shopdemo", surface: "web" }),
    surfaceCaps: defineSurfaceCapabilities({
      surface: "web",
      supports: ["file_upload", "network_control", "permission_control", "clipboard_control", "clock_control", "raw_escape"]
    }),
    dbCaps,
    app: "shopdemo"
  });
}

describe("bigquery refuses a delta assertion at compile time", () => {
  test("the descriptor declares no delta assertion, which is the whole mechanism", () => {
    const capabilities = bigQueryCapabilities();

    assert.equal(capabilities.driver, "bigquery");
    assert.equal(capabilities.capture, "none");
    assert.equal(capabilities.deltaAssertion, false);
    assert.equal(capabilities.has("db.delta_assertion"), false);
    // The one thing it can do.
    assert.equal(capabilities.boundedPolling, true);
    assert.equal(capabilities.has("db.bounded_polling"), true);
    assert.equal(capabilities.watermarkFencing, "none");
    assert.equal(capabilities.beforeImages, "none");
  });

  test("a scenario demanding no unexplained changes fails to compile against the real descriptor", async () => {
    // The real driver descriptor, not a stub. A stub could drift from what the
    // driver actually declares, and then this refusal would be theatre.
    const result = await lowerAgainst(bigQueryCapabilities());

    assert.equal(result.kind, "error");
    assert.equal(result.error.code, "E_DELTA_UNSUPPORTED");
    assert.equal(result.error.details.driver, "bigquery");
    assert.equal(result.error.details.flag, "delta_assertion");
    assert.deepEqual(result.error.details.capabilities, ["db.delta_assertion"]);
    // Named before anything launches, with no credentials and no network,
    // because the refusal is a property of the capability system rather than a
    // runtime check somebody has to remember to write.
    assert.equal(Number.isInteger(result.error.details.stepIndex), true);
  });

  test("and the same scenario is accepted by a driver that can answer it", async () => {
    // Teeth check. If the refusal above fired for any reason other than the
    // declared capability, this would fail too.
    const result = await lowerAgainst(sqliteCapabilities());

    assert.equal(result.kind, "plan", JSON.stringify(result.error?.details ?? {}));
  });

  test("every degradation names something a reader would otherwise assume", () => {
    const degraded = bigQueryCapabilities().degraded.join(" ");

    for (const claim of ["no change capture", "unexplained", "streaming buffer"]) {
      assert.match(degraded, new RegExp(claim, "u"));
    }
  });
});
