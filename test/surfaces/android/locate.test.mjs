import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AttestError, UnsupportedOpError, UsageError } from "../../../src/errors.mjs";
import { androidSurfaceCapabilities, ANDROID_SURFACE_SUPPORTS } from "../../../src/surfaces/android/capabilities.mjs";
import { parseHierarchy } from "../../../src/surfaces/android/hierarchy.mjs";
import {
  ANDROID_ROLES,
  describeLocator,
  findByQuery,
  locateFailure,
  toAndroidQuery
} from "../../../src/surfaces/android/locate.mjs";
import { DEFAULT_HIERARCHY } from "../../helpers/fake-adb.mjs";

const NODES = parseHierarchy(DEFAULT_HIERARCHY);

function find(locator, options) {
  return findByQuery(NODES, toAndroidQuery(locator), options);
}

describe("android capability descriptor", () => {
  test("declares only what plain adb can do", () => {
    const descriptor = androidSurfaceCapabilities();

    assert.deepEqual(descriptor.supports, ["app_lifecycle", "raw_escape"]);
    assert.deepEqual(ANDROID_SURFACE_SUPPORTS, descriptor.supports);
    assert.equal(descriptor.surface, "android");
    assert.equal(Object.isFrozen(descriptor), true);

    // Absent, not degraded. A degraded claim would still let the op run.
    for (const capability of [
      "file_upload",
      "network_control",
      "permission_control",
      "clipboard_control",
      "clock_control"
    ]) {
      assert.equal(descriptor.has(capability), false, capability);
    }
  });
});

