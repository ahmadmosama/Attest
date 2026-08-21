import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { main } from "../../src/cli/main.mjs";
import { runCommand } from "../../src/cli/commands/run.mjs";
import { defineDbCapabilities } from "../../src/capabilities/db-caps.mjs";
import { loadRuleset } from "../../src/delta/rules/load.mjs";
import { InfraError } from "../../src/errors.mjs";
import { createDbDriver, DB_DRIVER_MODES } from "../../src/db/registry.mjs";

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

const DB_SCENARIO = `id: db.expected
requirement: [REQ-DB-001]
steps:
  - delta_window: open
  - delta_window: close
    expect_mutations:
      - entity: orders
        op: insert
        count: 1
        where: { id: one }
`;

const DB_ASSERT_SCENARIO = `id: db.assertion
requirement: [REQ-DB-002]
steps:
  - delta_window: open
  - delta_window: close
    require_no_unexplained: true
`;

const RULESET = `version: 1
rules: []
`;

const BROKEN_RULESET = `version: nope
rules: []
`;

const DB_URL = "postgres://user:secret@db.example.test:5432/app_test";

function dbConfig(overrides = {}) {
  return {
    app: "https://example.test",
    scenariosGlob: ["scenarios/db.attest.yaml"],
    bindingsDir: "bindings",
    surfaces: ["web"],
    db: {
      allowlist: [
        {
          host: "db.example.test",
          database: "app_test",
          nonProd: true,
          note: "unit test database"
        }
      ],
      rulesFile: null,
      ...overrides
    }
  };
}

