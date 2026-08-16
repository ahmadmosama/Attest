import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { AttestError, InfraError, UnsupportedOpError } from "../../../src/errors.mjs";
import { createWebSurface } from "../../../src/surfaces/web/adapter.mjs";
import { startStaticServer } from "../../helpers/static-server.mjs";

const FIXTURE_DIR = path.resolve("test/fixtures/web-app");
const TEST_TIMEOUT = 120000;

function ctx(overrides = {}) {
  return Object.freeze({
    runId: "run-web-execute",
    scenarioId: "web.execute",
    surface: "web",
    headed: false,
    bundle: Object.freeze({
      write() {
        throw new Error("not used");
      },
      writeJson() {
        throw new Error("not used");
      }
    }),
    timeouts: Object.freeze({ stepMs: overrides.stepMs ?? 1500 }),
    now: Date.now
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

test("web adapter executes a short plan against a rendered page", { timeout: TEST_TIMEOUT }, async (t) => {
  const server = await startStaticServer({ dir: FIXTURE_DIR });
  try {
    const adapter = createWebSurface({ baseUrl: server.url });
    const session = await openOrSkip(t, adapter, ctx());
    if (session === null) {
      return;
    }

    try {
      const ops = Object.freeze([
        { i: 0, kind: "navigate", target: { path: "/" }, ready: { strategy: "testId", value: "product-grid" } },
        { i: 1, kind: "expect_visible", locator: { strategy: "roleName", role: "link", name: "Checkout" } },
        { i: 2, kind: "click", locator: { strategy: "roleName", role: "link", name: "Checkout" } },
        { i: 3, kind: "expect_text", locator: { strategy: "roleName", role: "heading", name: "Checkout" }, equals: "Checkout" },
        { i: 4, kind: "checkpoint", label: "checkout-loaded" }
      ]);

      for (const op of ops) {
        const result = await adapter.execute(session, op, {});
        assert.equal(result.ok, true);
      }

      await assert.rejects(
        async () =>
          adapter.execute(
            session,
            {
              i: 5,
              kind: "click",
              locator: { strategy: "roleName", role: "link", name: "Checkout" },
              capabilities: ["app_lifecycle"]
            },
            {}
          ),
        (error) =>
          error instanceof UnsupportedOpError &&
          error.code === "E_UNSUPPORTED_OP" &&
          error.details.missing.includes("app_lifecycle")
      );

      await assert.rejects(
        async () => adapter.execute(session, { i: 6, kind: "unknown_web_op" }, {}),
        (error) => error instanceof UnsupportedOpError && error.code === "E_UNSUPPORTED_OP"
      );

      await assert.rejects(
        async () => adapter.execute(session, { i: 7, kind: "db_window_open" }, {}),
        (error) => error instanceof AttestError && error.code === "E_DB_OP_AT_SURFACE"
      );
    } finally {
      await adapter.close(session);
    }
  } finally {
    await server.close();
  }
});
