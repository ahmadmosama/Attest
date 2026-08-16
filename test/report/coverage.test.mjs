import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { computeCoverage } from "../../src/report/coverage.mjs";

const CLI = path.join(process.cwd(), "src/cli/main.mjs");

const SCENARIO = `id: smoke.minimal
requirement: [SCEN-07, RUN-01]
tags: [smoke]
steps:
  - open: screen:catalog
`;

const SECOND_SCENARIO = `id: smoke.second
requirement: [RUN-01]
tags: [smoke]
steps:
  - open: screen:catalog
`;

const BINDINGS = `surface: web
screens:
  screen:catalog: { path: "/", ready: { role: heading, name: "Catalog" } }
`;

function scenario(id, requirements) {
  return Object.freeze({ id, requirements });
}

async function withCoverageFixture(fn) {
  const root = await mkdtemp(path.join(process.cwd(), "test/report/coverage-"));
  try {
    await mkdir(path.join(root, "scenarios"), { recursive: true });
    await mkdir(path.join(root, "bindings", "shop"), { recursive: true });
    await writeFile(path.join(root, "scenarios", "one.attest.yaml"), SCENARIO);
    await writeFile(path.join(root, "scenarios", "two.attest.yaml"), SECOND_SCENARIO);
    await writeFile(path.join(root, "bindings", "shop", "web.yaml"), BINDINGS);
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function childEnv() {
  const env = Object.fromEntries(
    ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]
      .map((key) => [key, process.env[key]])
      .filter(([, value]) => value !== undefined)
  );
  return { ...env, ATTEST_SURFACE_ADAPTER: "fake" };
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv()
  });
}

test("computeCoverage sorts and dedupes covered requirement IDs", () => {
  const coverage = computeCoverage({
    scenarios: [
      scenario("checkout.guest_purchase", ["SCEN-01", "SCEN-02"]),
      scenario("checkout.returning_purchase", ["SCEN-02", "RUN-01"])
    ]
  });

  assert.deepEqual(coverage.covered, ["RUN-01", "SCEN-01", "SCEN-02"]);
  assert.deepEqual(coverage.byScenario, {
    "checkout.guest_purchase": ["SCEN-01", "SCEN-02"],
    "checkout.returning_purchase": ["RUN-01", "SCEN-02"]
  });
  assert.deepEqual(coverage.uncovered, []);
  assert.deepEqual(coverage.unknown, []);
});

test("computeCoverage reports uncovered and unknown IDs against a declared list", () => {
  const coverage = computeCoverage({
    scenarios: [scenario("checkout.guest_purchase", ["SCEN-01", "SCEN-02", "FAKE-99"])],
    declaredRequirements: ["SCEN-01", "SCEN-02", "SCEN-03"]
  });

  assert.deepEqual(coverage.uncovered, ["SCEN-03"]);
  assert.deepEqual(coverage.unknown, ["FAKE-99"]);
});

test("computeCoverage stays deterministic and frozen", () => {
  const input = {
    scenarios: [scenario("b", ["SCEN-02"]), scenario("a", ["SCEN-01", "SCEN-02"])],
    declaredRequirements: ["SCEN-01", "SCEN-02"]
  };
  const left = computeCoverage(input);
  const right = computeCoverage(input);

  assert.deepEqual(left, right);
  assert.equal(Object.isFrozen(left), true);
  assert.equal(Object.isFrozen(left.covered), true);
  assert.throws(() => {
    left.covered.push("RUN-01");
  });
});

test("attest run writes requirement coverage and declared list details", async () => {
  await withCoverageFixture(async (cwd) => {
    const artifacts = path.join(cwd, "artifacts");
    const requirementsFile = path.join(cwd, "requirements.txt");
    await writeFile(requirementsFile, "SCEN-07\nRUN-01\nRUN-03\n");

    const result = runCli(cwd, [
      "run",
      "--scenarios",
      "scenarios/*.attest.yaml",
      "--bindings",
      "bindings",
      "--app",
      "https://example.test",
      "--surface",
      "web",
      "--artifacts",
      artifacts,
      "--requirements",
      requirementsFile
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /requirements: 2 covered, 1 uncovered, 0 unknown/);
    const [runDir] = await readdir(artifacts);
    const record = JSON.parse(await readFile(path.join(artifacts, runDir, "run.json"), "utf8"));
    assert.deepEqual(record.requirements.covered, ["RUN-01", "SCEN-07"]);
    assert.deepEqual(record.requirements.byScenario, {
      "smoke.minimal": ["RUN-01", "SCEN-07"],
      "smoke.second": ["RUN-01"]
    });
    assert.deepEqual(record.requirements.uncovered, ["RUN-03"]);
    assert.deepEqual(record.requirements.unknown, []);
  });
});

test("attest run --requirements accepts a JSON array list", async () => {
  await withCoverageFixture(async (cwd) => {
    const artifacts = path.join(cwd, "artifacts");
    const requirementsFile = path.join(cwd, "requirements.json");
    await writeFile(requirementsFile, JSON.stringify(["SCEN-07", "RUN-01", "RUN-09"]));

    const result = runCli(cwd, [
      "run",
      "--dry-run",
      "--scenarios",
      "scenarios/one.attest.yaml",
      "--bindings",
      "bindings",
      "--app",
      "https://example.test",
      "--surface",
      "web",
      "--artifacts",
      artifacts,
      "--requirements",
      requirementsFile
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /requirements: 2 covered, 1 uncovered, 0 unknown/);
    const [runDir] = await readdir(artifacts);
    const record = JSON.parse(await readFile(path.join(artifacts, runDir, "run.json"), "utf8"));
    assert.deepEqual(record.requirements.uncovered, ["RUN-09"]);
  });
});
