import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { after, describe, test } from "node:test";
import { convert } from "xmlbuilder2";

const CLI = path.join(process.cwd(), "src/cli/main.mjs");
const ROOTS = [];
const EXAMPLE_SCENARIOS = "examples/shopdemo/scenarios/*.attest.yaml";
const EXAMPLE_BINDINGS = "examples/shopdemo/bindings";

function childEnv(extra = {}) {
  const base = Object.fromEntries(
    ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]
      .map((key) => [key, process.env[key]])
      .filter(([, value]) => value !== undefined)
  );
  return { ...base, ...extra };
}

async function tempRoot(label) {
  const root = await mkdtemp(path.join(process.cwd(), `test/acceptance/${label}-`));
  ROOTS.push(root);
  return root;
}

function runCli(args, { env = {}, timeout = 10000 } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: childEnv(env),
    timeout
  });
}

async function readRecord(artifactRoot) {
  const entries = await readdir(artifactRoot);
  assert.equal(entries.length, 1);
  return JSON.parse(await readFile(path.join(artifactRoot, entries[0], "run.json"), "utf8"));
}

async function runExample(args, options = {}) {
  const root = await tempRoot("run");
  const artifacts = path.join(root, "artifacts");
  const result = runCli([
    "run",
    "--scenarios",
    EXAMPLE_SCENARIOS,
    "--bindings",
    EXAMPLE_BINDINGS,
    "--app",
    "https://example.test",
    "--artifacts",
    artifacts,
    ...args
  ], options);
  return { root, artifacts, result };
}

