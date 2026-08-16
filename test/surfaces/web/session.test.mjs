import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { InfraError, UsageError } from "../../../src/errors.mjs";
import { closeWebSession, openWebSession } from "../../../src/surfaces/web/session.mjs";
import { startStaticServer } from "../../helpers/static-server.mjs";

const FIXTURE_DIR = path.resolve("test/fixtures/web-app");
const TEST_TIMEOUT = 120000;

function isChromeMissing(error) {
  return error instanceof InfraError && error.code === "E_ADAPTER_BROWSER_LAUNCH";
}

async function openChromeOrSkip(t, options) {
  try {
    return await openWebSession(options);
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

test(
  "openWebSession launches on the chrome channel and returns the session handles",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    await withStaticServer(async (server) => {
      const session = await openChromeOrSkip(t, {
        baseUrl: server.url,
        channel: "chrome",
        headed: false
      });
      if (session === null) {
        return;
      }

      try {
        assert.equal(session.channel, "chrome");
        assert.equal(session.testIdAttribute, "data-testid");
        assert.equal(session.baseUrl.href, `${server.url}/`);
        assert.equal(typeof session.browser.close, "function");
        assert.equal(typeof session.context.newPage, "function");
        assert.equal(typeof session.page.goto, "function");
        assert.equal(session.closed, false);
      } finally {
        await closeWebSession(session);
      }
    });
  }
);

test("openWebSession refuses explicit chromium before launch", async () => {
  await assert.rejects(
    openWebSession({ baseUrl: "http://127.0.0.1", channel: "chromium" }),
    (error) =>
      error instanceof UsageError &&
      error.code === "E_BARE_CHROMIUM_REFUSED" &&
      /WEB-01/.test(error.message)
  );
});

test("openWebSession refuses empty, null, and non chrome channels", async () => {
  await assert.rejects(
    openWebSession({ baseUrl: "http://127.0.0.1", channel: "" }),
    (error) => error instanceof UsageError && error.code === "E_BARE_CHROMIUM_REFUSED"
  );
  await assert.rejects(
    openWebSession({ baseUrl: "http://127.0.0.1", channel: null }),
    (error) => error instanceof UsageError && error.code === "E_BARE_CHROMIUM_REFUSED"
  );
  await assert.rejects(
    openWebSession({ baseUrl: "http://127.0.0.1", channel: "msedge" }),
    (error) => error instanceof UsageError && error.code === "E_WEB_CHANNEL_UNSUPPORTED"
  );
});

test("openWebSession requires an http or https baseUrl", async () => {
  await assert.rejects(
    openWebSession({ baseUrl: "file:///tmp/app.html" }),
    (error) => error instanceof UsageError && error.code === "E_WEB_BASE_URL_REQUIRED"
  );
  await assert.rejects(
    openWebSession({ baseUrl: "not a url" }),
    (error) => error instanceof UsageError && error.code === "E_WEB_BASE_URL_REQUIRED"
  );
});

test(
  "openWebSession drives a local static page and closes twice safely",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    await withStaticServer(async (server) => {
      const session = await openChromeOrSkip(t, { baseUrl: server.url });
      if (session === null) {
        return;
      }

      try {
        const response = await session.page.goto(new URL("/", session.baseUrl).href);
        assert.equal(response.status(), 200);
        assert.equal(await session.page.getByRole("heading", { name: "Fixture Shop" }).count(), 1);
        await session.page.getByRole("link", { name: "Checkout" }).click();
        await session.page.locator("[aria-label='email-input']").fill("buyer@example.test");
        await session.page.getByRole("button", { name: "Place order" }).click();
        assert.equal(await session.page.getByTestId("order-confirmation").isVisible(), true);
      } finally {
        await assert.doesNotReject(closeWebSession(session));
        await assert.doesNotReject(closeWebSession(session));
      }
    });
  }
);
