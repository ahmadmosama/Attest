import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, test } from "node:test";
import { convert } from "xmlbuilder2";

import { scanBundleForSecrets } from "../../src/evidence/scan.mjs";
import { startStaticServer } from "../helpers/static-server.mjs";
import { webStepTimeoutMs } from "../helpers/timeouts.mjs";

const CLI = path.join(process.cwd(), "src/cli/main.mjs");
const FIXTURE_DIR = path.resolve("test/fixtures/web-app");
const FIXTURE_BINDINGS = "test/fixtures/web-app/bindings";
const PASS_SCENARIO = "test/fixtures/web-app/scenarios/fixture_pass.attest.yaml";
const FAIL_SCENARIO = "test/fixtures/web-app/scenarios/fixture_fail.attest.yaml";
const ROOTS = [];
const TOKEN = "Bearer attest-seeded-fake-token-9f2c1a7e4b";
const RUN_TIMEOUT_MS = 300000;
const HEADER_SCAN_PATTERNS = Object.freeze([/\bAuthorization\b/, /\bCookie\b/, /\bSet-Cookie\b/]);

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

function runCli(args, { env = {}, timeout = RUN_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: process.cwd(),
      env: childEnv(env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGKILL");
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ status: null, signal: null, error, stdout, stderr });
    });
    child.on("close", (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ status, signal, error: undefined, stdout, stderr });
    });
  });
}

function cliOutput(result) {
  return `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function assertExit(result, status) {
  assert.equal(result.error, undefined, cliOutput(result));
  assert.equal(result.status, status, cliOutput(result));
}

async function onlyRunDir(artifactRoot) {
  const entries = await readdir(artifactRoot);
  assert.equal(entries.length, 1);
  return path.join(artifactRoot, entries[0]);
}

async function readRecord(artifactRoot) {
  const runDir = await onlyRunDir(artifactRoot);
  const record = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  return { runDir, record };
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(targetPath) {
  return (await stat(targetPath)).size;
}

function scenarioDir(runDir, scenarioId) {
  return path.join(runDir, "scenarios", `${scenarioId}__web`);
}

function evidencePath(runDir, ref) {
  return path.join(runDir, ...ref.path.split("/"));
}

async function evidenceFiles(runDir, scenarioId) {
  return readdir(path.join(scenarioDir(runDir, scenarioId), "evidence"));
}

// One budget covers every step, so this floor has to be generous enough for the
// fail scenario too: that one must survive steps 0..8 to time out where the test
// says it does (index 9, never-revealed-state). If step 0 times out on a slow
// host instead, the assertion fails on the step INDEX and reads like a bug in
// the evidence chain rather than a runner that ran out of patience.
const STEP_TIMEOUT_MS = String(webStepTimeoutMs(5000));

async function runFixture({ serverUrl, scenario, label, timeoutStep = STEP_TIMEOUT_MS }) {
  const root = await tempRoot(label);
  const artifacts = path.join(root, "artifacts");
  const result = await runCli([
    "run",
    "--scenarios",
    scenario,
    "--bindings",
    FIXTURE_BINDINGS,
    "--app",
    serverUrl,
    "--surface",
    "web",
    "--artifacts",
    artifacts,
    "--timeout-step",
    timeoutStep,
    "--timeout-scenario",
    "60000"
  ]);
  return { artifacts, result };
}

async function withFixtureServer(fn, routes = Object.freeze({})) {
  const server = await startStaticServer({
    dir: FIXTURE_DIR,
    routes: { "/checkout.html": checkoutHtml(), ...routes }
  });
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

function assertScenarioFiles(files, expected) {
  for (const file of expected) {
    assert.equal(files.includes(file), true, file);
  }
}

async function assertCheckpointEvidenceLinked(record, runDir, scenarioId) {
  const scenario = record.scenarios.find((entry) => entry.id === scenarioId);
  assert.notEqual(scenario, undefined);
  const checkpoints = scenario.steps.filter((step) => step.kind === "checkpoint");
  assert.equal(checkpoints.length >= 2, true);

  for (const step of checkpoints) {
    const screenshots = step.evidence.filter(
      (ref) => ref.kind === "png" && /evidence\/step-\d+-checkpoint-.*\.png$/.test(ref.path)
    );
    assert.equal(screenshots.length, 1, `checkpoint step ${step.index}`);
    assert.equal(screenshots[0].path.includes(`step-${step.index}-checkpoint-`), true);
    assert.equal(await exists(evidencePath(runDir, screenshots[0])), true);
  }
}

function failureStepFor(record, scenarioId) {
  const scenario = record.scenarios.find((entry) => entry.id === scenarioId);
  assert.notEqual(scenario, undefined);
  const step = scenario.steps.find((entry) => entry.status === "fail" || entry.status === "timed_out");
  assert.notEqual(step, undefined);
  return { scenario, step };
}

async function assertFailureDiagnosableFromRecord(record, runDir) {
  const { scenario, step } = failureStepFor(record, "fixture.checkout_fail");
  assert.equal(scenario.result, "fail");
  assert.equal(step.index, 9);
  assert.equal(step.kind, "expect_visible");
  assert.equal(step.error.code, "E_TIMEOUT");
  assert.equal(step.error.details.at, 9);
  const plan = JSON.parse(await readFile(path.join(runDir, scenario.planPath), "utf8"));
  assert.equal(plan.ops[9].locator.value, "never-revealed-state");

  const failureScreenshots = step.evidence.filter(
    (ref) => ref.kind === "png" && ref.path.endsWith("evidence/failure.png")
  );
  assert.equal(failureScreenshots.length, 1);
  assert.equal(await exists(evidencePath(runDir, failureScreenshots[0])), true);
}

function checkoutHtml({ tokenized = false } = {}) {
  const parts = ["Bearer ", "attest-seeded", "-fake-token", "-9f2c1a7e4b"];
  const tokenScript = tokenized
    ? `const token = ${JSON.stringify(parts)}.join("");
        fetch("/token-check", { headers: { "x-auth-token": token } })`
    : "Promise.resolve()";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Checkout</title>
  </head>
  <body>
    <main>
      <h1>Checkout</h1>
      <form data-testid="checkout-form">
        <label>
          Email
          <input aria-label="email-input" name="email" type="text" required>
        </label>
        <button type="submit">Place order</button>
      </form>
      <p data-testid="order-confirmation" hidden>Order placed</p>
    </main>
    <script>
      document.querySelector("[data-testid='checkout-form']").addEventListener("submit", (event) => {
        event.preventDefault();
        ${tokenScript}.finally(() => {
            document.querySelector("[data-testid='order-confirmation']").hidden = false;
          });
      });
    </script>
  </body>
</html>`;
}

