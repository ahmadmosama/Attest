import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { AttestError, InfraError, UnsupportedOpError } from "../../../src/errors.mjs";
import { executeAct } from "../../../src/surfaces/web/act.mjs";
import { closeWebSession, openWebSession } from "../../../src/surfaces/web/session.mjs";
import { startStaticServer } from "../../helpers/static-server.mjs";
import { webStepTimeoutMs } from "../../helpers/timeouts.mjs";

const FIXTURE_DIR = path.resolve("test/fixtures/web-app");
const TEST_TIMEOUT = 120000;
// No test here asserts that a timeout HAPPENS, so this number only exists to
// keep a wedged run short. A slow host may raise the floor.
const STEP_TIMEOUT_MS = webStepTimeoutMs(1500);

const productReady = Object.freeze({ strategy: "testId", value: "product-grid" });
const checkoutHeading = Object.freeze({ strategy: "roleName", role: "heading", name: "Checkout" });

function isChromeMissing(error) {
  return error instanceof InfraError && error.code === "E_ADAPTER_BROWSER_LAUNCH";
}

async function openChromeOrSkip(t, options) {
  try {
    const session = await openWebSession(options);
    return Object.freeze({
      ...session,
      actionTimeoutMs: STEP_TIMEOUT_MS,
      assertTimeoutMs: STEP_TIMEOUT_MS
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
    const session = await openChromeOrSkip(t, { baseUrl: server.url, channel: "chrome", headed: false });
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

test("navigate resolves against baseUrl and converges on the ready locator", { timeout: TEST_TIMEOUT }, async (t) => {
  await withSession(t, async (session) => {
    const result = await executeAct(
      session,
      { i: 0, kind: "navigate", target: { path: "/" }, ready: productReady },
      {}
    );

    assert.equal(result.ok, true);
    assert.equal(result.detail.url, `${session.baseUrl.href}`);
    assert.equal(result.detail.kind, "navigate");
    assert.equal(typeof result.detail.readyMs, "number");
    assert.equal(await session.page.getByRole("heading", { name: "Fixture Shop" }).isVisible(), true);
  });
});

test("navigate failure names the ready locator", { timeout: TEST_TIMEOUT }, async (t) => {
  await withSession(
    t,
    async (session) => {
      const fastSession = Object.freeze({ ...session, assertTimeoutMs: 100 });

      await assert.rejects(
        executeAct(
          fastSession,
          {
            i: 1,
            kind: "navigate",
            target: { path: "/empty" },
            ready: { strategy: "testId", value: "never-ready" }
          },
          {}
        ),
        (error) =>
          error instanceof AttestError &&
          error.code === "E_WEB_READY_TIMEOUT" &&
          error.details.i === 1 &&
          error.details.locator === "testId=never-ready"
      );
    },
    { routes: { "/empty": "<!doctype html><main><h1>Empty</h1></main>" } }
  );
});

test("click, fill, clear, press_key, select_option, and back drive the page", { timeout: TEST_TIMEOUT }, async (t) => {
  await withSession(t, async (session) => {
    await executeAct(session, { i: 0, kind: "navigate", target: { path: "/checkout.html" }, ready: checkoutHeading }, {});
    await executeAct(
      session,
      { i: 1, kind: "fill", locator: { strategy: "accessibilityId", value: "email-input" }, value: "buyer@example.test" },
      {}
    );
    assert.equal(await session.page.locator("[name='email']").inputValue(), "buyer@example.test");

    await executeAct(session, { i: 2, kind: "clear", locator: { strategy: "accessibilityId", value: "email-input" } }, {});
    assert.equal(await session.page.locator("[name='email']").inputValue(), "");

    await executeAct(
      session,
      { i: 3, kind: "fill", locator: { strategy: "accessibilityId", value: "email-input" }, value: "buyer@example.test" },
      {}
    );
    await executeAct(session, { i: 4, kind: "click", locator: { strategy: "roleName", role: "button", name: "Place order" } }, {});
    assert.equal(await session.page.getByTestId("order-confirmation").isVisible(), true);

    await executeAct(session, { i: 5, kind: "navigate", target: { path: "/" }, ready: productReady }, {});
    await executeAct(session, { i: 6, kind: "click", locator: { strategy: "roleName", role: "link", name: "Checkout" } }, {});
    assert.equal(await session.page.getByRole("heading", { name: "Checkout" }).isVisible(), true);
    await executeAct(session, { i: 7, kind: "back" }, {});
    assert.equal(await session.page.getByTestId("product-grid").isVisible(), true);
  });
});

test("keyboard, selection, scrolling, file upload, and swipe use real controls", { timeout: TEST_TIMEOUT }, async (t) => {
  const controls = `<!doctype html>
    <input data-testid="key-input" aria-label="key-input">
    <select data-testid="choice"><option value="one">One</option><option value="two">Two</option></select>
    <input data-testid="file-input" type="file">
    <p data-testid="file-name"></p>
    <div style="height: 2200px"></div>
    <button data-testid="offscreen">Bottom</button>
    <script>
      document.querySelector("[data-testid='file-input']").addEventListener("change", (event) => {
        document.querySelector("[data-testid='file-name']").textContent = event.target.files[0]?.name ?? "";
      });
    </script>`;

  await withSession(
    t,
    async (session) => {
      await executeAct(session, { i: 0, kind: "navigate", target: { path: "/controls" }, ready: { strategy: "testId", value: "key-input" } }, {});
      await executeAct(session, { i: 1, kind: "click", locator: { strategy: "testId", value: "key-input" } }, {});
      await executeAct(session, { i: 2, kind: "press_key", key: "A" }, {});
      assert.equal(await session.page.getByTestId("key-input").inputValue(), "A");

      await executeAct(session, { i: 3, kind: "select_option", locator: { strategy: "testId", value: "choice" }, value: "two" }, {});
      assert.equal(await session.page.getByTestId("choice").inputValue(), "two");

      await executeAct(session, { i: 4, kind: "scroll_until_visible", locator: { strategy: "testId", value: "offscreen" } }, {});
      assert.equal(await session.page.getByTestId("offscreen").isVisible(), true);
      assert.equal((await session.page.evaluate(() => window.scrollY)) > 0, true);

      await executeAct(session, { i: 5, kind: "swipe", direction: "down" }, {});
      assert.equal((await session.page.evaluate(() => window.scrollY)) > 0, true);

      await executeAct(
        session,
        {
          i: 6,
          kind: "upload_file",
          locator: { strategy: "testId", value: "file-input" },
          path: path.resolve("test/fixtures/web-app/index.html")
        },
        {}
      );
      assert.equal(await session.page.getByTestId("file-name").innerText(), "index.html");
    },
    { routes: { "/controls": controls } }
  );
});

test("environment ops control network, permission, clipboard, and raw script", { timeout: TEST_TIMEOUT }, async (t) => {
  await withSession(t, async (session) => {
    await executeAct(session, { i: 0, kind: "navigate", target: { path: "/" }, ready: productReady }, {});

    await executeAct(session, { i: 1, kind: "set_permission", name: "geolocation", value: "granted" }, {});
    assert.equal(
      await session.page.evaluate(() => navigator.permissions.query({ name: "geolocation" }).then((status) => status.state)),
      "granted"
    );

    await executeAct(session, { i: 2, kind: "set_clipboard", value: "clipboard-value" }, {});
    assert.equal(await session.page.evaluate(() => navigator.clipboard.readText()), "clipboard-value");

    await executeAct(session, { i: 3, kind: "raw", block: { script: "document.body.dataset.raw = 'ok'" } }, {});
    assert.equal(await session.page.evaluate(() => document.body.dataset.raw), "ok");

    await assert.rejects(
      executeAct(session, { i: 4, kind: "raw", block: { native: "noop" } }, {}),
      (error) => error instanceof UnsupportedOpError && error.code === "E_RAW_BLOCK_UNSUPPORTED"
    );

    await executeAct(session, { i: 5, kind: "set_network", mode: "offline" }, {});
    await assert.rejects(
      executeAct(session, { i: 6, kind: "navigate", target: { path: "/checkout.html" }, ready: checkoutHeading }, {}),
      (error) => error instanceof AttestError && error.details.kind === "navigate"
    );
  });
});

test("unsupported app lifecycle and swipe direction throw explicitly", { timeout: TEST_TIMEOUT }, async (t) => {
  await withSession(t, async (session) => {
    await assert.rejects(
      executeAct(session, { i: 0, kind: "app_background" }, {}),
      (error) =>
        error instanceof UnsupportedOpError &&
        error.code === "E_UNSUPPORTED_OP" &&
        error.details.missing.includes("app_lifecycle")
    );

    await assert.rejects(
      executeAct(session, { i: 1, kind: "swipe", direction: "diagonal" }, {}),
      (error) => error instanceof UnsupportedOpError && error.details.direction === "diagonal"
    );
  });
});
