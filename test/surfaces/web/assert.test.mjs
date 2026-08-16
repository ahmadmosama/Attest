import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { AttestError, InfraError, UnsupportedOpError } from "../../../src/errors.mjs";
import { createRedactor } from "../../../src/evidence/redact.mjs";
import { executeAssert } from "../../../src/surfaces/web/assert.mjs";
import { closeWebSession, openWebSession } from "../../../src/surfaces/web/session.mjs";
import { startStaticServer } from "../../helpers/static-server.mjs";

const FIXTURE_DIR = path.resolve("test/fixtures/web-app");
const TEST_TIMEOUT = 120000;
const STEP_TIMEOUT_MS = 1200;

function isChromeMissing(error) {
  return error instanceof InfraError && error.code === "E_ADAPTER_BROWSER_LAUNCH";
}

async function openChromeOrSkip(t, options, overrides = {}) {
  try {
    const session = await openWebSession(options);
    return Object.freeze({
      ...session,
      actionTimeoutMs: overrides.actionTimeoutMs ?? STEP_TIMEOUT_MS,
      assertTimeoutMs: overrides.assertTimeoutMs ?? STEP_TIMEOUT_MS,
      redactor: overrides.redactor ?? session.redactor
    });
  } catch (error) {
    if (isChromeMissing(error)) {
      t.skip(error.details.remediation);
      return null;
    }

    throw error;
  }
}

async function withSession(t, fn, options = {}) {
  const server = await startStaticServer({ dir: FIXTURE_DIR, routes: options.routes });
  try {
    const session = await openChromeOrSkip(t, { baseUrl: server.url }, options.session ?? {});
    if (session === null) {
      return;
    }

    try {
      await fn(session, server);
    } finally {
      await closeWebSession(session);
    }
  } finally {
    await server.close();
  }
}

test("expect_visible passes and reports convergence timing", { timeout: TEST_TIMEOUT }, async (t) => {
  await withSession(t, async (session) => {
    await session.page.goto(new URL("/", session.baseUrl).href);
    const result = await executeAssert(
      session,
      { i: 0, kind: "expect_visible", locator: { strategy: "testId", value: "product-grid" } },
      {}
    );

    assert.equal(result.ok, true);
    assert.equal(typeof result.detail.convergeMs, "number");
    assert.equal(result.detail.attempts >= 1, true);
  });
});

test("expect_visible converges when a script reveals the element later", { timeout: TEST_TIMEOUT }, async (t) => {
  const delayed = `<!doctype html>
    <p data-testid="delayed" hidden>Ready</p>
    <script>
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.querySelector("[data-testid='delayed']").hidden = false;
        });
      });
    </script>`;

  await withSession(
    t,
    async (session) => {
      await session.page.goto(new URL("/delayed", session.baseUrl).href);
      const result = await executeAssert(
        session,
        { i: 1, kind: "expect_visible", locator: { strategy: "testId", value: "delayed" } },
        {}
      );

      assert.equal(result.ok, true);
      assert.equal(result.detail.convergeMs >= 0, true);
    },
    { routes: { "/delayed": delayed } }
  );
});

test("expect_visible failure names index, locator, and convergence time", { timeout: TEST_TIMEOUT }, async (t) => {
  await withSession(
    t,
    async (session) => {
      const fastSession = Object.freeze({ ...session, assertTimeoutMs: 100 });
      await session.page.goto(new URL("/", session.baseUrl).href);

      await assert.rejects(
        executeAssert(
          fastSession,
          { i: 2, kind: "expect_visible", locator: { strategy: "testId", value: "missing" } },
          {}
        ),
        (error) =>
          error instanceof AttestError &&
          error.code === "E_WEB_ASSERTION_FAILED" &&
          error.details.i === 2 &&
          error.details.kind === "expect_visible" &&
          error.details.locator === "testId=missing" &&
          typeof error.details.convergeMs === "number"
      );
    },
    { session: { assertTimeoutMs: 100 } }
  );
});

test("expect_hidden passes for absent and present hidden elements", { timeout: TEST_TIMEOUT }, async (t) => {
  await withSession(
    t,
    async (session) => {
      await session.page.goto(new URL("/hidden", session.baseUrl).href);
      assert.equal(
        (await executeAssert(
          session,
          { i: 3, kind: "expect_hidden", locator: { strategy: "testId", value: "absent" } },
          {}
        )).ok,
        true
      );
      assert.equal(
        (await executeAssert(
          session,
          { i: 4, kind: "expect_hidden", locator: { strategy: "testId", value: "hidden" } },
          {}
        )).ok,
        true
      );
    },
    { routes: { "/hidden": '<p data-testid="hidden" hidden>Hidden</p>' } }
  );
});