async function parseNetworkLog(runDir, scenarioId) {
  const text = await readFile(path.join(scenarioDir(runDir, scenarioId), "evidence", "network.jsonl"), "utf8");
  return text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

after(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

describe("Criterion 2", () => {
  test("a failed web scenario leaves failure evidence and a passing scenario enforces retention", async () => {
    await withFixtureServer(async (server) => {
      const pass = await runFixture({
        serverUrl: server.url,
        scenario: PASS_SCENARIO,
        label: "phase02-pass"
      });
      assertExit(pass.result, 0);

      const fail = await runFixture({
        serverUrl: server.url,
        scenario: FAIL_SCENARIO,
        label: "phase02-fail"
      });
      assertExit(fail.result, 1);

      const passRun = await readRecord(pass.artifacts);
      const failRun = await readRecord(fail.artifacts);
      const passFiles = await evidenceFiles(passRun.runDir, "fixture.checkout_pass");
      const failFiles = await evidenceFiles(failRun.runDir, "fixture.checkout_fail");

      assert.equal(passRun.record.scenarios[0].result, "pass");
      assert.equal(failRun.record.scenarios[0].result, "fail");
      assertScenarioFiles(passFiles, [
        "network.jsonl",
        "step-2-checkpoint-catalog_grid.png",
        "step-7-checkpoint-checkout_ready.png"
      ]);
      assert.equal(passFiles.includes("video.webm"), false);
      assert.equal(passFiles.includes("trace.zip"), false);

      assertScenarioFiles(failFiles, [
        "failure.png",
        "network.jsonl",
        "step-2-checkpoint-catalog_grid.png",
        "step-7-checkpoint-checkout_ready.png",
        "trace.zip",
        "video.webm"
      ]);

      const failCheckpoints = failFiles.filter((file) => /^step-\d+-checkpoint-.*\.png$/.test(file));
      assert.equal(failCheckpoints.length >= 2, true);
      assert.equal(await fileSize(path.join(scenarioDir(failRun.runDir, "fixture.checkout_fail"), "evidence", "video.webm")) > 0, true);
      assert.equal(await fileSize(path.join(scenarioDir(failRun.runDir, "fixture.checkout_fail"), "evidence", "trace.zip")) > 0, true);

      await assertCheckpointEvidenceLinked(passRun.record, passRun.runDir, "fixture.checkout_pass");
      await assertCheckpointEvidenceLinked(failRun.record, failRun.runDir, "fixture.checkout_fail");
      await assertFailureDiagnosableFromRecord(failRun.record, failRun.runDir);
    });
  });
});

describe("Criterion 3", () => {
  test("report.html is self contained and identifies the failed scenario, step, and locator", async () => {
    await withFixtureServer(async (server) => {
      const fail = await runFixture({
        serverUrl: server.url,
        scenario: FAIL_SCENARIO,
        label: "phase02-report"
      });
      assertExit(fail.result, 1);
      const { runDir, record } = await readRecord(fail.artifacts);
      await assertFailureDiagnosableFromRecord(record, runDir);

      const reportPath = path.join(runDir, "report.html");
      const junitPath = path.join(runDir, "junit.xml");
      const report = await readFile(reportPath, "utf8");
      const junit = await readFile(junitPath, "utf8");

      assert.equal(await exists(path.join(runDir, "run.json")), true);
      assert.doesNotThrow(() => convert(junit, { format: "object" }));
      assert.equal(report.length > 2048, true);
      assert.match(report, /fixture\.checkout_fail/);
      assert.match(report, /E_TIMEOUT/);
      assert.match(report, /data:image\/png;base64,/);
      assert.doesNotMatch(report, /\b(?:src|href)=["']https?:\/\//i);
      assert.doesNotMatch(report, /<script\b/i);
      assert.match(report, />Step</);
      assert.match(report, />Duration</);
      assert.match(report, />9</);
      assert.match(report, /expect_visible/);
      const plan = await readFile(path.join(runDir, record.scenarios[0].planPath), "utf8");
      assert.match(plan, /never-revealed-state/);
    });
  });
});

describe("Criterion 4", () => {
  test("the full evidence bundle scans clean and the scanner catches a planted leak", async () => {
    await withFixtureServer(
      async (server) => {
        const fail = await runFixture({
          serverUrl: server.url,
          scenario: FAIL_SCENARIO,
          label: "phase02-secret",
          timeoutStep: STEP_TIMEOUT_MS
        });
        assertExit(fail.result, 1);

        const { runDir } = await readRecord(fail.artifacts);
        const networkEntries = await parseNetworkLog(runDir, "fixture.checkout_fail");
        const tokenRequest = networkEntries.find((entry) => entry.url.endsWith("/token-check"));
        assert.notEqual(tokenRequest, undefined);
        assert.equal(tokenRequest.headers["x-auth-token"], "[REDACTED]");

        const findings = await scanBundleForSecrets(runDir, {
          patterns: HEADER_SCAN_PATTERNS,
          literals: [TOKEN]
        });
        assert.deepEqual(findings, []);

        const plantedRoot = await tempRoot("phase02-planted");
        await mkdir(path.join(plantedRoot, "bundle"), { recursive: true });
        await writeFile(
          path.join(plantedRoot, "bundle", "leak.txt"),
          `Authorization: ${TOKEN}\nCookie: sid=leaked\n`
        );
        const plantedFindings = await scanBundleForSecrets(path.join(plantedRoot, "bundle"), {
          patterns: HEADER_SCAN_PATTERNS,
          literals: [TOKEN]
        });
        assert.equal(plantedFindings.length >= 3, true);
      },
      {
        "/checkout.html": checkoutHtml({ tokenized: true }),
        "/token-check": {
          status: 204,
          body: "",
          headers: { "content-type": "text/plain; charset=utf-8" }
        }
      }
    );
  });
});
