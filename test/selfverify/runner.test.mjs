import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { AttestError } from "../../src/errors.mjs";
import { loadCorpus } from "../../src/selfverify/corpus.mjs";
import { hashFixtureTree, runSelfVerification } from "../../src/selfverify/runner.mjs";
import {
  skipUnlessPostgres,
  withPostgresSlotLock
} from "../helpers/postgres.mjs";

const HASH = "f".repeat(64);

function ruleset() {
  return Object.freeze({
    path: null,
    hash: HASH,
    ruleset: Object.freeze({ version: 1, rules: Object.freeze([]) })
  });
}

function mutant(fields = {}) {
  return Object.freeze({
    id: "sample_mutant",
    kind: "wrong_value",
    file: "fixtures/self-verify/app/app.mjs",
    find: "return clean;",
    replace: "return dirty;",
    seeds: "The sample behavior changes.",
    caught_by: "DELTA-01",
    ...fields
  });
}

function corpus(mutants = [mutant()]) {
  return Object.freeze({ version: 1, mutants: Object.freeze(mutants) });
}

async function withRoot(prefix, run) {
  const root = await mkdtemp(path.join(process.cwd(), `test/selfverify/${prefix}-`));
  try {
    await mkdir(path.join(root, "fixtures", "self-verify", "app"), { recursive: true });
    await writeFile(path.join(root, "fixtures", "self-verify", "app", "app.mjs"), "return clean;", "utf8");
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function io(root, runFixtureSuite) {
  return Object.freeze({
    cwd: root,
    loadRuleset: () => ruleset(),
    runFixtureSuite
  });
}

function passRun() {
  return Object.freeze({ exitCode: 0, reason: "passed", text: "" });
}

test("runSelfVerification aborts when the baseline is red", async () => {
  await withRoot("runner-baseline", async (root) => {
    await assert.rejects(
      () =>
        runSelfVerification({
          corpus: corpus(),
          io: io(root, () => Object.freeze({ exitCode: 1, reason: "E_DELTA_MISSING_MUTATION", text: "" }))
        }),
      { code: "E_SELFVERIFY_BASELINE_FAILED" }
    );
  });
});

test("runSelfVerification scores infrastructure failures as errors", async () => {
  await withRoot("runner-infra", async (root) => {
    let calls = 0;
    const result = await runSelfVerification({
      corpus: corpus(),
      io: io(root, () => {
        calls += 1;
        return calls === 1
          ? passRun()
          : Object.freeze({ exitCode: 2, reason: "E_DB_UNREACHABLE", text: "" });
      })
    });

    assert.equal(result.results[0].outcome, "error");
    assert.equal(result.killRate.counts.errored, 1);
    assert.equal(result.killRate.counts.killed, 0);
  });
});

test("runSelfVerification restores a mutant when the run throws", async () => {
  await withRoot("runner-restore", async (root) => {
    let calls = 0;
    const before = await hashFixtureTree({ root });
    const result = await runSelfVerification({
      corpus: corpus(),
      io: io(root, () => {
        calls += 1;
        if (calls === 1) {
          return passRun();
        }
        throw new Error("forced run failure");
      })
    });
    const after = await hashFixtureTree({ root });
    const text = await readFile(path.join(root, "fixtures", "self-verify", "app", "app.mjs"), "utf8");

    assert.equal(result.restored, true);
    assert.equal(before, after);
    assert.equal(text, "return clean;");
    assert.equal(result.results[0].outcome, "error");
  });
});

test("runSelfVerification refuses a fixture with an applied mutant", async () => {
  await withRoot("runner-dirty", async (root) => {
    await writeFile(path.join(root, "fixtures", "self-verify", "app", "app.mjs"), "return dirty;", "utf8");

    await assert.rejects(
      () => runSelfVerification({ corpus: corpus(), io: io(root, passRun) }),
      { code: "E_SELFVERIFY_FIXTURE_DIRTY" }
    );
  });
});

test("runSelfVerification requires the orphan failure to be attributable", async () => {
  await withRoot("runner-orphan", async (root) => {
    const orphan = mutant({
      id: "delete_extra_orphan_audit",
      kind: "extra_write",
      caught_by: "DELTA-03"
    });
    let calls = 0;
    const result = await runSelfVerification({
      corpus: corpus([orphan]),
      io: io(root, () => {
        calls += 1;
        return calls === 1
          ? passRun()
          : Object.freeze({
              exitCode: 1,
              reason: "E_DELTA_UNEXPLAINED",
              text: "E_DELTA_UNEXPLAINED audit_deleted_order_orphan order_orphan"
            });
      })
    });

    assert.equal(result.results[0].outcome, "killed");
    assert.match(result.results[0].reason, /audit_deleted_order_orphan/u);
  });
});

test("self verification corpus runs against live Postgres", { timeout: 600000 }, async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  await withPostgresSlotLock(live, async () => {
    const loaded = await loadCorpus({ file: path.join(process.cwd(), "fixtures/self-verify/corpus.yaml") });
    const result = await runSelfVerification({
      corpus: loaded,
      target: live.target,
      io: { env: process.env }
    });
    const byId = new Map(result.results.map((entry) => [entry.mutantId, entry]));

    assert.equal(result.baseline.outcome, "passed");
    assert.equal(result.restored, true);
    assert.equal(result.killRate.counts.total, 11);
    assert.equal(result.killRate.counts.errored, 0);
    assert.equal(byId.get("delete_extra_orphan_audit").outcome, "killed");
    assert.match(byId.get("delete_extra_orphan_audit").reason, /audit_deleted_order_orphan/u);
    assert.equal(byId.get("survivor_create_audit_detail").outcome, "survived");

    // The reference case from the roadmap: deleting a customer while leaving
    // their orders and order items behind. Criterion 1 requires not merely that
    // the run fails, but that the failure names the exact orphaned rows, so
    // assert the row keys rather than only the outcome.
    const orphan = byId.get("delete_orphan_child_rows");
    assert.equal(orphan.outcome, "killed");
    assert.match(orphan.reason, /E_DELTA_MISSING_MUTATION/u);
    assert.match(orphan.reason, /order_items/u);
    assert.match(orphan.reason, /"order_id":"order_100"/u);
    assert.match(orphan.reason, /"order_id":"order_101"/u);
    assert.match(orphan.reason, /"id":"order_100"/u);
    assert.match(orphan.reason, /"id":"order_101"/u);
  });
});

test("runSelfVerification reports apply failures as errors", async () => {
  await withRoot("runner-apply", async (root) => {
    const result = await runSelfVerification({
      corpus: corpus(),
      io: {
        ...io(root, passRun),
        applyMutant() {
          throw new AttestError("E_MUTANT_NOT_APPLICABLE", "No match");
        }
      }
    });

    assert.equal(result.results[0].outcome, "error");
    assert.equal(result.results[0].reason, "E_MUTANT_NOT_APPLICABLE");
  });
});
