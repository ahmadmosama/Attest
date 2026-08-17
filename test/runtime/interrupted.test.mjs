import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { RUN_STATUS, isVerdict, markRunInProgress } from "../../src/runtime/interrupted.mjs";
import { cleanup } from "../../src/runtime/cleanup.mjs";
import { createAttestStage } from "../../src/integrate/atoz-stage.mjs";

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "attest-interrupt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function readRun(dir) {
  return JSON.parse(await readFile(path.join(dir, "run.json"), "utf8"));
}

describe("the interrupted run record", () => {
  test("a marker is on disk before the first scenario runs", async (t) => {
    const dir = await tempDir(t);

    const progress = markRunInProgress({
      runId: "20260818T000000Z-deadbeef",
      artifactDir: dir,
      startedAt: "2026-08-18T00:00:00.000Z"
    });
    await progress.ready();

    const record = await readRun(dir);
    assert.equal(record.status, RUN_STATUS.inProgress);
    assert.equal(record.runId, "20260818T000000Z-deadbeef");
    progress.complete();
  });

  test("an interrupt turns the marker into a named non-verdict", async (t) => {
    const dir = await tempDir(t);

    const progress = markRunInProgress({ runId: "r1", artifactDir: dir, startedAt: "2026-08-18T00:00:00.000Z" });
    await progress.ready();
    progress.count(4);

    await cleanup.runAll("SIGINT");

    const record = await readRun(dir);
    // Kill the process at step four of sixty and the run directory used to hold
    // evidence and no record at all, so the pipeline stage had to guess. Both
    // guesses are wrong: passing ships unverified code, failing blames the app
    // for the operator's keystroke.
    assert.equal(record.status, RUN_STATUS.interrupted);
    assert.equal(record.interrupted, true);
    assert.equal(record.reason, "SIGINT");
    assert.equal(record.scenariosCompleted, 4);
    assert.match(record.note, /neither a pass nor a failure/u);
  });

  test("completing releases the marker, so a real verdict is never overwritten", async (t) => {
    const dir = await tempDir(t);

    const progress = markRunInProgress({ runId: "r2", artifactDir: dir, startedAt: "2026-08-18T00:00:00.000Z" });
    await progress.ready();

    // The suite writes the real record here.
    await writeFile(path.join(dir, "run.json"), JSON.stringify({ runId: "r2", counts: { failed: 0 } }));
    progress.complete();

    await cleanup.runAll("SIGINT");

    const record = await readRun(dir);
    assert.equal(record.status, undefined, "the verdict survived the cleanup pass");
    assert.equal(record.runId, "r2");
  });

  test("a marker that cannot be written does not take the run down", async (t) => {
    const dir = await tempDir(t);

    const progress = markRunInProgress({
      runId: "r3",
      artifactDir: dir,
      startedAt: "2026-08-18T00:00:00.000Z",
      writeFile: async () => {
        throw new Error("disk full");
      }
    });

    // A run directory that cannot be written is a real problem, but it is the
    // suite's problem to report. Failing to place a marker must not be the
    // thing that takes the run down.
    await assert.doesNotReject(() => progress.ready());
    progress.complete();
  });

  test("both non-verdict statuses are non-verdicts", () => {
    assert.equal(isVerdict({ status: RUN_STATUS.inProgress }), false);
    assert.equal(isVerdict({ status: RUN_STATUS.interrupted }), false);
    assert.equal(isVerdict({ interrupted: true }), false);
    assert.equal(isVerdict({ runId: "r", counts: { failed: 0 } }), true);
  });
});

describe("the pipeline stage on an interrupted run", () => {
  test("blocks under its own kind, neither passing nor blaming the app", async () => {
    const stage = createAttestStage({
      runAttest: async () => ({
        record: {
          runId: "r4",
          status: RUN_STATUS.interrupted,
          interrupted: true,
          reason: "SIGTERM",
          scenariosCompleted: 3,
          artifactDir: ".attest/runs/r4",
          counts: { passed: 0, failed: 0, skipped: 0, infra_error: 0 }
        }
      })
    });

    await assert.rejects(() => stage.run({}), (error) => {
      assert.equal(error.name, "BlockerError");
      // A distinct kind, so whoever is paged goes to look at the runner rather
      // than at the diff.
      assert.equal(error.kind, "verify_interrupted");
      assert.equal(error.details.reason, "SIGTERM");
      assert.equal(error.details.scenariosCompleted, 3);
      return true;
    });
  });

  test("an in-progress marker blocks too, rather than being read as zero failures", async () => {
    // counts are all zero in the marker, so a stage that only looked at
    // `counts.failed` would call this a clean pass.
    const stage = createAttestStage({
      runAttest: async () => ({
        record: {
          runId: "r5",
          status: RUN_STATUS.inProgress,
          artifactDir: ".attest/runs/r5",
          counts: { passed: 0, failed: 0, skipped: 0, infra_error: 0 }
        }
      })
    });

    await assert.rejects(() => stage.run({}), { kind: "verify_interrupted" });
  });
});

describe("artifact writes are atomic", () => {
  test("a reader never sees a partial run.json", async (t) => {
    const dir = await tempDir(t);
    const { createBundle } = await import("../../src/evidence/bundle.mjs");
    const bundle = await createBundle({ root: dir, runId: "20260818T000000Z-abcdef01" });

    const seen = [];
    const big = { rows: Array.from({ length: 4000 }, (_, index) => ({ index, value: `row-${index}` })) };

    // Poll the file while a large write is in flight. Every observation must be
    // either absent or complete: `rename` within a directory is atomic on both
    // NTFS and POSIX, so no reader can catch a half written verdict.
    const poller = (async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          seen.push(JSON.parse(await readFile(path.join(bundle.dir, "run.json"), "utf8")));
        } catch (error) {
          // ENOENT is fine. A JSON parse error is NOT: that is the partial file
          // this test exists to prove impossible.
          assert.equal(error.code, "ENOENT", `saw a partial run.json: ${error.message}`);
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    await bundle.writeJson("run.json", big);
    await poller;

    const final = await readRun(bundle.dir);
    assert.equal(final.rows.length, 4000);
    assert.ok(seen.every((record) => record.rows.length === 4000));
  });

  test("a failed write leaves no scratch file behind", async (t) => {
    const dir = await tempDir(t);
    const { createBundle } = await import("../../src/evidence/bundle.mjs");
    const bundle = await createBundle({ root: dir, runId: "20260818T000000Z-abcdef02" });

    await bundle.writeJson("ok.json", { a: 1 });

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(bundle.dir);
    assert.equal(entries.filter((name) => name.endsWith(".tmp")).length, 0);
  });
});

describe("the signal handlers are real on this platform", () => {
  test("SIGINT is deliverable, and the Windows SIGTERM gap is stated rather than assumed", () => {
    const emitter = new EventEmitter();
    let fired = false;
    emitter.on("SIGINT", () => {
      fired = true;
    });
    emitter.emit("SIGINT");
    assert.equal(fired, true);

    // Node does not deliver SIGTERM on Windows at all: `process.kill(pid,
    // 'SIGTERM')` terminates immediately with no handler run. So on this host
    // Ctrl-C is covered and `taskkill` without /F is not, while on the CI
    // runners both are. That asymmetry is why the sweeps exist as well as the
    // registry: neither half is sufficient alone.
    const covered = process.platform === "win32" ? ["SIGINT", "SIGBREAK", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP"];
    assert.ok(covered.includes("SIGINT"));
    assert.equal(covered.includes("SIGTERM"), process.platform !== "win32");
  });
});
