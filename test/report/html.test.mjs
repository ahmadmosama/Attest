import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runCommand } from "../../src/cli/commands/run.mjs";
import { createRunRecord } from "../../src/report/run-record.mjs";
import { renderHtmlReport } from "../../src/report/html.mjs";
import { escapeHtml, inlineArtifact, INLINE_BYTE_LIMIT } from "../../src/report/inline.mjs";

const HASH = "c".repeat(64);
const CLI = path.join(process.cwd(), "src/cli/main.mjs");
const PNG_FIXTURE = path.join(process.cwd(), "test/fixtures/report/screenshot.png");

function artifact(relPath, overrides = {}) {
  return Object.freeze({
    kind: "screenshot",
    path: relPath,
    bytes: 68,
    sha256: HASH,
    ...overrides
  });
}

function step(index, overrides = {}) {
  return Object.freeze({
    index,
    kind: "expect_text",
    status: "pass",
    durationMs: 11,
    error: null,
    evidence: [],
    ...overrides
  });
}

function error(overrides = {}) {
  return Object.freeze({
    code: "E_EXPECT_TEXT",
    message: "Expected page text was not found",
    details: { capturedText: "<section>Checkout failed</section>" },
    ...overrides
  });
}

function scenario(overrides = {}) {
  return {
    id: "checkout.guest_purchase",
    surface: "web",
    result: "pass",
    durationMs: 25,
    requirements: ["RUN-04", "SCEN-05"],
    planHash: HASH,
    planPath: "scenarios/checkout.guest_purchase__web/plan.json",
    rawOpUses: 0,
    skipped: null,
    error: null,
    steps: [step(0, { kind: "open" })],
    ...overrides
  };
}

function record(overrides = {}) {
  return createRunRecord({
    runId: "20260815T044612Z-9f3a1c07",
    startedAt: "2026-08-15T04:46:12.000Z",
    finishedAt: "2026-08-15T04:46:13.000Z",
    durationMs: 1000,
    attestVersion: "0.1.0",
    node: { version: "v24.13.0", platform: "win32" },
    filters: { ids: [], tags: [], surfaces: ["web"], headed: false, dryRun: false },
    artifactDir: "artifacts/20260815T044612Z-9f3a1c07",
    hashes: { bindings: { web: HASH }, ruleset: "d".repeat(64) },
    telemetry: { timeouts: 0, retries: 0, convergeMs: [] },
    scenarios: [scenario()],
    ...overrides
  });
}

