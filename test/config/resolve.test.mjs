import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULTS } from "../../src/config/schema.mjs";
import { resolveConfig } from "../../src/config/resolve.mjs";

test("resolveConfig layers defaults, file, env, then flags", () => {
  const config = resolveConfig({
    file: {
      artifactRoot: "from-file",
      scenariosGlob: ["file/**/*.attest.yaml"],
      timeouts: { stepMs: 11111 },
      failOnSkip: false
    },
    env: {
      ATTEST_ARTIFACT_ROOT: "from-env",
      ATTEST_TIMEOUT_SCENARIO_MS: "22222",
      ATTEST_SURFACES: "web,android"
    },
    flags: {
      artifactRoot: "from-flags",
      surfaces: ["ios"],
      app: "https://example.test"
    }
  });

  assert.equal(config.artifactRoot, "from-flags");
  assert.deepEqual(config.scenariosGlob, ["file/**/*.attest.yaml"]);
  assert.equal(config.timeouts.stepMs, 11111);
  assert.equal(config.timeouts.scenarioMs, 22222);
  assert.deepEqual(config.surfaces, ["ios"]);
  assert.equal(config.failOnSkip, false);
  assert.equal(config.app, "https://example.test");
});

test("resolveConfig takes every default from DEFAULTS and deeply freezes the result", () => {
  const config = resolveConfig();

  assert.equal(config.artifactRoot, DEFAULTS.artifactRoot);
  assert.deepEqual(config.scenariosGlob, DEFAULTS.scenariosGlob);
  assert.equal(config.bindingsDir, DEFAULTS.bindingsDir);
  assert.equal(config.app, DEFAULTS.app);
  assert.deepEqual(config.surfaces, DEFAULTS.surfaces);
  assert.equal(config.timeouts.stepMs, DEFAULTS.timeouts.stepMs);
  assert.equal(config.timeouts.scenarioMs, DEFAULTS.timeouts.scenarioMs);
  assert.equal(config.failOnSkip, DEFAULTS.failOnSkip);
  assert.equal(config.concurrency, DEFAULTS.concurrency);
  assert.equal(config.color, DEFAULTS.color);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.timeouts), true);
  assert.equal(Object.isFrozen(config.surfaces), true);
});

test("resolveConfig rejects secret shaped flag values", () => {
  assert.throws(
    () =>
      resolveConfig({
        flags: {
          apiToken: "a".repeat(32)
        }
      }),
    (error) => {
      assert.equal(error.code, "E_SECRET_IN_FLAG");
      return true;
    }
  );

  assert.throws(
    () =>
      resolveConfig({
        flags: {
          database: "postgres://user:pass@example.test/app"
        }
      }),
    (error) => {
      assert.equal(error.code, "E_SECRET_IN_FLAG");
      return true;
    }
  );
});