function fullDbCaps(overrides = {}) {
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

function dbIo({ preflightCalls = [], caps = fullDbCaps(), load = loadRuleset, extra = {} } = {}) {
  const out = extra.out ?? [];
  const err = extra.err ?? [];
  return {
    env: { ATTEST_SURFACE_ADAPTER: "fake", ATTEST_DB_URL: DB_URL },
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    dbRunPreflight(args) {
      preflightCalls.push(args);
      return Object.freeze({
        ok: true,
        findings: Object.freeze({
          walLevel: "logical",
          replicationPrivilege: Object.freeze({ allowed: true }),
          degraded: Object.freeze([])
        })
      });
    },
    describePostgresCapabilities() {
      return caps;
    },
    dbLoadRuleset: load,
    now: () => new Date("2026-08-15T04:46:12.000Z")
  };
}

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
      ATTEST_SURFACE_ADAPTER: "fake",
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
        env: { ATTEST_SURFACE_ADAPTER: "fake" },
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

test("child CLI maps --timeout-preflight onto the preflight budget", async () => {
  await withCliFixture(async (cwd) => {
    // Preflight is where a real adapter installs the app and acquires the
    // device, so its budget scales with the size of the app under test rather
    // than with the scenario. Every other budget had a flag and this one did
    // not, which made a large mobile app untestable: a 123MB Expo debug build
    // takes far longer than the 15s default to `adb install`, and the run died
    // as an infra_error with no lever to pull.
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
    const script = JSON.stringify({ preflightDelayMs: 400 });

    const tooTight = runCli(cwd, [...baseArgs, "--timeout-preflight", "50"], { ATTEST_FAKE_SCRIPT: script });
    const roomy = runCli(cwd, [...baseArgs, "--timeout-preflight", "20000"], { ATTEST_FAKE_SCRIPT: script });

    // A preflight that cannot finish in its budget is infrastructure, not a
    // failing scenario, so it exits 2 rather than 1.
    assert.equal(tooTight.status, 2, tooTight.stderr);
    assert.equal(roomy.status, 0, roomy.stderr);
  });
});

test("runCommand passes all resolved timeout budgets into the run context", async () => {
  await withCliFixture(async (cwd) => {
    const seen = [];
    const out = [];
    const err = [];
    const code = await runCommand(
      {
        scenariosGlob: ["scenarios/smoke.attest.yaml"],
        bindingsDir: "bindings",
        app: "https://example.test",
        surfaces: ["web"],
        artifactRoot: path.join(cwd, "artifacts"),
        timeouts: {
          stepMs: 30001,
          scenarioMs: 30002,
          preflightMs: 30003,
          openMs: 30004,
          evidenceMs: 30005,
          closeMs: 30006
        }
      },
      {
        cwd,
        env: { ATTEST_SURFACE_ADAPTER: "fake" },
        stdout: { write: (text) => out.push(text) },
        stderr: { write: (text) => err.push(text) },
        now: () => new Date("2026-08-15T04:46:12.000Z"),
        adapterFor() {
          return {
            describeCapabilities: () => Object.freeze({ surface: "web", supports: [], degraded: [], has: () => true }),
            preflight(ctx) {
              seen.push({ ...ctx.timeouts });
              return Object.freeze({ ok: true });
            },
            open: () => Object.freeze({ id: "session", surface: "web" }),
            execute: () => Object.freeze({ ok: true }),
            collectEvidence: () => null,
            close: () => Object.freeze({ ok: true })
          };
        }
      }
    );

    assert.equal(code, 0, err.join(""));
    assert.deepEqual(seen[0], {
      stepMs: 30001,
      scenarioMs: 30002,
      preflightMs: 30003,
      openMs: 30004,
      evidenceMs: 30005,
      closeMs: 30006
    });
  });
});

test("runCommand without a db block does not probe or print a database banner", async () => {
  await withCliFixture(async (cwd) => {
    const out = [];
    const err = [];
    let probes = 0;
    const code = await runCommand(
      {
        dryRun: true,
        scenariosGlob: ["scenarios/smoke.attest.yaml"],
        bindingsDir: "bindings",
        app: "https://example.test",
        surfaces: ["web"],
        artifactRoot: path.join(cwd, "artifacts")
      },
      {
        cwd,
        env: { ATTEST_SURFACE_ADAPTER: "fake" },
        stdout: { write: (text) => out.push(text) },
        stderr: { write: (text) => err.push(text) },
        dbRunPreflight() {
          probes += 1;
          throw new Error("unexpected probe");
        }
      }
    );

    assert.equal(code, 0, err.join(""));
    assert.equal(probes, 0);
    assert.doesNotMatch(out.join(""), /database:/);
  });
});

test("runCommand probes configured database capabilities once and lowers with them", async () => {
  await withCliFixture(async (cwd) => {
    await writeFile(path.join(cwd, "scenarios", "db.attest.yaml"), DB_SCENARIO);
    await writeFile(path.join(cwd, "scenarios", "db-assert.attest.yaml"), DB_ASSERT_SCENARIO);
    const out = [];
    const err = [];
    const preflightCalls = [];
    const code = await runCommand(
      {
        dryRun: true,
        configFile: dbConfig(),
        scenariosGlob: ["scenarios/db.attest.yaml", "scenarios/db-assert.attest.yaml"],
        artifactRoot: path.join(cwd, "artifacts")
      },
      {
        cwd,
        ...dbIo({ preflightCalls, extra: { out, err } })
      }
    );

    assert.equal(code, 0, err.join(""));
    assert.equal(preflightCalls.length, 1);
    assert.match(out.join(""), /db\.expected \[web\] clean compile/);
    assert.match(out.join(""), /db\.assertion \[web\] clean compile/);
    assert.match(out.join(""), /database: postgres logical_slot db\.example\.test\/app_test/);
  });
});

test("runCommand refuses missing delta assertion capability at compile time", async () => {
  await withCliFixture(async (cwd) => {
    await writeFile(path.join(cwd, "scenarios", "db.attest.yaml"), DB_ASSERT_SCENARIO);
    const out = [];
    const err = [];
    const code = await runCommand(
      {
        dryRun: true,
        configFile: dbConfig(),
        artifactRoot: path.join(cwd, "artifacts")
      },
      {
        cwd,
        ...dbIo({
          caps: fullDbCaps({ deltaAssertion: false }),
          extra: { out, err }
        })
      }
    );

    assert.equal(code, 3);
    assert.match(err.join(""), /E_DELTA_UNSUPPORTED/);
    assert.match(err.join(""), /driver 'postgres'/);
    assert.doesNotMatch(out.join(""), /scenarios:/);
  });
});

test("runCommand reports unreachable database preflight as harness error", async () => {
  await withCliFixture(async (cwd) => {
    await writeFile(path.join(cwd, "scenarios", "db.attest.yaml"), DB_SCENARIO);
    const out = [];
    const err = [];
    const code = await runCommand(
      {
        dryRun: true,
        configFile: dbConfig(),
        artifactRoot: path.join(cwd, "artifacts")
      },
      {
        cwd,
        env: { ATTEST_SURFACE_ADAPTER: "fake", ATTEST_DB_URL: DB_URL },
        stdout: { write: (text) => out.push(text) },
        stderr: { write: (text) => err.push(text) },
        dbRunPreflight() {
          throw new InfraError("E_DB_UNREACHABLE", "Database target db.example.test/app_test is unreachable.");
        }
      }
    );

    assert.equal(code, 2);
    assert.match(err.join(""), /Remediation:/);
    assert.doesNotMatch(out.join(""), /\d+ scenarios:/);
  });
});

test("runCommand refuses unlisted and unmarked targets before preflight", async () => {
  await withCliFixture(async (cwd) => {
    await writeFile(path.join(cwd, "scenarios", "db.attest.yaml"), DB_SCENARIO);
    let probes = 0;
    const io = {
      cwd,
      env: { ATTEST_SURFACE_ADAPTER: "fake", ATTEST_DB_URL: DB_URL },
      stdout: { write() {} },
      stderr: { write() {} },
      dbRunPreflight() {
        probes += 1;
      }
    };

    const unlisted = await runCommand({
      dryRun: true,
      configFile: dbConfig({ allowlist: [] })
    }, io);
    const unmarked = await runCommand({
      dryRun: true,
      configFile: {
        ...dbConfig(),
        db: {
          ...dbConfig().db,
          allowlist: [{ host: "db.example.test", database: "app_test", note: "missing marker" }]
        }
      }
    }, io);

    assert.equal(unlisted, 3);
    assert.equal(unmarked, 3);
    assert.equal(probes, 0);
  });
});

test("runCommand loads a ruleset once, records its hash, and prints broken ruleset diagnostics", async () => {
  await withCliFixture(async (cwd) => {
    await mkdir(path.join(cwd, "rules"), { recursive: true });
    await writeFile(path.join(cwd, "scenarios", "db.attest.yaml"), DB_SCENARIO);
    await writeFile(path.join(cwd, "rules", "ok.yaml"), RULESET);
    await writeFile(path.join(cwd, "rules", "bad.yaml"), BROKEN_RULESET);
    const out = [];
    const err = [];
    let loads = 0;
    const artifacts = path.join(cwd, "artifacts");
    const code = await runCommand(
      {
        dryRun: true,
        configFile: dbConfig({ rulesFile: "rules/ok.yaml" }),
        artifactRoot: artifacts
      },
      {
        cwd,
        ...dbIo({
          extra: { out, err },
          load(args) {
            loads += 1;
            return loadRuleset(args);
          }
        })
      }
    );

    assert.equal(code, 0, err.join(""));
    assert.equal(loads, 1);
    const [runDir] = await readdir(artifacts);
    const record = JSON.parse(await readFile(path.join(artifacts, runDir, "run.json"), "utf8"));
    assert.match(record.hashes.ruleset, /^[0-9a-f]{64}$/);

    const brokenErr = [];
    const broken = await runCommand(
      {
        dryRun: true,
        configFile: dbConfig({ rulesFile: "rules/bad.yaml" }),
        artifactRoot: path.join(cwd, "bad-artifacts")
      },
      {
        cwd,
        ...dbIo({ extra: { out: [], err: brokenErr } })
      }
    );
    assert.equal(broken, 3);
    assert.match(brokenErr.join(""), /bad\.yaml:\d+:\d+  E_RULESET_SCHEMA/);
  });
});

test("createDbDriver reports every engine as implemented and builds them behind one port", () => {
  assert.deepEqual(DB_DRIVER_MODES, {
    postgres: "implemented",
    sqlite: "implemented",
    mysql: "implemented",
    mongo: "implemented",
    bigquery: "implemented"
  });

  const target = Object.freeze({
    driver: "postgres",
    host: "db.example.test",
    port: 5432,
    database: "app_test",
    user: "user"
  });
  const driver = createDbDriver({ target, runId: "run", scenarioId: "scenario.one" });
  assert.equal(typeof driver.preflight, "function");

  // Every engine builds. Substituting one for another would produce a green run
  // that verified a database nobody asked about, so there is no fallback path
  // and an unknown driver is still refused by name.
  for (const [name, extra] of [
    ["sqlite", { host: "file", database: "./local.db", port: null }],
    ["mysql", {}],
    ["mongo", {}],
    ["bigquery", { host: "project", database: "dataset", port: null }]
  ]) {
    const built = createDbDriver({
      target: { ...target, driver: name, ...extra },
      runId: "run",
      scenarioId: "scenario.one"
    });
    assert.equal(typeof built.preflight, "function", name);
  }

  assert.throws(
    () => createDbDriver({ target: { ...target, driver: "cassandra" }, runId: "run", scenarioId: "scenario.one" }),
    { code: "E_DB_DRIVER_UNKNOWN" }
  );
});

test("runCommand database banner never prints credentials or connection strings", async () => {
  await withCliFixture(async (cwd) => {
    await writeFile(path.join(cwd, "scenarios", "db.attest.yaml"), DB_SCENARIO);
    const out = [];
    const err = [];
    const code = await runCommand(
      {
        dryRun: true,
        configFile: dbConfig(),
        artifactRoot: path.join(cwd, "artifacts")
      },
      {
        cwd,
        ...dbIo({ extra: { out, err } })
      }
    );
    const stdout = out.join("");

    assert.equal(code, 0, err.join(""));
    assert.match(stdout, /db\.example\.test\/app_test/);
    assert.doesNotMatch(stdout, /secret/);
    assert.doesNotMatch(stdout, /postgres:\/\/user/);
  });
});