async function withTempRun(fn) {
  const root = await mkdtemp(path.join(process.cwd(), "test/report/html-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeScreenshot(root, relPath = "scenarios/checkout.guest_purchase__web/evidence/failure.png") {
  const target = path.join(root, ...relPath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(PNG_FIXTURE, target);
  return relPath;
}

function assertNoExternalReferences(html) {
  assert.doesNotMatch(html, /\bhttps?:/i);
  assert.doesNotMatch(html, /<script\s+[^>]*\ssrc\s*=/i);
  assert.doesNotMatch(html, /<link\s+[^>]*rel=["']?stylesheet/i);

  for (const match of html.matchAll(/\s(src|href)=("([^"]*)"|'([^']*)')/gi)) {
    const name = match[1].toLowerCase();
    const value = match[3] ?? match[4] ?? "";
    assert.doesNotMatch(value, /^(?:https?:|\/\/|[A-Za-z]:|\/)/i);
    if (name === "src") {
      assert.match(value, /^data:image\//);
    }
  }
}

function childEnv() {
  const env = Object.fromEntries(
    ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]
      .map((key) => [key, process.env[key]])
      .filter(([, value]) => value !== undefined)
  );
  return { ...env, ATTEST_SURFACE_ADAPTER: "fake" };
}

test("escapeHtml escapes the five HTML entities and nullish values", () => {
  assert.equal(escapeHtml("<img src=x onerror=alert(1)>").includes("<"), false);
  assert.equal(escapeHtml("<img src=x onerror=alert(1)>").includes(">"), false);
  assert.equal(escapeHtml("&<>\"'"), "&amp;&lt;&gt;&quot;&#39;");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(null), "");
});

test("inlineArtifact inlines small PNG files as data URIs", async () => {
  await withTempRun(async (root) => {
    const relPath = await writeScreenshot(root);
    const result = await inlineArtifact({ artifactDir: root, ref: artifact(relPath) });

    assert.equal(result.mode, "inline");
    assert.match(result.src, /^data:image\/png;base64,/);
  });
});

test("inlineArtifact links large or non image files with only relative hrefs", async () => {
  await withTempRun(async (root) => {
    const relPath = "large/failure.png";
    const target = path.join(root, "large", "failure.png");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, new Uint8Array(INLINE_BYTE_LIMIT + 1));

    const result = await inlineArtifact({ artifactDir: root, ref: artifact(relPath) });

    assert.deepEqual(result, { mode: "link", href: relPath });
    assert.equal(path.isAbsolute(result.href), false);
  });
});

test("inlineArtifact returns missing for absent files and path escape attempts", async () => {
  await withTempRun(async (root) => {
    assert.deepEqual(
      await inlineArtifact({ artifactDir: root, ref: artifact("missing.png") }),
      { mode: "missing" }
    );
    assert.deepEqual(
      await inlineArtifact({ artifactDir: root, ref: artifact("../outside.png") }),
      { mode: "missing" }
    );
    assert.deepEqual(
      await inlineArtifact({ artifactDir: root, ref: artifact("https://example.test/a.png") }),
      { mode: "missing" }
    );
  });
});

test("renderHtmlReport returns a complete self contained document", async () => {
  await withTempRun(async (root) => {
    const screenshotPath = await writeScreenshot(root);
    const failed = scenario({
      id: "checkout.failure",
      result: "fail",
      error: null,
      steps: [
        step(0, { kind: "open", durationMs: 5 }),
        step(2, {
          status: "fail",
          durationMs: 17,
          error: error(),
          evidence: [artifact(screenshotPath)]
        }),
        step(1, { kind: "tap", durationMs: 9 })
      ]
    });
    const passed = scenario({ id: "catalog.browse", durationMs: 10 });
    const runRecord = record({
      artifactDir: root,
      scenarios: [failed, passed]
    });

    const html = await renderHtmlReport(runRecord, { artifactDir: root });

    assert.equal(html.startsWith("<!doctype html>"), true);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /Total 2/);
    assert.match(html, /Passed 1/);
    assert.match(html, /Failed 1/);
    assert.match(html, /Infra error 0/);
    assert.match(html, /Skipped 0/);
    assert.match(html, /Quarantined 0/);
    assert.match(html, /checkout\.failure/);
    assert.match(html, /catalog\.browse/);
    assert.match(html, /RUN-04, SCEN-05/);
    assert.match(html, /expect_text/);
    assert.match(html, /step-problem/);
    assert.match(html, /E_EXPECT_TEXT/);
    assert.match(html, /Expected page text was not found/);
    assert.match(html, /&lt;section&gt;Checkout failed&lt;\/section&gt;/);
    assert.match(html, /data:image\/png;base64,/);
    assert.match(html, /20260815T044612Z-9f3a1c07/);
    assert.match(html, new RegExp(HASH));
    assert.match(html, /v24\.13\.0/);
    assert.match(html, /Exit code/);
    assert.match(html, /Database delta/);
    assertNoExternalReferences(html);

    const step0 = html.indexOf("<td>0</td>");
    const step1 = html.indexOf("<td>1</td>");
    const step2 = html.indexOf("<td>2</td>");
    assert.equal(step0 < step1 && step1 < step2, true);
  });
});

test("renderHtmlReport renders hostile input as text instead of markup", async () => {
  await withTempRun(async (root) => {
    const runRecord = record({
      artifactDir: root,
      scenarios: [
        scenario({
          id: "<script>alert(1)</script>",
          result: "fail",
          steps: [
            step(0, {
              status: "fail",
              error: error({ message: "<script>alert(2)</script>" })
            })
          ]
        })
      ]
    });

    const html = await renderHtmlReport(runRecord, { artifactDir: root });

    assert.doesNotMatch(html, /<script/i);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  });
});

test("renderHtmlReport handles a record with zero scenarios", async () => {
  const html = await renderHtmlReport(record({ scenarios: [] }));

  assert.equal(html.startsWith("<!doctype html>"), true);
  assert.match(html, /No scenarios recorded/);
  assertNoExternalReferences(html);
});

test("runCommand writes report.html for dry runs and lists it in the manifest", async () => {
  await withTempRun(async (root) => {
    const out = [];
    const err = [];
    const code = await runCommand(
      {
        dryRun: true,
        scenariosGlob: ["examples/shopdemo/scenarios/browse_catalog.attest.yaml"],
        bindingsDir: "examples/shopdemo/bindings",
        app: "https://example.test",
        surfaces: ["web"],
        artifactRoot: path.join(root, "artifacts")
      },
      {
        cwd: process.cwd(),
        env: { ATTEST_SURFACE_ADAPTER: "fake" },
        stdout: { write: (text) => out.push(text) },
        stderr: { write: (text) => err.push(text) },
        now: () => new Date("2026-08-15T04:46:12.000Z")
      }
    );

    assert.equal(code, 0, err.join(""));
    const stdout = out.join("");
    assert.match(stdout, /HTML report: .+report\.html/);

    const [runDir] = await readdir(path.join(root, "artifacts"));
    const runPath = path.join(root, "artifacts", runDir);
    const html = await readFile(path.join(runPath, "report.html"), "utf8");
    const manifest = JSON.parse(await readFile(path.join(runPath, "manifest.json"), "utf8"));

    assert.equal(html.length > 0, true);
    assert.match(html, /catalog\.browse/);
    assert(manifest.some((entry) => entry.path === "report.html"));
    assertNoExternalReferences(html);
  });
});

test("child CLI in fake mode writes a self contained report for the example suite", async () => {
  await withTempRun(async (root) => {
    const artifacts = path.join(root, "artifacts");
    const result = spawnSync(process.execPath, [
      CLI,
      "run",
      "--scenarios",
      "examples/shopdemo/scenarios/*.attest.yaml",
      "--bindings",
      "examples/shopdemo/bindings",
      "--app",
      "https://example.test",
      "--surface",
      "web",
      "--artifacts",
      artifacts
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnv()
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /HTML report: .+report\.html/);

    const [runDir] = await readdir(artifacts);
    const html = await readFile(path.join(artifacts, runDir, "report.html"), "utf8");

    assert.equal(html.length > 0, true);
    assert.match(html, /catalog\.browse/);
    assert.match(html, /checkout\.guest_purchase/);
    assertNoExternalReferences(html);
  });
});
