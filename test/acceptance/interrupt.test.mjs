import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "node:test";

import { RUN_STATUS } from "../../src/runtime/interrupted.mjs";

/**
 * The whole point, end to end: kill a real process mid-run and look at what it
 * left behind.
 *
 * Every other test in this area asserts a unit. This one spawns Node, lets it
 * take real resources, kills it the way an operator would, and then inspects
 * the disk. It is the only test here that would catch a registry that is
 * correct in isolation and never actually reached.
 */

const CHILD_TIMEOUT_MS = 20_000;

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "attest-kill-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function waitFor(child, pattern) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`child never printed ${pattern}: ${buffer}`)), CHILD_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      if (pattern.test(buffer)) {
        clearTimeout(timer);
        resolve(buffer);
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`child exited before printing ${pattern}: ${buffer}`));
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not exit")), CHILD_TIMEOUT_MS);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function moduleUrl(relativePath) {
  // A bare absolute path is not importable on Windows: the ESM loader reads
  // `C:` as a URL scheme and refuses it. pathToFileURL is the portable form.
  return JSON.stringify(pathToFileURL(path.resolve(relativePath)).href);
}

/**
 * A child that takes the same resources a run takes, then waits.
 *
 * `process.emit("SIGINT")` rather than a real signal, for one reason that
 * matters on this host: Node synthesises SIGINT on Windows from a console
 * event, and there is no portable way for a parent to send one to a detached
 * child. Emitting it runs the identical handler chain, which is what is under
 * test. The genuinely uncatchable case (SIGKILL) is the second test below, and
 * it asserts the opposite thing.
 */
function childScript(dir) {
  return `
    import path from "node:path";
    import { writeFile, mkdir } from "node:fs/promises";
    import { cleanup } from ${moduleUrl("src/runtime/cleanup.mjs")};
    import { markRunInProgress } from ${moduleUrl("src/runtime/interrupted.mjs")};

    const runDir = ${JSON.stringify(dir.replaceAll("\\", "/"))};
    cleanup.install();

    await mkdir(path.join(runDir, "tmp", "video"), { recursive: true });
    await writeFile(path.join(runDir, "tmp", "video", "partial.webm"), "not a real video");

    const progress = markRunInProgress({
      runId: "20260818T000000Z-aaaaaaaa",
      artifactDir: runDir,
      startedAt: new Date(0).toISOString()
    });
    await progress.ready();
    progress.count(2);

    // Stands in for the browser and the emulator: something that must be torn
    // down and whose teardown leaves a trace on disk.
    cleanup.register("fake-browser", async () => {
      await writeFile(path.join(runDir, "browser-closed"), "closed");
    });
    cleanup.register("fake-tempdir", async () => {
      const { rm } = await import("node:fs/promises");
      await rm(path.join(runDir, "tmp"), { recursive: true, force: true });
    });

    console.log("ready");
    process.stdin.resume();
    process.stdin.on("data", () => process.emit("SIGINT"));
    setInterval(() => {}, 1000);
  `;
}

function spawnChild(dir) {
  return spawn(process.execPath, ["--input-type=module", "--eval", childScript(dir)], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });
}

describe("a run interrupted mid-flight", () => {
  test("SIGINT tears everything down and leaves an interrupted verdict, not silence", async (t) => {
    const dir = await tempDir(t);
    const child = spawnChild(dir);
    t.after(() => child.kill("SIGKILL"));

    await waitFor(child, /ready/u);

    // Before the marker existed, a kill here left evidence on disk and no
    // run.json at all, so the pipeline stage that reads run.json got nothing
    // and had to guess.
    const before = JSON.parse(await readFile(path.join(dir, "run.json"), "utf8"));
    assert.equal(before.status, RUN_STATUS.inProgress);

    child.stdin.write("go\n");
    const { code } = await waitForExit(child);

    // 128 + 2. A caller scripting around Attest can tell "the operator pressed
    // Ctrl-C" from "a scenario failed" without parsing anything.
    assert.equal(code, 130);

    const after = JSON.parse(await readFile(path.join(dir, "run.json"), "utf8"));
    assert.equal(after.status, RUN_STATUS.interrupted);
    assert.equal(after.interrupted, true);
    assert.equal(after.reason, "SIGINT");
    assert.equal(after.scenariosCompleted, 2);

    // Every registered disposer ran, not just the first one.
    const entries = await readdir(dir);
    assert.ok(entries.includes("browser-closed"), "the browser disposer ran");
    assert.equal(entries.includes("tmp"), false, "the scratch dir was removed");
  });

  test("SIGKILL leaves the marker behind, which is the honest outcome", async (t) => {
    const dir = await tempDir(t);
    const child = spawnChild(dir);

    await waitFor(child, /ready/u);
    child.kill("SIGKILL");
    await waitForExit(child);

    // Nothing can catch SIGKILL, and pretending otherwise would be the lie this
    // project exists to avoid. What survives is the in-progress marker, and
    // that is exactly the signal the pipeline stage needs: the run did not
    // finish, so it is not a verdict, so the stage blocks.
    const record = JSON.parse(await readFile(path.join(dir, "run.json"), "utf8"));
    assert.equal(record.status, RUN_STATUS.inProgress);
    assert.match(record.note, /did not finish/u);

    // The scratch file is still there too. That is what the next run's sweeps
    // are for: the registry handles the catchable half, the sweeps handle the
    // rest, and neither alone is enough.
    const entries = await readdir(dir);
    assert.ok(entries.includes("tmp"));
  });

  test("a second interrupt does not leave the process wedged", async (t) => {
    const dir = await tempDir(t);
    const child = spawnChild(dir);
    t.after(() => child.kill("SIGKILL"));

    await waitFor(child, /ready/u);
    child.stdin.write("go\n");
    child.stdin.write("go\n");

    const { code } = await waitForExit(child);
    assert.equal(code, 130);
  });
});
