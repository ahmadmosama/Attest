import assert from "node:assert/strict";
import test from "node:test";

import { UnsupportedOpError, UsageError } from "../../../src/errors.mjs";
import { describeLocator, toLocator } from "../../../src/surfaces/web/locate.mjs";

function makeRoot(name = "root", calls = []) {
  return {
    calls,
    name,
    getByTestId(value) {
      calls.push([name, "getByTestId", value]);
      return makeRoot(`${name}.getByTestId(${value})`, calls);
    },
    getByRole(role, options) {
      calls.push(
        options === undefined ? [name, "getByRole", role] : [name, "getByRole", role, options]
      );
      return makeRoot(`${name}.getByRole(${role})`, calls);
    },
    locator(selector) {
      calls.push([name, "locator", selector]);
      return makeRoot(`${name}.locator(${selector})`, calls);
    },
    nth(index) {
      calls.push([name, "nth", index]);
      return makeRoot(`${name}.nth(${index})`, calls);
    }
  };
}

test("testId locator maps to getByTestId", () => {
  const root = makeRoot();
  const result = toLocator(root, { strategy: "testId", value: "cart-count" });

  assert.deepEqual(root.calls, [["root", "getByTestId", "cart-count"]]);
  assert.equal(result.name, "root.getByTestId(cart-count)");
});

test("roleName locator with name uses exact Playwright role options", () => {
  const root = makeRoot();

  toLocator(root, { strategy: "roleName", role: "button", name: "Place order" });

  assert.deepEqual(root.calls, [
    ["root", "getByRole", "button", { name: "Place order", exact: true }]
  ]);
});

test("roleName locator without name passes no options", () => {
  const root = makeRoot();

  toLocator(root, { strategy: "roleName", role: "listitem" });

  assert.deepEqual(root.calls, [["root", "getByRole", "listitem"]]);
});

test("accessibilityId maps to aria-label selector on web", () => {
  const root = makeRoot();

  toLocator(root, { strategy: "accessibilityId", value: "email-input" });

  assert.deepEqual(root.calls, [["root", "locator", '[aria-label="email-input"]']]);
});

test("accessibilityId escapes quotes and backslashes inside CSS attribute value", () => {
  const root = makeRoot();

  toLocator(root, { strategy: "accessibilityId", value: 'say "hi" \\ now' });

  assert.deepEqual(root.calls, [["root", "locator", '[aria-label="say \\"hi\\" \\\\ now"]']]);
});

test("raw css maps directly to locator", () => {
  const root = makeRoot();

  toLocator(root, { strategy: "raw", raw: { kind: "css", value: ".x" } });

  assert.deepEqual(root.calls, [["root", "locator", ".x"]]);
});

test("raw xpath is prefixed for Playwright", () => {
  const root = makeRoot();

  toLocator(root, { strategy: "raw", raw: { kind: "xpath", value: "//div" } });

  assert.deepEqual(root.calls, [["root", "locator", "xpath=//div"]]);
});

test("mobile raw selector kinds are refused by name", () => {
  for (const kind of ["uiautomator", "predicate"]) {
    assert.throws(
      () => toLocator(makeRoot(), { strategy: "raw", raw: { kind, value: "..." } }),
      (error) =>
        error instanceof UnsupportedOpError &&
        error.code === "E_RAW_SELECTOR_KIND" &&
        error.details.strategy === "raw" &&
        error.details.kind === kind &&
        error.details.value === "..."
    );
  }
});

test("nth applies after primary strategy", () => {
  const root = makeRoot();

  toLocator(root, { strategy: "testId", value: "cart-count", nth: 0 });

  assert.deepEqual(root.calls, [
    ["root", "getByTestId", "cart-count"],
    ["root.getByTestId(cart-count)", "nth", 0]
  ]);
});

test("within scopes by testId before resolving the primary strategy", () => {
  const root = makeRoot();

  toLocator(root, { strategy: "roleName", role: "listitem", within: "product-grid" });

  assert.deepEqual(root.calls, [
    ["root", "getByTestId", "product-grid"],
    ["root.getByTestId(product-grid)", "getByRole", "listitem"]
  ]);
});

test("within accepts and strips the testId prefix", () => {
  const root = makeRoot();

  toLocator(root, { strategy: "roleName", role: "listitem", within: "testId:product-grid" });

  assert.deepEqual(root.calls, [
    ["root", "getByTestId", "product-grid"],
    ["root.getByTestId(product-grid)", "getByRole", "listitem"]
  ]);
});

test("within refuses non testId scopes", () => {
  assert.throws(
    () => toLocator(makeRoot(), { strategy: "testId", value: "x", within: "role:list" }),
    (error) =>
      error instanceof UsageError &&
      error.code === "E_UNSUPPORTED_WITHIN" &&
      error.details.within === "role:list"
  );
});

test("unknown strategy throws UnsupportedOpError naming the strategy", () => {
  assert.throws(
    () => toLocator(makeRoot(), { strategy: "text", value: "Continue" }),
    (error) =>
      error instanceof UnsupportedOpError &&
      error.code === "E_UNSUPPORTED_LOCATOR_STRATEGY" &&
      error.details.strategy === "text"
  );
});

test("describeLocator returns stable short strings", () => {
  assert.equal(describeLocator({ strategy: "testId", value: "cart-count" }), "testId=cart-count");
  assert.equal(
    describeLocator({ strategy: "roleName", role: "button", name: "Place order" }),
    'role=button name="Place order"'
  );
  assert.equal(describeLocator({ strategy: "roleName", role: "listitem" }), "role=listitem");
  assert.equal(
    describeLocator({ strategy: "accessibilityId", value: "email-input" }),
    "accessibilityId=email-input"
  );
  assert.equal(describeLocator({ strategy: "raw", raw: { kind: "css", value: ".x" } }), "raw.css=.x");
});
