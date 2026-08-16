import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createBundle } from "../../../src/evidence/bundle.mjs";
import { createRedactor } from "../../../src/evidence/redact.mjs";
import { readZipEntries, writeZip } from "../../../src/evidence/zip.mjs";
import { createRunContext } from "../../../src/runtime/run-context.mjs";
import { createWebSurface } from "../../../src/surfaces/web/adapter.mjs";
import { discardTrace, redactTraceBuffer, retainTrace } from "../../../src/surfaces/web/trace.mjs";

const RUN_ID = "20260815T044612Z-9f3a1c07";
const SEEDED_TOKEN = "Bearer eyJabcdefgh.ijklmnopqr.stuvwxyz12";

async function withRuntimeTemp(prefix, fn) {
  const dir = await mkdtemp(path.join(process.cwd(), `test/surfaces/web/${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function contextFor(root, scenarioId = "web.trace") {
  const bundle = await createBundle({ root, runId: RUN_ID });
  const ctx = createRunContext({
    runId: bundle.runId,
    scenarioId,
    surface: "web",
    bundle,
    headed: false,
    now: () => new Date("2026-08-15T04:46:12.000Z"),
    timeouts: { stepMs: 2500, evidenceMs: 2500, closeMs: 5000 }
  });

  return Object.freeze({ bundle, ctx });
}

function traceZip({ token = SEEDED_TOKEN, clean = false } = {}) {
  return writeZip([
    {
      name: "trace.trace",
      data: Buffer.from(clean ? "action clean\n" : `request Authorization: ${token}\n`)
    },
    {
      name: "resources/image.png",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
    },
    {
      name: "network/0.network",
      data: Buffer.from(clean ? "{\"headers\":{\"accept\":\"text/html\"}}\n" : "{\"headers\":{\"Cookie\":\"sid=abc\"}}\n")
    }
  ]);
}

function fakeTracing({ zip = traceZip(), throwOnStop = false, stopRecorder = null } = {}) {
  return Object.freeze({
    async stop(options = {}) {
      stopRecorder?.(options);
      if (throwOnStop) {
        throw new Error("trace stop failed with Bearer secret-value-123456");
      }

      if (typeof options.path === "string") {
        await writeFile(options.path, zip);
      }
    }
  });
}

function network() {
  return Object.freeze({
    entries() {
      return Object.freeze([]);
    },
    truncated() {
      return 0;
    },
    detach() {}
  });
}

function fakeVideo() {
  return Object.freeze({
    async saveAs(targetPath) {
      await writeFile(targetPath, "video");
    },
    async delete() {}
  });
}

function fakePage() {
  return Object.freeze({
    goto() {},
    async screenshot() {
      return Buffer.from("png");
    },
    video() {
      return fakeVideo();
    },
    async close() {}
  });
}

function sessionFor(ctx, overrides = {}) {
  const videoDir = path.join(ctx.bundle.dir, "tmp", "video");
  const tracesDir = path.join(ctx.bundle.dir, "tmp", "trace");

  return Object.freeze({
    id: "fake-web-session",
    page: overrides.page ?? fakePage(),
    context: {
      tracing: overrides.tracing ?? fakeTracing(),
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

function scenarioPath(bundle, scenarioId, ...segments) {
  return path.join(bundle.dir, "scenarios", `${scenarioId}__web`, ...segments);
}

function inflatedText(zipBuffer) {
  return readZipEntries(zipBuffer)
    .map((entry) => entry.data.toString("utf8"))
    .join("\n");
}

test("redactTraceBuffer removes a planted bearer token after inflation and keeps the zip readable", () => {
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  const original = writeZip([
    { name: "trace.trace", data: `Authorization: ${SEEDED_TOKEN}\n` },
    { name: "resources/image.png", data: binary }
  ]);

  const redacted = redactTraceBuffer(original, createRedactor({ secrets: [SEEDED_TOKEN] }));
  const entries = readZipEntries(redacted);
  const text = entries[0].data.toString("utf8");

  assert.equal(text.includes(SEEDED_TOKEN), false);
  assert.equal(text.includes("Authorization"), false);
  assert.equal(entries[1].name, "resources/image.png");
  assert.deepEqual(entries[1].data, binary);
});

test("redactTraceBuffer returns the original buffer when no text entry changes", () => {
  const original = traceZip({ clean: true });

  assert.equal(redactTraceBuffer(original, createRedactor()), original);
});

test("retainTrace writes evidence/trace.zip and removes the temp trace directory", async () => {
  await withRuntimeTemp("trace-retain", async (root) => {
    const { bundle, ctx } = await contextFor(root);
    const session = sessionFor(ctx, { secrets: [SEEDED_TOKEN] });

    const result = await retainTrace(session);
    const tracePath = scenarioPath(bundle, "web.trace", "evidence", "trace.zip");
    const retained = await readFile(tracePath);

    assert.equal(result.ok, true);
    assert.equal(await exists(tracePath), true);
    assert.equal(await exists(session.tracesDir), false);
    assert.equal(inflatedText(retained).includes(SEEDED_TOKEN), false);
    assert.equal(inflatedText(retained).includes("Authorization"), false);
    assert.equal(inflatedText(retained).includes("Cookie"), false);
  });
});

test("discardTrace stops without a path and leaves no trace artifact", async () => {
  await withRuntimeTemp("trace-discard", async (root) => {
    const { bundle, ctx } = await contextFor(root, "web.pass");
    const stopCalls = [];
    const session = sessionFor(ctx, {
      tracing: fakeTracing({
        stopRecorder(options) {
          stopCalls.push(options);
        }
      })
    });

    const result = await discardTrace(session);

    assert.equal(result.ok, true);
    assert.deepEqual(stopCalls, [{}]);
    assert.equal(await exists(scenarioPath(bundle, "web.pass", "evidence", "trace.zip")), false);
    assert.equal(await exists(session.tracesDir), false);
  });
});

test("adapter close retains traces only for failed sessions", async () => {
  await withRuntimeTemp("trace-adapter", async (root) => {
    const { bundle, ctx } = await contextFor(root, "web.failed");
    const adapter = createWebSurface({ baseUrl: "http://127.0.0.1" });
    const failed = sessionFor(ctx, { secrets: [SEEDED_TOKEN] });

    await adapter.collectEvidence(failed, "failure");
    await adapter.close(failed);

    const tracePath = scenarioPath(bundle, "web.failed", "evidence", "trace.zip");
    assert.equal(await exists(tracePath), true);
    assert.equal(inflatedText(await readFile(tracePath)).includes(SEEDED_TOKEN), false);
  });

  await withRuntimeTemp("trace-adapter-pass", async (root) => {
    const { bundle, ctx } = await contextFor(root, "web.passed");
    const adapter = createWebSurface({ baseUrl: "http://127.0.0.1" });
    const passed = sessionFor(ctx);

    await adapter.close(passed);

    assert.equal(await exists(scenarioPath(bundle, "web.passed", "evidence", "trace.zip")), false);
    assert.equal(await exists(passed.tracesDir), false);
  });
});

test("trace retention failures record a reason and never throw", async () => {
  await withRuntimeTemp("trace-fail", async (root) => {
    const { bundle, ctx } = await contextFor(root, "web.trace-failure");
    const session = sessionFor(ctx, {
      tracing: fakeTracing({ throwOnStop: true }),
      secrets: ["secret-value-123456"]
    });

    const result = await retainTrace(session);
    const errorPath = scenarioPath(bundle, "web.trace-failure", "evidence", "trace-error.json");
    const errorText = await readFile(errorPath, "utf8");

    assert.equal(result.ok, false);
    assert.equal(await exists(scenarioPath(bundle, "web.trace-failure", "evidence", "trace.zip")), false);
    assert.equal(errorText.includes("secret-value-123456"), false);
  });
});
