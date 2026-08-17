import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  findOne,
  parseHierarchy,
  selectorFromBinding,
  tapPoint
} from "../../../src/surfaces/android/hierarchy.mjs";

// A trimmed but structurally faithful uiautomator dump. Attribute order,
// self closing nodes, and the bounds format all match what the real tool emits.
const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.attest.fixture" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" selected="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Customers" resource-id="com.attest.fixture:id/title" class="android.widget.TextView" package="com.attest.fixture" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" selected="false" bounds="[40,100][520,180]" />
    <node index="1" text="Delete" resource-id="com.attest.fixture:id/delete_button" class="android.widget.Button" package="com.attest.fixture" content-desc="Delete customer" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" selected="false" bounds="[100,300][400,420]" />
    <node index="2" text="Delete" resource-id="com.attest.fixture:id/delete_other" class="android.widget.Button" package="com.attest.fixture" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" selected="false" bounds="[500,300][800,420]" />
    <node index="3" text="Tom &amp; Jerry &lt;3" resource-id="com.attest.fixture:id/escaped" class="android.widget.TextView" package="com.attest.fixture" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" selected="false" bounds="[0,500][100,560]" />
  </node>
</hierarchy>`;

describe("android uiautomator hierarchy", () => {
  test("parses every node with its attributes and bounds", () => {
    const nodes = parseHierarchy(DUMP);
    assert.equal(nodes.length, 5);

    const button = nodes.find((node) => node.resourceId === "com.attest.fixture:id/delete_button");
    assert.equal(button.text, "Delete");
    assert.equal(button.contentDesc, "Delete customer");
    assert.equal(button.clickable, true);
    assert.equal(button.className, "android.widget.Button");
    assert.deepEqual(
      { left: button.bounds.left, top: button.bounds.top, right: button.bounds.right, bottom: button.bounds.bottom },
      { left: 100, top: 300, right: 400, bottom: 420 }
    );
  });

  test("decodes XML entities in attribute values", () => {
    const nodes = parseHierarchy(DUMP);
    const escaped = nodes.find((node) => node.resourceId === "com.attest.fixture:id/escaped");
    assert.equal(escaped.text, "Tom & Jerry <3");
  });

  test("the tap point is the integer centre of the bounds, so a run is reproducible", () => {
    const nodes = parseHierarchy(DUMP);
    const button = nodes.find((node) => node.resourceId === "com.attest.fixture:id/delete_button");
    assert.deepEqual(tapPoint(button), { x: 250, y: 360 });
  });

  test("an empty or node free dump is a named error, not an empty result", () => {
    // Returning zero nodes would make every locate report not_found, which reads
    // as a scenario failure when the real problem is that the dump did not work.
    assert.throws(() => parseHierarchy(""), { code: "E_ANDROID_HIERARCHY_EMPTY" });
    assert.throws(() => parseHierarchy("<hierarchy rotation=\"0\"></hierarchy>"), {
      code: "E_ANDROID_HIERARCHY_EMPTY"
    });
  });

  test("findOne resolves a unique match", () => {
    const nodes = parseHierarchy(DUMP);
    const found = findOne(nodes, { resourceId: "com.attest.fixture:id/delete_button" });
    assert.equal(found.ok, true);
    assert.equal(found.node.contentDesc, "Delete customer");
  });

  test("an ambiguous selector is an error rather than a silent first match", () => {
    // Two buttons both read "Delete". Taking the first is how a scenario passes
    // while driving the wrong widget.
    const nodes = parseHierarchy(DUMP);
    const found = findOne(nodes, { text: "Delete" });
    assert.equal(found.ok, false);
    assert.equal(found.reason, "ambiguous");
    assert.equal(found.matches, 2);
    assert.equal(found.sample.length, 2);
  });

  test("the ambiguity sample is bounded so a large screen cannot flood an artifact", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      `<node index="${index}" text="Row" resource-id="" class="android.widget.TextView" package="p" content-desc="" enabled="true" bounds="[0,${index * 10}][100,${index * 10 + 9}]" />`
    ).join("\n");
    const nodes = parseHierarchy(`<hierarchy>${many}</hierarchy>`);
    const found = findOne(nodes, { text: "Row" });
    assert.equal(found.reason, "ambiguous");
    assert.equal(found.matches, 40);
    assert.equal(found.sample.length, 5);
  });

  test("a selector matching nothing reports not_found rather than throwing", () => {
    const nodes = parseHierarchy(DUMP);
    const found = findOne(nodes, { resourceId: "com.attest.fixture:id/missing" });
    assert.equal(found.ok, false);
    assert.equal(found.reason, "not_found");
  });

  test("selectorFromBinding maps binding keys and refuses an empty binding", () => {
    assert.deepEqual(selectorFromBinding({ id: "a:id/b" }), { resourceId: "a:id/b" });
    assert.deepEqual(selectorFromBinding({ text: "Go", desc: "go button" }), {
      text: "Go",
      contentDesc: "go button"
    });
    assert.throws(() => selectorFromBinding({}), { code: "E_ANDROID_BINDING_INVALID" });
    assert.throws(() => selectorFromBinding(null), { code: "E_ANDROID_BINDING_INVALID" });
  });

  test("a node with no bounds cannot be tapped", () => {
    assert.throws(() => tapPoint({ resourceId: "x", bounds: null }), { code: "E_ANDROID_NODE_NOT_TAPPABLE" });
  });
});
