import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AttestError, UnsupportedOpError, UsageError } from "../../../src/errors.mjs";
import { iosSurfaceCapabilities, IOS_SURFACE_SUPPORTS } from "../../../src/surfaces/ios/capabilities.mjs";
import {
  IOS_ROLES,
  describeLocator,
  findByQuery,
  locateFailure,
  tapPoint,
  toIosQuery
} from "../../../src/surfaces/ios/locate.mjs";

function element(overrides = {}) {
  return {
    identifier: "",
    type: "XCUIElementTypeOther",
    label: "",
    title: "",
    enabled: true,
    frame: { x: 0, y: 0, width: 100, height: 40 },
    ...overrides
  };
}

const TREE = Object.freeze([
  element({ identifier: "checkout_root", type: "XCUIElementTypeOther", frame: { x: 0, y: 0, width: 390, height: 800 } }),
  element({ identifier: "place_order", type: "XCUIElementTypeButton", label: "Place order", frame: { x: 20, y: 100, width: 350, height: 44 } }),
  element({ identifier: "cart_count", type: "XCUIElementTypeStaticText", label: "1", frame: { x: 20, y: 200, width: 40, height: 20 } }),
  element({ identifier: "row", type: "XCUIElementTypeCell", label: "first", frame: { x: 20, y: 300, width: 350, height: 60 } }),
  element({ identifier: "row", type: "XCUIElementTypeCell", label: "second", frame: { x: 20, y: 900, width: 350, height: 60 } }),
  element({ identifier: "offscreen", type: "XCUIElementTypeStaticText", label: "hidden", frame: null })
]);

function find(locator, options) {
  return findByQuery(TREE, toIosQuery(locator), options);
}

describe("ios capability descriptor", () => {
  test("declares only what the simctl backend actually drives", () => {
    const descriptor = iosSurfaceCapabilities();

    assert.deepEqual(descriptor.supports, ["app_lifecycle", "raw_escape"]);
    assert.deepEqual(IOS_SURFACE_SUPPORTS, descriptor.supports);
    assert.equal(descriptor.surface, "ios");

    // simctl could do permissions and the clipboard. They are not declared
    // until the adapter drives them, and this surface only ever runs on CI, so
    // an undeclared-but-claimed capability would be a lie nobody could catch
    // locally.
    for (const capability of ["file_upload", "network_control", "permission_control", "clipboard_control", "clock_control"]) {
      assert.equal(descriptor.has(capability), false, capability);
    }
  });
});

describe("ios locator translation", () => {
  test("both portable strategies land on accessibilityIdentifier", () => {
    // Which is what a test id is on this platform, and unlike a label it is not
    // shown to a user and not translated.
    for (const locator of [
      { strategy: "testId", value: "place_order" },
      { strategy: "accessibilityId", value: "place_order" }
    ]) {
      const found = find(locator);
      assert.equal(found.ok, true, JSON.stringify(locator));
      assert.equal(found.element.label, "Place order");
    }
  });

  test("a role maps through an explicit type table plus the accessible name", () => {
    const byLabel = find({ strategy: "roleName", role: "button", name: "Place order" });

    assert.equal(byLabel.ok, true);
    assert.equal(byLabel.element.identifier, "place_order");
  });

  test("an unknown role is refused by name rather than guessed", () => {
    assert.throws(() => toIosQuery({ strategy: "roleName", role: "combobox", name: "x" }), (error) => {
      assert(error instanceof UnsupportedOpError);
      assert.equal(error.code, "E_IOS_ROLE_UNSUPPORTED");
      assert.deepEqual(error.details.accepted, IOS_ROLES);
      return true;
    });
  });

  test("two matches without nth is an error, never a first match", () => {
    const found = find({ strategy: "testId", value: "row" });

    assert.equal(found.ok, false);
    assert.equal(found.reason, "ambiguous");
    assert.equal(found.matches, 2);

    const error = locateFailure(found, { i: 2, kind: "click" });
    assert(error instanceof AttestError);
    assert.equal(error.code, "E_IOS_AMBIGUOUS");
    assert.match(error.details.remediation, /accessibilityIdentifier/u);
  });

  test("nth is the declared disambiguator and is bounds checked", () => {
    assert.equal(find({ strategy: "testId", value: "row", nth: 1 }).element.label, "second");

    const beyond = find({ strategy: "testId", value: "row", nth: 9 });
    assert.equal(beyond.reason, "nth_out_of_range");
    assert.equal(locateFailure(beyond).code, "E_IOS_NOT_FOUND");
  });

  test("within scopes matching to elements inside the container frame", () => {
    const scoped = find({ strategy: "testId", value: "row", within: "testId:checkout_root" });

    // The second row is at y 900, outside the 800 tall root.
    assert.equal(scoped.ok, true);
    assert.equal(scoped.element.label, "first");
  });

  test("every raw selector kind is refused, because there is no engine to evaluate one", () => {
    for (const kind of ["css", "xpath", "uiautomator", "predicate"]) {
      assert.throws(() => toIosQuery({ strategy: "raw", raw: { kind, value: "//x" } }), (error) => {
        assert.equal(error.code, "E_RAW_SELECTOR_KIND");
        assert.deepEqual(error.details.supported, []);
        return true;
      });
    }
  });

  test("an element with no frame is not visible and cannot be tapped", () => {
    assert.equal(find({ strategy: "testId", value: "offscreen" }).ok, false);
    assert.equal(find({ strategy: "testId", value: "offscreen" }, { requireVisible: false }).ok, true);
    assert.throws(() => tapPoint({ identifier: "offscreen", frame: null }), {
      code: "E_IOS_ELEMENT_NOT_TAPPABLE"
    });
  });

  test("the tap point is the integer centre of the frame, so a run stays reproducible", () => {
    const found = find({ strategy: "testId", value: "place_order" });

    assert.deepEqual(tapPoint(found.element), { x: 195, y: 122 });
  });

  test("an invalid within, nth or strategy is refused", () => {
    assert.throws(() => toIosQuery({ strategy: "testId", value: "a", within: "role:x" }), {
      code: "E_UNSUPPORTED_WITHIN"
    });
    assert.throws(() => toIosQuery({ strategy: "testId", value: "a", nth: -1 }), { code: "E_BAD_LOCATOR" });
    assert.throws(() => toIosQuery({ strategy: "magic", value: "a" }), {
      code: "E_UNSUPPORTED_LOCATOR_STRATEGY"
    });
    assert.throws(() => toIosQuery("not an object"), (error) => {
      assert(error instanceof UsageError);
      return true;
    });
  });

  test("describeLocator names the strategy in the terms the bindings used", () => {
    assert.equal(describeLocator({ strategy: "accessibilityId", value: "a" }), "identifier=a");
    assert.equal(describeLocator({ strategy: "roleName", role: "button", name: "Go" }), 'role=button name="Go"');
  });
});