test("expect_text trims and reports redacted observed values on failure", { timeout: TEST_TIMEOUT }, async (t) => {
  await withSession(
    t,
    async (session) => {
      await session.page.goto(new URL("/text", session.baseUrl).href);
      assert.equal(
        (await executeAssert(
          session,
          { i: 5, kind: "expect_text", locator: { strategy: "testId", value: "message" }, equals: "Token secret-value-123" },
          {}
        )).ok,
        true
      );

      const redactedSession = Object.freeze({
        ...session,
        assertTimeoutMs: 100,
        redactor: createRedactor({ secrets: ["secret-value-123"] })
      });

      await assert.rejects(
        executeAssert(
          redactedSession,
          { i: 6, kind: "expect_text", locator: { strategy: "testId", value: "message" }, equals: "other" },
          {}
        ),
        (error) =>
          error instanceof AttestError &&
          error.details.expected === "other" &&
          error.details.observed === "Token [REDACTED]"
      );
    },
    { routes: { "/text": '<p data-testid="message">  Token secret-value-123  </p>' } }
  );
});

test("expect_count reports expected and observed counts", { timeout: TEST_TIMEOUT }, async (t) => {
  await withSession(t, async (session) => {
    await session.page.goto(new URL("/", session.baseUrl).href);
    assert.equal(
      (await executeAssert(
        session,
        { i: 7, kind: "expect_count", locator: { strategy: "roleName", role: "listitem" }, equals: 3 },
        {}
      )).ok,
      true
    );

    const fastSession = Object.freeze({ ...session, assertTimeoutMs: 100 });
    await assert.rejects(
      executeAssert(
        fastSession,
        { i: 8, kind: "expect_count", locator: { strategy: "roleName", role: "listitem" }, equals: 2 },
        {}
      ),
      (error) =>
        error instanceof AttestError &&
        error.details.expected === 2 &&
        error.details.observed === 3
    );
  });
});

test("expect_state maps enabled disabled checked unchecked and focused", { timeout: TEST_TIMEOUT }, async (t) => {
  const statePage = `<!doctype html>
    <button data-testid="enabled">Save</button>
    <button data-testid="disabled" disabled>Disabled</button>
    <input data-testid="checked" type="checkbox" checked>
    <input data-testid="unchecked" type="checkbox">
    <input data-testid="focus-target">`;

  await withSession(
    t,
    async (session) => {
      await session.page.goto(new URL("/states", session.baseUrl).href);
      await session.page.getByTestId("focus-target").focus();

      for (const [i, value, state] of [
        [9, "enabled", "enabled"],
        [10, "disabled", "disabled"],
        [11, "checked", "checked"],
        [12, "unchecked", "unchecked"],
        [13, "focus-target", "focused"]
      ]) {
        const result = await executeAssert(
          session,
          { i, kind: "expect_state", locator: { strategy: "testId", value }, state },
          {}
        );
        assert.equal(result.ok, true);
      }
    },
    { routes: { "/states": statePage } }
  );
});

test("expect_state rejects unknown state and aborted signals promptly", { timeout: TEST_TIMEOUT }, async (t) => {
  await withSession(t, async (session) => {
    await session.page.goto(new URL("/", session.baseUrl).href);

    await assert.rejects(
      executeAssert(
        session,
        { i: 14, kind: "expect_state", locator: { strategy: "testId", value: "product-grid" }, state: "expanded" },
        {}
      ),
      (error) =>
        error instanceof UnsupportedOpError &&
        error.details.accepted.includes("focused") &&
        error.details.state === "expanded"
    );

    const controller = new AbortController();
    const reason = new Error("stop assertion");
    queueMicrotask(() => controller.abort(reason));
    const startedAt = Date.now();

    await assert.rejects(
      executeAssert(
        Object.freeze({ ...session, assertTimeoutMs: 10000 }),
        { i: 15, kind: "expect_visible", locator: { strategy: "testId", value: "never" } },
        { signal: controller.signal }
      ),
      reason
    );
    assert.equal(Date.now() - startedAt < 1000, true);
  });
});
