import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { TimeoutError, withTimeout } from "../../src/runtime/timeout.mjs";

test("withTimeout rejects a hung call at a bounded step deadline", async () => {
  const started = Date.now();

  await assert.rejects(
    () => withTimeout(() => new Promise(() => {}), { ms: 50, kind: "step", at: 3 }),
    (error) => {
      assert(error instanceof TimeoutError);
      assert.equal(error.code, "E_TIMEOUT");
      assert.equal(error.details.kind, "step");
      assert.equal(error.details.ms, 50);
      assert.equal(error.details.at, 3);
      return true;
    }
  );

  assert(Date.now() - started < 2000);
});

test("withTimeout aborts the signal received by the caller", async () => {
  let cleanupRan = false;

  await assert.rejects(
    () =>
      withTimeout(
        ({ signal }) =>
          new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                cleanupRan = true;
                resolve("cleaned");
              },
              { once: true }
            );
          }),
        { ms: 20, kind: "step", at: 1 }
      ),
    TimeoutError
  );

  assert.equal(cleanupRan, true);
});

test("parent signal aborts a child timeout before the child deadline", async () => {
  const started = Date.now();

  await assert.rejects(
    () =>
      withTimeout(
        ({ signal }) =>
          withTimeout(() => new Promise(() => {}), {
            ms: 1000,
            kind: "step",
            at: 9,
            parentSignal: signal
          }),
        { ms: 25, kind: "scenario" }
      ),
    (error) => error instanceof TimeoutError && error.details.kind === "scenario"
  );

  assert(Date.now() - started < 500);
});

test("timeout source does not use a setTimeout based race", async () => {
  const source = await readFile("src/runtime/timeout.mjs", "utf8");

  assert.equal(source.includes("setTimeout"), false);
  assert.equal(source.includes("AbortSignal.timeout"), true);
  assert.equal(source.includes("AbortSignal.any"), true);
});

test("a timed out child process exits without a lingering handle", async () => {
  const script = `
    import test from "node:test";
    import { withTimeout } from "../../../src/runtime/timeout.mjs";
    test("timeout exits", async () => {
      await withTimeout(() => new Promise(() => {}), { ms: 20, kind: "step", at: 0 }).catch(() => {});
    });
  `;
  const dir = await mkdtemp(path.join(process.cwd(), "test/runtime/timeout-child-"));
  const filePath = path.join(dir, "child.test.mjs");

  await writeFile(filePath, script);
  try {
    const result = spawnSync(process.execPath, ["--test", filePath], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 2000
    });

    assert.equal(result.status, 0);
    assert.equal(result.error, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
