import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { InfraError, UnsupportedOpError, UsageError } from "../../../src/errors.mjs";
import { assertImplementsSurfacePort } from "../../../src/surfaces/port.mjs";
import { createWebSurface } from "../../../src/surfaces/web/adapter.mjs";
import { startStaticServer } from "../../helpers/static-server.mjs";

const FIXTURE_DIR = path.resolve("test/fixtures/web-app");
const TEST_TIMEOUT = 120000;

function bundle() {
  return Object.freeze({
    dir: path.resolve("test/.tmp-web-bundle"),
    write() {
      throw new Error("bundle writes are not used in this phase");
    },
    writeJson() {
      throw new Error("bundle writes are not used in this phase");
    }
  });
}

function ctx(overrides = {}) {
  return Object.freeze({
    runId: overrides.runId ?? "run-web-adapter",
    scenarioId: overrides.scenarioId ?? "checkout.guest_purchase",
    surface: "web",
    headed: false,
    bundle: bundle(),
    now: () => 42
  });
}

function isChromeMissing(error) {
  return (
    error instanceof InfraError &&
    (error.code === "E_ADAPTER_BROWSER_LAUNCH" || error.code === "E_ADAPTER_BROWSER_MISSING")
  );
}

async function openOrSkip(t, adapter, runCtx) {
  try {
    return await adapter.open(runCtx);
  } catch (error) {
    if (isChromeMissing(error)) {
      t.skip(error.details.remediation);
      return null;
    }

    throw error;
  }
}

async function withStaticServer(fn) {
  const server = await startStaticServer({ dir: FIXTURE_DIR });
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

test("createWebSurface implements the existing surface port", () => {
  const adapter = createWebSurface({ baseUrl: "http://127.0.0.1" });

  assert.doesNotThrow(() => assertImplementsSurfacePort(adapter));
  assert.equal(Object.isFrozen(adapter), true);
});

test("describeCapabilities returns the web descriptor", () => {
  const adapter = createWebSurface({ baseUrl: "http://127.0.0.1" });
  const descriptor = adapter.describeCapabilities();

  assert.equal(descriptor.surface, "web");
  assert.equal(descriptor.has("raw_escape"), true);
});

test("preflight refuses a bare chromium channel", () => {
  const adapter = createWebSurface({ baseUrl: "http://127.0.0.1", channel: "chromium" });

  assert.throws(
    () => adapter.preflight(ctx()),
    (error) =>
      error instanceof UsageError &&
      error.code === "E_BARE_CHROMIUM_REFUSED" &&
      /WEB-01/.test(error.message)
  );
});

test("preflight refuses a non http app target", () => {
  const adapter = createWebSurface({ baseUrl: "file:///tmp/index.html" });

  assert.throws(
    () => adapter.preflight(ctx()),
    (error) => error instanceof UsageError && error.code === "E_WEB_BASE_URL_REQUIRED"
  );
});

test("preflight returns ok when chrome is resolvable", { timeout: TEST_TIMEOUT }, async (t) => {
  await withStaticServer(async (server) => {
    const adapter = createWebSurface({ baseUrl: server.url });

    try {
      assert.deepEqual(adapter.preflight(ctx()), { ok: true });
    } catch (error) {
      if (isChromeMissing(error)) {
        t.skip(error.details.remediation);
        return;
      }

      throw error;
    }
  });
});

test("open and close round trip against the local static server", { timeout: TEST_TIMEOUT }, async (t) => {
  await withStaticServer(async (server) => {
    const adapter = createWebSurface({ baseUrl: server.url });
    const runCtx = ctx();
    const session = await openOrSkip(t, adapter, runCtx);
    if (session === null) {
      return;
    }

    try {
      assert.equal(session.bundle, runCtx.bundle);
      assert.deepEqual(session.tempDirs, [session.videoDir, session.tracesDir]);
      const response = await session.page.goto(new URL("/", session.baseUrl).href);
      assert.equal(response.status(), 200);
      assert.equal(await session.page.getByTestId("product-grid").isVisible(), true);
    } finally {
      await assert.doesNotReject(adapter.close(session));
      await assert.doesNotReject(adapter.close(session));
    }
  });
});

test("execute throws an honest not implemented error", () => {
  const adapter = createWebSurface({ baseUrl: "http://127.0.0.1" });

  assert.throws(
    () => adapter.execute(Object.freeze({ id: "session" }), { kind: "click" }),
    (error) =>
      error instanceof UnsupportedOpError &&
      error.code === "E_WEB_OP_NOT_IMPLEMENTED" &&
      error.details.kind === "click"
  );
});

test("collectEvidence returns null until the evidence phase lands", () => {
  const adapter = createWebSurface({ baseUrl: "http://127.0.0.1" });

  assert.equal(adapter.collectEvidence(Object.freeze({ id: "session" }), "screenshot"), null);
});
