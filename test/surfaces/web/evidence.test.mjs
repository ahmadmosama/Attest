import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createBundle } from "../../../src/evidence/bundle.mjs";
import { createRedactor } from "../../../src/evidence/redact.mjs";
import { createRunContext } from "../../../src/runtime/run-context.mjs";
import { createWebSurface } from "../../../src/surfaces/web/adapter.mjs";
import { captureScreenshot } from "../../../src/surfaces/web/evidence.mjs";

const RUN_ID = "20260815T044612Z-9f3a1c07";

function clock() {
  return new Date("2026-08-15T04:46:12.000Z");
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function withRuntimeTemp(prefix, fn) {
  const dir = await mkdtemp(path.join(process.cwd(), `test/surfaces/web/${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function contextFor(root, overrides = {}) {
  const bundle = await createBundle({ root, runId: RUN_ID });
  const ctx = createRunContext({
    runId: bundle.runId,
    scenarioId: overrides.scenarioId ?? "web.evidence",
    surface: "web",
    bundle,
    headed: false,
    now: clock,
    timeouts: { stepMs: 2500, evidenceMs: 2500, closeMs: 5000 }
  });

  return Object.freeze({ bundle, ctx });
}

function fullPath(bundle, ref) {
  return path.join(bundle.dir, ...ref.path.split("/"));
}

function scenarioPath(bundle, scenarioId, ...segments) {
  return path.join(bundle.dir, "scenarios", `${scenarioId}__web`, ...segments);
}

function network(entries = []) {
  return Object.freeze({
    entries() {
      return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
    },
    truncated() {
      return 0;
    },
    detach() {}
  });
}

function fakeVideo({ bytes = "video-bytes" } = {}) {
  let deleted = false;
  return Object.freeze({
    get deleted() {
      return deleted;
    },
    async saveAs(targetPath) {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, bytes);
    },
    async delete() {
      deleted = true;
    }
  });
}

function fakePage({ screenshotBytes = "png-bytes", screenshotThrows = false, video = null } = {}) {
  let closed = false;
  return Object.freeze({
    goto() {},
    async screenshot() {
      if (screenshotThrows || closed) {
        throw new Error("page closed");
      }

      return Buffer.from(screenshotBytes);
    },
    video() {
      return video;
    },
    async close() {
      closed = true;
    }
  });
}

function sessionFor(ctx, overrides = {}) {
  const videoDir = path.join(ctx.bundle.dir, "tmp", "video");
  const tracesDir = path.join(ctx.bundle.dir, "tmp", "trace");
  return Object.freeze({
    id: "fake-web-session",
    page: overrides.page ?? fakePage({ video: overrides.video ?? fakeVideo() }),
    context: {
      setOffline() {},
      async close() {}
    },
    browser: {
      async close() {}
    },
    baseUrl: new URL("http://127.0.0.1/"),
    bundle: ctx.bundle,
    redactor: overrides.redactor ?? createRedactor({ secrets: overrides.secrets ?? [] }),
    network: overrides.network ?? network(),
    videoDir,
    tracesDir,
    tempDirs: Object.freeze([videoDir, tracesDir])
  });
}

function checkpointOp(i, label = "same label") {
  return Object.freeze({ i, kind: "checkpoint", label });
}

test("checkpoint screenshots and network log are kept for a passing scenario while video is discarded", async () => {
  await withRuntimeTemp("pass-evidence", async (root) => {
    const { bundle, ctx } = await contextFor(root);
    const video = fakeVideo();
    const session = sessionFor(ctx, {
      video,
      network: network([
        {
          method: "GET",
          url: "http://127.0.0.1/?token=[REDACTED]",
          resourceType: "document",
          headers: { authorization: "[REDACTED]", cookie: "[REDACTED]" },
          status: 200,
          startedAtMs: 1,
          durationMs: 2
        }
      ])
    });
    const adapter = createWebSurface({ baseUrl: "http://127.0.0.1" });

    const first = await adapter.execute(session, checkpointOp(1));
    const second = await adapter.execute(session, checkpointOp(2));
    await adapter.close(session);

    assert.equal(first.evidence.length, 1);
    assert.equal(second.evidence.length, 1);
    assert.notEqual(first.evidence[0].path, second.evidence[0].path);
    assert.equal(first.evidence[0].path.endsWith("evidence/step-1-checkpoint-same_label.png"), true);
    assert.equal(second.evidence[0].path.endsWith("evidence/step-2-checkpoint-same_label.png"), true);
    assert.equal(await exists(fullPath(bundle, first.evidence[0])), true);
    assert.equal(await exists(fullPath(bundle, second.evidence[0])), true);

    const networkPath = scenarioPath(bundle, "web.evidence", "evidence", "network.jsonl");
    assert.equal(await exists(networkPath), true);
    const networkText = await readFile(networkPath, "utf8");
    assert.equal(networkText.includes("Authorization"), false);
    assert.equal(networkText.includes("Cookie"), false);
    assert.equal(video.deleted, true);

    const videoPath = scenarioPath(bundle, "web.evidence", "evidence", "video.webm");
    assert.equal(await exists(videoPath), false);
    for (const dir of session.tempDirs) {
      assert.equal(await exists(dir), false);
    }
    assert.equal(await exists(path.dirname(session.tempDirs[0])), false);
  });
});

test("failure evidence writes screenshot, network log, and retained video", async () => {
  await withRuntimeTemp("fail-evidence", async (root) => {
    const secret = "registered-secret-123";
    const { bundle, ctx } = await contextFor(root, { scenarioId: "web.failure" });
    const session = sessionFor(ctx, {
      secrets: [secret],
      network: network([
        {
          method: "GET",
          url: `http://127.0.0.1/?token=[REDACTED]&note=${secret}`,
          resourceType: "document",
          headers: { authorization: "[REDACTED]", cookie: "[REDACTED]" },
          status: 200,
          startedAtMs: 1,
          durationMs: 2
        }
      ])
    });
    const adapter = createWebSurface({ baseUrl: "http://127.0.0.1" });

    const screenshot = await adapter.collectEvidence(session, "failure", { bundle: ctx.bundle });
    await adapter.close(session);

    assert.notEqual(screenshot, null);
    assert.equal(screenshot.path.endsWith("evidence/failure.png"), true);
    assert.equal(await exists(fullPath(bundle, screenshot)), true);

    const scenarioDir = scenarioPath(bundle, "web.failure");
    const networkPath = path.join(scenarioDir, "evidence", "network.jsonl");
    const videoPath = path.join(scenarioDir, "evidence", "video.webm");
    assert.equal(await exists(networkPath), true);
    assert.equal(await exists(videoPath), true);

    const networkText = await readFile(networkPath, "utf8");
    assert.equal(networkText.includes(secret), false);
    assert.equal(networkText.includes("Authorization"), false);
    assert.equal(networkText.includes("Cookie"), false);
    for (const line of networkText.trim().split("\n")) {
      assert.doesNotThrow(() => JSON.parse(line));
    }

    for (const dir of session.tempDirs) {
      assert.equal(await exists(dir), false);
    }
    assert.equal(await exists(path.dirname(session.tempDirs[0])), false);
  });
});

test("screenshot capture returns null when the page is already closed", async () => {
  await withRuntimeTemp("closed-screenshot", async (root) => {
    const { ctx } = await contextFor(root, { scenarioId: "web.closed" });
    const session = sessionFor(ctx, {
      page: fakePage({ screenshotThrows: true, video: fakeVideo() })
    });

    assert.equal(await captureScreenshot(session, { name: "after-close", fullPage: true }), null);
  });
});
