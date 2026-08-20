import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";

import { webStepTimeoutMs } from "../helpers/timeouts.mjs";

const CLI = path.join(process.cwd(), "src/cli/main.mjs");
const LIVE_URL = "https://candor-two-theta.vercel.app";
const LIVE_TITLE = "Candor. Professional reputation, verified.";
const ROOTS = [];

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

function runCli(args, { env = {}, timeout = 300000 } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: childEnv(env),
    timeout
  });
}

function cliOutput(result) {
  return `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

async function onlyRunDir(artifactRoot) {
  const entries = await readdir(artifactRoot);
  assert.equal(entries.length, 1);
  return path.join(artifactRoot, entries[0]);
}

async function readRecord(artifactRoot) {
  const runDir = await onlyRunDir(artifactRoot);
  return {
    runDir,
    record: JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"))
  };
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function reachability() {
  try {
    const response = await fetch(LIVE_URL, {
      method: "GET",
      // A failed probe SKIPS this test rather than failing it, so a budget too
      // tight to survive a cold Vercel lambda does not report a slow target: it
      // reports a green suite that quietly stopped checking the live app at all.
      // That is the failure mode this project exists to refuse, so the probe is
      // given room to be slow, and only a genuinely unreachable target skips.
      // It doubles as the warm-up for the run that follows.
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      return { ok: false, reason: `live target returned HTTP ${response.status}` };
    }

    const body = await response.text();
    assert.match(body, new RegExp(`<title>\\s*${LIVE_TITLE.replaceAll(".", "\\.")}\\s*</title>`));
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

after(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

test("criterion 1 drives the live Candor web app through the chrome Playwright adapter", async (t) => {
  if (process.env.ATTEST_SKIP_LIVE === "1") {
    t.skip("live checks disabled by ATTEST_SKIP_LIVE");
    return;
  }

  const reachable = await reachability();
  if (!reachable.ok) {
    t.skip(`live target unreachable: ${reachable.reason}`);
    return;
  }

  const root = await tempRoot("phase02-live");
  const artifacts = path.join(root, "artifacts");
  const result = runCli([
    "run",
    "--scenarios",
    "test/fixtures/live/scenarios/candor_home.attest.yaml",
    "--bindings",
    "test/fixtures/live/bindings",
    "--app",
    LIVE_URL,
    "--surface",
    "web",
    "--artifacts",
    artifacts,
    "--timeout-step",
    String(webStepTimeoutMs(10000)),
    // 60s was not enough on 2026-08-20: the scenario spent 91s and was killed
    // mid-run on windows while ubuntu passed the same commit. The target is a
    // Vercel deploy, so a cold lambda plus a slow runner is a normal worst case
    // rather than an exotic one, and this budget has to cover both.
    "--timeout-scenario",
    "120000"
  ]);

  assert.equal(result.error, undefined, cliOutput(result));
  assert.equal(result.status, 0, cliOutput(result));
  assert.match(result.stdout, /web: real \(chrome\)/);
  assert.doesNotMatch(result.stdout, /surface adapter: fake/i);

  const { runDir, record } = await readRecord(artifacts);
  const scenario = record.scenarios.find((entry) => entry.id === "candor.home");
  assert.notEqual(scenario, undefined);
  assert.equal(scenario.result, "pass");
  assert.equal(scenario.surface, "web");
  assert.deepEqual(record.filters.surfaces, ["web"]);
  assert.doesNotMatch(JSON.stringify(record), /\bfake\b/i);

  const allEvidence = scenario.steps.flatMap((step) => step.evidence ?? []);
  const checkpoint = allEvidence.find((ref) => ref.kind === "png" && ref.path.includes("checkpoint"));

  // Diagnostic, because a bare `notEqual(undefined)` here says only "no
  // checkpoint screenshot" and this assertion has failed on the Windows CI
  // runner while passing on Linux and on a local Windows machine. Evidence
  // capture swallows its own errors by design (it must never replace the real
  // scenario result), so an empty list and a failed capture look identical from
  // here. Printing what WAS captured turns the next occurrence into a fact.
  assert.notEqual(
    checkpoint,
    undefined,
    `no checkpoint png in evidence. captured: ${JSON.stringify(
      allEvidence.map((ref) => `${ref.kind}:${ref.path}`)
    )}, steps: ${scenario.steps.length}`
  );
  const screenshotPath = path.join(runDir, ...checkpoint.path.split("/"));
  assert.equal(await exists(screenshotPath), true);
  assert.equal((await stat(screenshotPath)).size > 2000, true);
});
