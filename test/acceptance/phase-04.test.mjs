import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, test } from "node:test";

import { EXIT } from "../../src/cli/exit-codes.mjs";
import { selfcheckCommand } from "../../src/cli/commands/selfcheck.mjs";
import { loadCorpus } from "../../src/selfverify/corpus.mjs";
import { seedDigest } from "../../src/db/seed.mjs";
import { SEED, SEED_DIGEST } from "../../fixtures/self-verify/app/seed.mjs";
import { probePostgres, postgresUrl, skipUnlessPostgres, withPostgresSlotLock } from "../helpers/postgres.mjs";
import { runSelfVerification } from "../../src/selfverify/runner.mjs";

const ROOTS = [];
const BASELINE_PATH = path.join(process.cwd(), "fixtures/self-verify/baseline.json");
const CORPUS_PATH = path.join(process.cwd(), "fixtures/self-verify/corpus.yaml");
const DASH = "-";
const TEST_FLAG = `${DASH}${DASH}test`;
const TIMEOUT_FLAG = `${DASH}${DASH}test-timeout=120000`;

async function pgAvailability() {
  const url = postgresUrl();
  const probe = await probePostgres(url);
  return Object.freeze({
    ok: probe.ok,
    reason: probe.ok ? null : `Postgres tests skipped: ${probe.reason}`
  });
}

const LIVE_STATUS = await pgAvailability();

function childEnv(extra = {}) {
  return Object.fromEntries(
    ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]
      .map((key) => [key, process.env[key]])
      .filter(([, value]) => value !== undefined)
      .concat(Object.entries(extra))
  );
}

async function tempRoot(label) {
  const root = await mkdtemp(path.join(process.cwd(), `test/acceptance/${label}-`));
  ROOTS.push(root);
  await mkdir(path.join(root, "fixtures", "self-verify"), { recursive: true });
  return root;
}

async function baselineRecord(fields = {}) {
  const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
  return Object.freeze({
    ...baseline,
    ...fields,
    counts: fields.counts ?? baseline.counts,
    hashes: fields.hashes ?? baseline.hashes,
    mutants: fields.mutants ?? baseline.mutants
  });
}

async function writeBaseline(root, label, fields = {}) {
  const file = path.join(root, "fixtures", "self-verify", `${label}.json`);
  await writeFile(file, `${JSON.stringify(await baselineRecord(fields), null, 2)}\n`, "utf8");
  return file;
}

function target() {
  return Object.freeze({
    driver: "postgres",
    host: "127.0.0.1",
    port: 54322,
    database: "postgres",
    user: "postgres"
  });
}

function result(mutantId, outcome) {
  return Object.freeze({
    mutantId,
    outcome,
    exitCode: outcome === "survived" ? 0 : 1,
    reason: outcome
  });
}

function killRateFromBaseline(baseline) {
  return Object.freeze({
    version: 1,
    baseline: Object.freeze({ outcome: "passed", exitCode: 0, reason: "passed" }),
    counts: baseline.counts,
    rate: baseline.rate,
    ratePercent: baseline.ratePercent,
    confidence: baseline.confidence,
    restored: true,
    hashes: baseline.hashes,
    results: Object.freeze(baseline.mutants.map((mutant) => result(mutant.id, mutant.outcome)))
  });
}

function injectedIo(root, killRate) {
  const out = [];
  const err = [];
  return {
    cwd: root,
    env: {},
    target: target(),
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    now: () => new Date("2026-08-17T12:00:00.000Z"),
    loadCorpus: () => Object.freeze({ corpus: Object.freeze({ version: 1, mutants: [] }), hash: killRate.hashes.corpus }),
    runSelfVerification: () => Object.freeze({ restored: true, killRate }),
    output: () => out.join(""),
    error: () => err.join("")
  };
}

function assertExactOrphanRows(text) {
  assert.match(text, /E_DELTA_MISSING_MUTATION/u);
  assert.match(text, /order_items/u);
  assert.match(text, /"order_id":"order_100"/u);
  assert.match(text, /"order_id":"order_101"/u);
  assert.match(text, /"id":"order_100"/u);
  assert.match(text, /"id":"order_101"/u);
}

function runChildTests(files) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TEST_FLAG, TIMEOUT_FLAG, ...files], {
      cwd: process.cwd(),
      env: childEnv({
        PLAYWRIGHT_BROWSERS_PATH: path.join(process.cwd(), "test/acceptance/no-browser-cache")
      }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status, signal) => {
      resolve(Object.freeze({ status, signal, stdout, stderr }));
    });
  });
}

function childOutput(childResult) {
  return `${childResult.stdout}\n${childResult.stderr}`;
}

// Only these five fields are allowed to differ between two runs of the same
// suite against the same fixture. Everything else, verdicts, counts, delta
// buckets, hashes, row keys, must match exactly. Widening this list to make a
// comparison pass would turn a reproducibility proof back into a tautology.
const VOLATILE_FIELDS = Object.freeze(["runId", "artifactDir", "startedAt", "finishedAt", "durationMs"]);

function normalizeForReproducibility(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeForReproducibility);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) =>
      VOLATILE_FIELDS.includes(key) ? [key, "<normalized>"] : [key, normalizeForReproducibility(child)]
    )
  );
}

