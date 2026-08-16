import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { checkImportBoundary } from "../../tools/check-import-boundary.mjs";

const CLI = path.join(process.cwd(), "src/cli/main.mjs");
const API_KEY_NAMES = Object.freeze([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "MISTRAL_API_KEY",
  "COHERE_API_KEY"
]);

function scrubbedEnv(extra = {}) {
  const env = Object.fromEntries(
    ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "NODE_V8_COVERAGE"]
      .map((key) => [key, process.env[key]])
      .filter(([, value]) => value !== undefined)
  );
  return { ...env, ATTEST_SURFACE_ADAPTER: "fake", ...extra };
}

function assertNoApiKeys(env) {
  for (const name of API_KEY_NAMES) {
    assert.equal(env[name], undefined);
  }
  assert.equal(Object.keys(env).some((key) => key.endsWith("_API_KEY")), false);
}

test("RUN-02 holds with no LLM API key and a clean import boundary", async () => {
  const env = scrubbedEnv();
  assertNoApiKeys(env);

  const artifacts = await mkdtemp(path.join(process.cwd(), "test/acceptance/no-key-artifacts-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "run",
        "--scenarios",
        "examples/shopdemo/scenarios/*.attest.yaml",
        "--bindings",
        "examples/shopdemo/bindings",
        "--app",
        "https://example.test",
        "--surface",
        "web",
        "--surface",
        "android",
        "--artifacts",
        artifacts
      ],
      { cwd: process.cwd(), encoding: "utf8", env }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);

    const boundary = await checkImportBoundary(path.join(process.cwd(), "src"));
    assert.equal(boundary.ok, true, JSON.stringify(boundary.violations, null, 2));
  } finally {
    await rm(artifacts, { recursive: true, force: true });
  }
});
