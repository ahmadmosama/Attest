import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { EXIT } from "../../src/cli/exit-codes.mjs";
import { main } from "../../src/cli/main.mjs";
import { selfcheckCommand } from "../../src/cli/commands/selfcheck.mjs";
import { AttestError } from "../../src/errors.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const DASH = "-";
const FLAG_JSON = `${DASH}${DASH}json`;
const FLAG_CORPUS = `${DASH}${DASH}corpus`;

function target() {
  return Object.freeze({
    driver: "postgres",
    host: "127.0.0.1",
    port: 54322,
    database: "postgres",
    user: "postgres"
  });
}

function counts(fields = {}) {
  return Object.freeze({
    total: 3,
    killed: 2,
    survived: 1,
    errored: 0,
    scored: 3,
    ...fields
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

function killRate(fields = {}) {
  const rate = fields.rate ?? 2 / 3;
  return Object.freeze({
    version: 1,
    baseline: Object.freeze({ outcome: "passed", exitCode: 0, reason: "passed" }),
    counts: counts(fields.counts),
    rate,
    ratePercent: Number((rate * 100).toFixed(2)),
    confidence: fields.confidence ?? "clean",
    restored: fields.restored ?? true,
    hashes: Object.freeze({
      corpus: fields.corpusHash ?? HASH_A,
      ruleset: fields.rulesetHash ?? HASH_B,
      fixtureTree: fields.fixtureTreeHash ?? HASH_C
    }),
    results: Object.freeze(fields.results ?? [
      result("mutant_one", "killed"),
      result("mutant_two", "killed"),
      result("mutant_three", "survived")
    ])
  });
}

function baseline(fields = {}) {
  const rate = fields.rate ?? 2 / 3;
  return Object.freeze({
    version: 1,
    updatedAt: "2026-08-17",
    corpus: "fixtures/self-verify/corpus.yaml",
    rate,
    ratePercent: Number((rate * 100).toFixed(2)),
    confidence: "clean",
    counts: counts(fields.counts),
    hashes: Object.freeze({
      corpus: fields.corpusHash ?? HASH_A,
      ruleset: fields.rulesetHash ?? HASH_B,
      fixtureTree: fields.fixtureTreeHash ?? HASH_C
    }),
    mutants: Object.freeze(fields.mutants ?? [
      Object.freeze({ id: "mutant_one", outcome: "killed" }),
      Object.freeze({ id: "mutant_two", outcome: "killed" }),
      Object.freeze({ id: "mutant_three", outcome: "survived" })
    ])
  });
}

async function withRoot(fn) {
  const root = await mkdtemp(path.join(process.cwd(), "test/cli/selfcheck-"));
  try {
    await mkdir(path.join(root, "fixtures", "self-verify"), { recursive: true });
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeBaseline(root, value = baseline()) {
  const file = path.join(root, "fixtures", "self-verify", "baseline.json");
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

function io(root, current = killRate(), extra = {}) {
  const out = [];
  const err = [];
  return {
    cwd: root,
    env: {},
    target: target(),
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    now: () => new Date("2026-08-17T10:00:00.000Z"),
    loadCorpus: () => Object.freeze({ corpus: Object.freeze({ version: 1, mutants: [] }), hash: HASH_A }),
    runSelfVerification: extra.runSelfVerification ?? (() => Object.freeze({ restored: true, killRate: current })),
    output: () => out.join(""),
    error: () => err.join("")
  };
}

test("selfcheck passes when the current rate equals the recorded baseline", async () => {
  await withRoot(async (root) => {
    const baselineFile = await writeBaseline(root);
    const harness = io(root);
    const code = await selfcheckCommand({ baseline: baselineFile, target: target() }, harness);

    assert.equal(code, EXIT.PASS, harness.error());
    assert.match(harness.output(), /Kill rate: 66\.67%/u);
    assert.match(harness.output(), /Hashes: corpus/u);
    assert.doesNotMatch(harness.output(), /postgres:\/\//u);
  });
});

test("selfcheck fails on a rate drop and names newly survived mutants", async () => {
  await withRoot(async (root) => {
    const current = killRate({
      rate: 1 / 3,
      counts: counts({ killed: 1, survived: 2 }),
      results: [result("mutant_one", "killed"), result("mutant_two", "survived"), result("mutant_three", "survived")]
    });
    const baselineFile = await writeBaseline(root, baseline({
      rate: 2 / 3,
      mutants: [
        { id: "mutant_one", outcome: "killed" },
        { id: "mutant_two", outcome: "killed" },
        { id: "mutant_three", outcome: "survived" }
      ]
    }));
    const harness = io(root, current);
    const code = await selfcheckCommand({ baseline: baselineFile, target: target() }, harness);

    assert.equal(code, EXIT.SCENARIO_FAILURE);
    assert.match(harness.output(), /Newly survived mutants: mutant_two/u);
    assert.match(harness.output(), /Current survivors: mutant_two, mutant_three/u);
  });
});

test("selfcheck prints a not like for like warning on corpus hash mismatch", async () => {
  await withRoot(async (root) => {
    const baselineFile = await writeBaseline(root, baseline({ corpusHash: HASH_D }));
    const harness = io(root);
    const code = await selfcheckCommand({ baseline: baselineFile, target: target() }, harness);

    assert.equal(code, EXIT.SCENARIO_FAILURE);
    assert.match(harness.output(), /Not like for like: corpus changed/u);
  });
});

test("selfcheck reports errored mutants as degraded confidence", async () => {
  await withRoot(async (root) => {
    const current = killRate({
      counts: counts({ killed: 2, survived: 0, errored: 1 }),
      results: [result("mutant_one", "killed"), result("mutant_two", "killed"), result("mutant_three", "error")]
    });
    const baselineFile = await writeBaseline(root, baseline({ rate: 0.5 }));
    const harness = io(root, current);
    const code = await selfcheckCommand({ baseline: baselineFile, target: target() }, harness);

    assert.equal(code, EXIT.SCENARIO_FAILURE);
    assert.match(harness.output(), /Confidence degraded/u);
  });
});

test("selfcheck never updates the baseline unless the update flag is passed", async () => {
  await withRoot(async (root) => {
    const baselineFile = await writeBaseline(root, baseline({ rate: 0.5 }));
    const before = await readFile(baselineFile, "utf8");
    const harness = io(root, killRate({ rate: 2 / 3 }));
    const code = await selfcheckCommand({ baseline: baselineFile, target: target() }, harness);
    const after = await readFile(baselineFile, "utf8");

    assert.equal(code, EXIT.PASS, harness.error());
    assert.equal(after, before);
    assert.match(harness.output(), /update-baseline/u);
  });
});

test("selfcheck update baseline writes the old to new rate line", async () => {
  await withRoot(async (root) => {
    const baselineFile = await writeBaseline(root, baseline({ rate: 0.5 }));
    const harness = io(root, killRate({ rate: 2 / 3 }));
    const code = await selfcheckCommand({ baseline: baselineFile, target: target(), updateBaseline: true }, harness);
    const updated = JSON.parse(await readFile(baselineFile, "utf8"));

    assert.equal(code, EXIT.PASS, harness.error());
    assert.equal(updated.rate, 2 / 3);
    assert.match(harness.output(), /Baseline updated: 50\.00% to 66\.67%/u);
  });
});

test("selfcheck json emits a machine readable record", async () => {
  await withRoot(async (root) => {
    const baselineFile = await writeBaseline(root);
    const harness = io(root);
    const code = await selfcheckCommand({ baseline: baselineFile, target: target(), json: true }, harness);
    const record = JSON.parse(harness.output());

    assert.equal(code, EXIT.PASS, harness.error());
    assert.equal(record.status, "passed");
    assert.equal(record.current.counts.killed, 2);
    assert.deepEqual(record.current.mutants.map((mutant) => mutant.id), ["mutant_one", "mutant_two", "mutant_three"]);
  });
});

test("selfcheck exits harness error and prints no rate for a red baseline scenario", async () => {
  await withRoot(async (root) => {
    const baselineFile = await writeBaseline(root);
    const harness = io(root, killRate(), {
      runSelfVerification() {
        throw new AttestError("E_SELFVERIFY_BASELINE_FAILED", "baseline red");
      }
    });
    const code = await selfcheckCommand({ baseline: baselineFile, target: target() }, harness);

    assert.equal(code, EXIT.HARNESS_ERROR);
    assert.match(harness.error(), /No kill rate printed/u);
    assert.doesNotMatch(harness.output(), /Kill rate:/u);
  });
});

test("main wires selfcheck options through injected io", async () => {
  await withRoot(async (root) => {
    const baselineFile = await writeBaseline(root);
    const out = [];
    const err = [];
    const code = await main(["node", "attest", "selfcheck", FLAG_JSON, FLAG_CORPUS, "corpus.yaml"], {
      ...io(root),
      stdout: { write: (text) => out.push(text) },
      stderr: { write: (text) => err.push(text) },
      runSelfVerification: () => Object.freeze({ restored: true, killRate: killRate() }),
      loadCorpus({ file }) {
        assert.equal(path.basename(file), "corpus.yaml");
        return Object.freeze({ corpus: Object.freeze({ version: 1, mutants: [] }), hash: HASH_A });
      },
      baseline: baselineFile
    });

    assert.equal(code, EXIT.PASS, err.join(""));
    assert.equal(JSON.parse(out.join("")).current.rate, 2 / 3);
  });
});