function emptyCorpus(loaded) {
  return Object.freeze({ ...loaded, corpus: Object.freeze({ ...loaded.corpus, mutants: Object.freeze([]) }) });
}

function corpusWithOnly(loaded, mutantId) {
  const mutants = loaded.corpus.mutants.filter((mutant) => mutant.id === mutantId);
  assert.equal(mutants.length, 1, `expected exactly one mutant named ${mutantId}`);
  return Object.freeze({ ...loaded, corpus: Object.freeze({ ...loaded.corpus, mutants: Object.freeze(mutants) }) });
}

after(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

describe("Phase 4 self verification acceptance", LIVE_STATUS.ok ? {} : { skip: LIVE_STATUS.reason }, () => {
  test("Criterion 1: the fixture app ships deterministic seed data and the orphan row delete case is named exactly", async (t) => {
    const live = await skipUnlessPostgres(t);
    if (live === null) {
      return;
    }

    const loaded = await loadCorpus({ file: CORPUS_PATH });
    const byId = new Map(loaded.corpus.mutants.map((mutant) => [mutant.id, mutant]));

    assert.equal(seedDigest(SEED), SEED_DIGEST);
    assert.equal(byId.has("delete_orphan_child_rows"), true);
    assert.equal(byId.get("delete_orphan_child_rows").caught_by, "DELTA-01");

    // The orphan claim is proven by running the mutant against the real
    // database, not by reading it back out of baseline.json. Asserting that a
    // recorded file says the case was killed would only prove the file is
    // internally consistent.
    const orphanRun = await withPostgresSlotLock(live, () =>
      runSelfVerification({
        corpus: corpusWithOnly(loaded, "delete_orphan_child_rows"),
        target: live.target,
        io: { env: process.env }
      })
    );

    assert.equal(orphanRun.baseline.outcome, "passed");
    assert.equal(orphanRun.restored, true);
    assert.equal(orphanRun.results.length, 1);

    const orphan = orphanRun.results[0];
    assert.equal(orphan.mutantId, "delete_orphan_child_rows");
    assert.equal(orphan.outcome, "killed");
    assertExactOrphanRows(orphan.reason);
  });

  test("Criterion 2: one selfcheck command prints a kill rate and blocks a drop below baseline", async () => {
    const root = await tempRoot("phase04-c2");
    const baseline = await baselineRecord({ rate: 0.5, ratePercent: 50 });
    const current = killRateFromBaseline(await baselineRecord());
    const passFile = await writeBaseline(root, "pass-baseline", baseline);
    const failFile = await writeBaseline(root, "fail-baseline", { rate: 1, ratePercent: 100 });
    const passIo = injectedIo(root, current);
    const pass = await selfcheckCommand({ baseline: passFile, target: target() }, passIo);

    assert.equal(pass, EXIT.PASS, passIo.error());
    assert.match(passIo.output(), /Kill rate: 90\.91%/u);
    assert.match(passIo.output(), /Mutants: killed 10, survived 1, errored 0, total 11/u);

    const failIo = injectedIo(root, current);
    const fail = await selfcheckCommand({ baseline: failFile, target: target() }, failIo);

    assert.equal(fail, EXIT.SCENARIO_FAILURE);
    assert.match(failIo.output(), /Current survivors: survivor_create_audit_detail/u);
  });

  test("Criterion 3: classifier and rule engine tests run with no app, no browser, and no database", async () => {
    const childResult = await runChildTests([
      "test/delta/classify.test.mjs",
      "test/delta/rules/engine.test.mjs"
    ]);

    assert.equal(childResult.status, 0, childOutput(childResult));
    assert.equal(childResult.signal, null);
    assert.doesNotMatch(childOutput(childResult), /ATTEST_DB_URL|ATTEST_PG_URL|chrome channel/u);
  });

  test("Criterion 4: running the unchanged suite twice against the unchanged fixture app produces an identical verdict", async (t) => {
    const live = await skipUnlessPostgres(t);
    if (live === null) {
      return;
    }

    // A corpus with zero mutants makes each call a real, unmutated run of the
    // fixture suite against the real database. Comparing two synthetic copies
    // of one value would prove only that equal things are equal.
    const loaded = emptyCorpus(await loadCorpus({ file: CORPUS_PATH }));
    const runOnce = () =>
      runSelfVerification({ corpus: loaded, target: live.target, io: { env: process.env } });

    const first = await withPostgresSlotLock(live, runOnce);
    const second = await withPostgresSlotLock(live, runOnce);

    assert.equal(first.baseline.outcome, "passed");
    assert.equal(second.baseline.outcome, "passed");

    const firstNormalized = normalizeForReproducibility(first.baseline);
    const secondNormalized = normalizeForReproducibility(second.baseline);
    assert.deepEqual(firstNormalized, secondNormalized);

    // Teeth check. If the comparison above passed only because normalisation
    // erased everything that matters, then perturbing a non volatile value
    // would still compare equal. It must not.
    const perturbed = { ...secondNormalized, outcome: "failed" };
    assert.notDeepEqual(firstNormalized, perturbed);
  });
});
