import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { main } from "../../src/cli/main.mjs";

const CLI = path.join(process.cwd(), "src/cli/main.mjs");

const SCENARIO = `id: smoke.minimal
requirement: [REQ-SMOKE-001]
tags: [smoke]
steps:
  - open: screen:catalog
`;

const SKIP_SCENARIO = `id: camera.missing
requirement: [REQ-CAM-001]
steps:
  - set_clipboard: copied
`;

const INVALID_SCENARIO = `id: invalid.sleep_step
requirement: [REQ-BAN-001]
steps:
  - tap:
      target: button:continue
      sleep: true
`;

const BINDINGS = `surface: web
elements:
  field:file: { testId: file-input }
screens:
  screen:catalog: { path: "/", ready: { role: heading, name: "Catalog" } }
`;

async function withCliFixture(fn) {
  const dir = await mkdtemp(path.join(process.cwd(), "test/cli/run-"));
  try {
    await mkdir(path.join(dir, "scenarios"), { recursive: true });
    await mkdir(path.join(dir, "bindings", "shop"), { recursive: true });
    await writeFile(path.join(dir, "scenarios", "smoke.attest.yaml"), SCENARIO);
    await writeFile(path.join(dir, "scenarios", "skip.attest.yaml"), SKIP_SCENARIO);
    await writeFile(path.join(dir, "scenarios", "invalid.attest.yaml"), INVALID_SCENARIO);
    await writeFile(path.join(dir, "bindings", "shop", "web.yaml"), BINDINGS);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runCli(cwd, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      ...env
    }
  });
}

test("child CLI dry-run exits 0 and writes a plan", async () => {
  await withCliFixture(async (cwd) => {
    const artifacts = path.join(cwd, "artifacts");
    const result = runCli(cwd, [
      "run",
      "--dry-run",
      "--scenarios",
      "scenarios/smoke.attest.yaml",
      "--bindings",
      "bindings",
      "--app",
      "https://example.test",
      "--surface",
      "web",
      "--artifacts",
      artifacts
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean compile/);
  });
});

test("child CLI compile error exits 3 with a diagnostic line", async () => {
  await withCliFixture(async (cwd) => {
    const result = runCli(cwd, [
      "run",
      "--dry-run",
      "--scenarios",
      "scenarios/invalid.attest.yaml",
      "--bindings",
      "bindings",
      "--app",
      "https://example.test",
      "--surface",
      "web"
    ]);

    assert.equal(result.status, 3);
    assert.match(result.stderr, /invalid\.attest\.yaml:\d+:\d+  E_BANNED_SLEEP/);
  });
});

test("child CLI distinguishes scenario failure and infra error", async () => {
  await withCliFixture(async (cwd) => {
    const baseArgs = [
      "run",
      "--scenarios",
      "scenarios/smoke.attest.yaml",
      "--bindings",
      "bindings",
      "--app",
      "https://example.test",
      "--surface",
      "web"
    ];

    const fail = runCli(cwd, baseArgs, {
      ATTEST_FAKE_SCRIPT: JSON.stringify({ byIndex: { 0: { outcome: "fail" } } })
    });
    const infra = runCli(cwd, baseArgs, {
      ATTEST_FAKE_SCRIPT: JSON.stringify({ byIndex: { 0: { outcome: "infra" } } })
    });

    assert.equal(fail.status, 1, fail.stderr);
    assert.equal(infra.status, 2, infra.stderr);
  });
});

test("child CLI unknown flag and ipa refusal exit with usage code", async () => {
  await withCliFixture(async (cwd) => {
    const unknown = runCli(cwd, ["run", "--wat"]);
    assert.equal(unknown.status, 3);
    assert.match(unknown.stderr, /unknown option/);

    const ipa = runCli(cwd, [
      "run",
      "--dry-run",
      "--scenarios",
      "scenarios/smoke.attest.yaml",
      "--bindings",
      "bindings",
      "--app",
      "build/Runner.ipa",
      "--surface",
      "web"
    ]);
    assert.equal(ipa.status, 3);
    assert.match(ipa.stderr, /generic\/platform=iOS Simulator/);
  });
});

test("child CLI skipped runs exit 4 by default and 0 with no-fail-on-skip", async () => {
  await withCliFixture(async (cwd) => {
    const args = [
      "run",
      "--dry-run",
      "--scenarios",
      "scenarios/skip.attest.yaml",
      "--bindings",
      "bindings",
      "--app",
      "https://example.test",
      "--surface",
      "web"
    ];

    assert.equal(runCli(cwd, args).status, 4);
    assert.equal(runCli(cwd, [...args, "--no-fail-on-skip"]).status, 0);
  });
});

test("main writes through injected io only", async () => {
  await withCliFixture(async (cwd) => {
    const out = [];
    const err = [];
    const code = await main(
      [
        "node",
        CLI,
        "run",
        "--dry-run",
        "--scenarios",
        "scenarios/smoke.attest.yaml",
        "--bindings",
        "bindings",
        "--app",
        "https://example.test",
        "--surface",
        "web"
      ],
      {
        cwd,
        env: {},
        stdout: { write: (text) => out.push(text) },
        stderr: { write: (text) => err.push(text) },
        now: () => new Date("2026-08-15T04:46:12.000Z")
      }
    );

    assert.equal(code, 0);
    assert.match(out.join(""), /clean compile/);
    assert.equal(err.join(""), "");
  });
});

test("child CLI carries headed mode into the run record", async () => {
  await withCliFixture(async (cwd) => {
    const artifacts = path.join(cwd, "artifacts");
    const result = runCli(cwd, [
      "run",
      "--headed",
      "--scenarios",
      "scenarios/smoke.attest.yaml",
      "--bindings",
      "bindings",
      "--app",
      "https://example.test",
      "--surface",
      "web",
      "--artifacts",
      artifacts
    ]);

    assert.equal(result.status, 0, result.stderr);
    const [runDir] = await readdir(artifacts);
    const record = JSON.parse(await readFile(path.join(artifacts, runDir, "run.json"), "utf8"));
    assert.equal(record.filters.headed, true);
  });
});