describe("android locator translation", () => {
  test("testId matches a package qualified resource id by suffix", () => {
    const found = find({ strategy: "testId", value: "create_order_action" });

    assert.equal(found.ok, true);
    assert.equal(found.node.resourceId, "attest.selfverify:id/create_order_action");
    assert.equal(found.description, "id=create_order_action");
  });

  test("testId also matches an unqualified resource id exactly", () => {
    const nodes = parseHierarchy(
      '<hierarchy><node index="0" resource-id="bare_id" class="android.widget.Button" bounds="[0,0][10,10]" /></hierarchy>'
    );
    const found = findByQuery(nodes, toAndroidQuery({ strategy: "testId", value: "bare_id" }));

    assert.equal(found.ok, true);
  });

  test("accessibilityId matches content-desc", () => {
    const found = find({ strategy: "accessibilityId", value: "create order" });

    assert.equal(found.ok, true);
    assert.equal(found.node.resourceId, "attest.selfverify:id/create_order_action");
  });

  test("two matches without nth is an error, never a first match", () => {
    const found = find({ strategy: "testId", value: "customer_row" });

    assert.equal(found.ok, false);
    assert.equal(found.reason, "ambiguous");
    assert.equal(found.matches, 2);
    assert.equal(found.sample.length, 2);

    const error = locateFailure(found, { i: 3, kind: "click" });
    assert(error instanceof AttestError);
    assert.equal(error.code, "E_ANDROID_AMBIGUOUS");
    assert.equal(error.details.matches, 2);
    assert.match(error.details.remediation, /nth or within/);
  });

  test("nth is the declared disambiguator and is bounds checked", () => {
    const second = find({ strategy: "testId", value: "customer_row", nth: 1 });
    assert.equal(second.ok, true);
    assert.equal(second.node.text, "Katherine Johnson");

    const beyond = find({ strategy: "testId", value: "customer_row", nth: 5 });
    assert.equal(beyond.ok, false);
    assert.equal(beyond.reason, "nth_out_of_range");
    assert.equal(locateFailure(beyond).code, "E_ANDROID_NOT_FOUND");
  });

  test("within scopes matching to nodes inside the container bounds", () => {
    const nodes = parseHierarchy(`<hierarchy>
      <node index="0" resource-id="pkg:id/panel" class="android.widget.LinearLayout" bounds="[0,0][100,100]" />
      <node index="1" resource-id="pkg:id/row" class="android.widget.TextView" text="inside" bounds="[10,10][90,40]" />
      <node index="2" resource-id="pkg:id/row" class="android.widget.TextView" text="outside" bounds="[10,500][90,540]" />
    </hierarchy>`);

    const scoped = findByQuery(nodes, toAndroidQuery({ strategy: "testId", value: "row", within: "testId:panel" }));
    assert.equal(scoped.ok, true);
    assert.equal(scoped.node.text, "inside");

    const unscoped = findByQuery(nodes, toAndroidQuery({ strategy: "testId", value: "row" }));
    assert.equal(unscoped.ok, false);
    assert.equal(unscoped.reason, "ambiguous");
  });

  test("roleName matches the declared class list plus the accessible name", () => {
    const byText = find({ strategy: "roleName", role: "button", name: "Create order" });
    assert.equal(byText.ok, true);
    assert.equal(byText.node.resourceId, "attest.selfverify:id/create_order_action");

    // The name is an accessible name, so a content description counts too.
    const byDesc = find({ strategy: "roleName", role: "button", name: "create order" });
    assert.equal(byDesc.ok, true);
  });

  test("an unknown role is refused by name rather than guessed", () => {
    assert.throws(
      () => toAndroidQuery({ strategy: "roleName", role: "combobox", name: "x" }),
      (error) => {
        assert(error instanceof UnsupportedOpError);
        assert.equal(error.code, "E_ANDROID_ROLE_UNSUPPORTED");
        assert.deepEqual(error.details.accepted, ANDROID_ROLES);
        assert.match(error.details.remediation, /android bindings file/);
        return true;
      }
    );
  });

  test("every raw selector kind is refused, because there is no engine to evaluate one", () => {
    for (const kind of ["css", "xpath", "uiautomator", "predicate"]) {
      assert.throws(
        () => toAndroidQuery({ strategy: "raw", raw: { kind, value: "//x" } }),
        (error) => {
          assert.equal(error.code, "E_RAW_SELECTOR_KIND");
          assert.equal(error.details.kind, kind);
          assert.deepEqual(error.details.supported, []);
          return true;
        }
      );
    }
  });

  test("an invalid within or nth is a usage error", () => {
    assert.throws(() => toAndroidQuery({ strategy: "testId", value: "a", within: "role:panel" }), {
      code: "E_UNSUPPORTED_WITHIN"
    });
    assert.throws(() => toAndroidQuery({ strategy: "testId", value: "a", nth: -1 }), {
      code: "E_BAD_LOCATOR"
    });
    assert.throws(() => toAndroidQuery({ strategy: "magic", value: "a" }), (error) => {
      assert(error instanceof UnsupportedOpError);
      assert.equal(error.code, "E_UNSUPPORTED_LOCATOR_STRATEGY");
      return true;
    });
    assert.throws(() => toAndroidQuery("not an object"), (error) => {
      assert(error instanceof UsageError);
      return true;
    });
  });

  test("a node with no bounds is not visible and cannot be tapped", () => {
    const found = find({ strategy: "testId", value: "offscreen" });

    assert.equal(found.ok, false);
    assert.equal(found.reason, "not_found");

    const invisible = find({ strategy: "testId", value: "offscreen" }, { requireVisible: false });
    assert.equal(invisible.ok, true);
    assert.equal(invisible.node.bounds, null);
  });

  test("describeLocator names the strategy in the terms the bindings used", () => {
    assert.equal(describeLocator({ strategy: "testId", value: "a" }), "id=a");
    assert.equal(describeLocator({ strategy: "accessibilityId", value: "a" }), "contentDesc=a");
    assert.equal(describeLocator({ strategy: "roleName", role: "button" }), "role=button");
    assert.equal(describeLocator({ strategy: "roleName", role: "button", name: "Go" }), 'role=button name="Go"');
  });
});