function assertCliOk(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

after(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

describe("Criterion 1", () => {
  test("dry-run writes serializable plans and uses no browser, emulator, or database dependency", async () => {
    const { artifacts, result } = await runExample(["--dry-run", "--surface", "web", "--surface", "android"]);
    assertCliOk(result);
    assert.match(result.stdout, /clean compile/);

    const record = await readRecord(artifacts);
    assert.equal(record.scenarios.length, 4);
    for (const scenario of record.scenarios) {
      const planPath = path.join(record.artifactDir, scenario.planPath);
      const plan = JSON.parse(await readFile(planPath, "utf8"));
      assert.equal(JSON.stringify(plan).length > 0, true);
      assert.equal(plan.scenarioId, scenario.id);
      assert.equal(plan.surface, scenario.surface);
    }

    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const deps = packageJson.dependencies ?? {};
    // Phase 2 can replace this with adapter launch counters once real adapters exist.
    for (const name of ["playwright", "appium", "webdriverio", "pg", "mysql2", "mongodb", "@google-cloud/bigquery"]) {
      assert.equal(deps[name], undefined);
    }
  });

  test("dry-run reports a named compile error for unsupported database capability", () => {
    const result = runCli([
      "run",
      "--dry-run",
      "--scenarios",
      "test/fixtures/scenarios/checkout_guest_purchase.attest.yaml",
      "--bindings",
      "test/fixtures/bindings",
      "--app",
      "https://example.test",
      "--surface",
      "web"
    ]);

    assert.equal(result.status, 3);
    assert.match(result.stderr, /E_DELTA_UNSUPPORTED/);
  });
});

describe("Criterion 2", () => {
  test("all banned constructs are rejected before execution with file, line, column, code, and reason", () => {
    const invalids = [
      ["selector_in_step.attest.yaml", "E_SELECTOR_IN_SCENARIO"],
      ["url_in_step.attest.yaml", "E_URL_IN_SCENARIO"],
      ["platform_name.attest.yaml", "E_PLATFORM_NAME_IN_SCENARIO"],
      ["sleep_step.attest.yaml", "E_BANNED_SLEEP"],
      ["fixed_wait.attest.yaml", "E_BANNED_FIXED_WAIT"],
      ["platform_conditional.attest.yaml", "E_BANNED_CONDITIONAL"],
      ["unknown_op.attest.yaml", "E_UNKNOWN_OP"],
      ["wildcard_ignore.attest.yaml", "E_WILDCARD_ENTITY"],
      ["raw_no_reason.attest.yaml", "E_RAW_WITHOUT_REASON"]
    ];

    for (const [file, code] of invalids) {
      const result = runCli([
        "run",
        "--dry-run",
        "--scenarios",
        `test/fixtures/scenarios/invalid/${file}`,
        "--bindings",
        "test/fixtures/bindings",
        "--app",
        "https://example.test",
        "--surface",
        "web"
      ]);

      assert.equal(result.status, 3, file);
      assert.match(result.stderr, new RegExp(`${file}:\\d+:\\d+  ${code}  \\S`), file);
      assert.doesNotMatch(result.stdout, /clean compile/, file);
    }
  });
});

describe("Criterion 3", () => {
  test("one unchanged scenario lowers to web and Android with the same op sequence", async () => {
    const { artifacts, result } = await runExample([
      "--dry-run",
      "--id",
      "checkout.guest_purchase",
      "--surface",
      "web",
      "--surface",
      "android"
    ]);
    assertCliOk(result);

    const record = await readRecord(artifacts);
    const plans = await Promise.all(
      record.scenarios.map(async (scenario) =>
        JSON.parse(await readFile(path.join(record.artifactDir, scenario.planPath), "utf8"))
      )
    );
    const web = plans.find((plan) => plan.surface === "web");
    const android = plans.find((plan) => plan.surface === "android");
    assert.deepEqual(
      android.ops.map((op) => op.kind),
      web.ops.map((op) => op.kind)
    );
    assert(record.scenarios.every((scenario) => scenario.requirements.length > 0));
  });

  test("raw escape hatch reason is mandatory and counted in run.json", async () => {
    const rejected = runCli([
      "run",
      "--dry-run",
      "--scenarios",
      "test/fixtures/scenarios/invalid/raw_no_reason.attest.yaml",
      "--bindings",
      "test/fixtures/bindings",
      "--app",
      "https://example.test",
      "--surface",
      "web"
    ]);
    assert.equal(rejected.status, 3);
    assert.match(rejected.stderr, /E_RAW_WITHOUT_REASON/);

    const root = await tempRoot("raw");
    const artifacts = path.join(root, "artifacts");
    const accepted = runCli([
      "run",
      "--scenarios",
      "test/fixtures/scenarios/raw_escape_hatch.attest.yaml",
      "--bindings",
      "test/fixtures/bindings",
      "--app",
      "https://example.test",
      "--surface",
      "web",
      "--surface",
      "android",
      "--artifacts",
      artifacts
    ]);
    assertCliOk(accepted);
    const record = await readRecord(artifacts);
    assert.equal(record.escapeHatch.rawOpUses >= 1, true);
    assert(record.escapeHatch.uses.every((use) => typeof use.reason === "string" && use.reason.length >= 10));
    assert(record.scenarios.every((scenario) => scenario.requirements.length > 0));
  });
});

describe("Criterion 4", () => {
  test("pass, scenario failure, and harness error have distinct exit codes and reports", async () => {
    const pass = await runExample(["--surface", "web", "--id", "catalog.browse"]);
    assert.equal(pass.result.status, 0, pass.result.stderr);

    const fail = await runExample(["--surface", "web", "--id", "catalog.browse"], {
      env: { ATTEST_FAKE_SCRIPT: JSON.stringify({ byIndex: { 0: { outcome: "fail" } } }) }
    });
    assert.equal(fail.result.status, 1, fail.result.stderr);

    const infra = await runExample(["--surface", "web", "--id", "catalog.browse"], {
      env: { ATTEST_FAKE_SCRIPT: JSON.stringify({ byIndex: { 0: { outcome: "infra" } } }) }
    });
    assert.equal(infra.result.status, 2, infra.result.stderr);

    for (const artifactRoot of [pass.artifacts, fail.artifacts, infra.artifacts]) {
      const [runDir] = await readdir(artifactRoot);
      const runDirPath = path.join(artifactRoot, runDir);
      const runJson = JSON.parse(await readFile(path.join(runDirPath, "run.json"), "utf8"));
      assert.equal(typeof runJson.runId, "string");
      convert(await readFile(path.join(runDirPath, "junit.xml"), "utf8"), { format: "object" });
    }
  });

  test("hung step terminates within 10 seconds with timed out evidence", async () => {
    const started = Date.now();
    const run = await runExample(
      ["--surface", "web", "--id", "catalog.browse", "--timeout-step", "50", "--timeout-scenario", "1000"],
      {
        env: { ATTEST_FAKE_SCRIPT: JSON.stringify({ byIndex: { 0: { outcome: "hang" } } }) },
        timeout: 10000
      }
    );
    const duration = Date.now() - started;
    assert.equal(run.result.status, 1, run.result.stderr);
    assert(duration < 10000);

    const record = await readRecord(run.artifacts);
    const timedOut = record.scenarios.flatMap((scenario) => scenario.steps).find((step) => step.status === "timed_out");
    assert.notEqual(timedOut, undefined);
    assert.equal(timedOut.evidence.length > 0, true);
  });
});

describe("Criterion 5", () => {
  test("filters by id, tag, and surface and records headed mode", async () => {
    const byId = await runExample(["--surface", "web", "--id", "checkout.guest_purchase", "--headed"]);
    assertCliOk(byId.result);
    const byIdRecord = await readRecord(byId.artifacts);
    assert.deepEqual(byIdRecord.scenarios.map((scenario) => scenario.id), ["checkout.guest_purchase"]);
    assert.equal(byIdRecord.filters.headed, true);

    const byTag = await runExample(["--surface", "web", "--tag", "smoke"]);
    assertCliOk(byTag.result);
    const byTagRecord = await readRecord(byTag.artifacts);
    assert.deepEqual(byTagRecord.scenarios.map((scenario) => scenario.id).toSorted(), [
      "catalog.browse",
      "checkout.guest_purchase"
    ]);

    const bySurface = await runExample(["--surface", "android"]);
    assertCliOk(bySurface.result);
    const bySurfaceRecord = await readRecord(bySurface.artifacts);
    assert(bySurfaceRecord.scenarios.every((scenario) => scenario.surface === "android"));
  });

  test("suite passes with LLM API keys absent from the child environment", async () => {
    const env = childEnv();
    for (const key of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "AZURE_OPENAI_API_KEY",
      "MISTRAL_API_KEY",
      "COHERE_API_KEY"
    ]) {
      assert.equal(env[key], undefined);
    }
    assert.equal(Object.keys(env).some((key) => key.endsWith("_API_KEY")), false);

    const run = await runExample(["--surface", "web", "--surface", "android"], { env });
    assertCliOk(run.result);
  });
});
