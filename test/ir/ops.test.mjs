import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilitiesFor,
  isOp,
  OP_CAPABILITIES,
  OP_CATEGORIES,
  OP_SET,
  OPS
} from "../../src/ir/ops.mjs";

const expectedCategories = Object.freeze({
  navigation: ["open", "back", "background", "foreground"],
  interaction: [
    "tap",
    "long_press",
    "fill",
    "clear",
    "press_key",
    "swipe",
    "scroll_until_visible",
    "select_option",
    "upload_file"
  ],
  environment: ["set_permission", "set_network", "set_clipboard"],
  assertion: ["expect_visible", "expect_hidden", "expect_text", "expect_state", "expect_count"],
  structure: ["checkpoint", "run_flow", "delta_window"],
  escape_hatch: ["raw"]
});

test("OPS has exactly the closed vocabulary from ARCHITECTURE.md", () => {
  assert.equal(OPS.length, 25);
  assert.deepEqual(OP_CATEGORIES, expectedCategories);
  assert.deepEqual(OPS, Object.values(expectedCategories).flat());
  assert.equal(OP_SET.size, 25);
});

test("operation lookup accepts only the closed vocabulary", () => {
  assert.equal(isOp("sleep"), false);
  assert.equal(isOp("wait"), false);
  assert.equal(isOp("tap"), true);
});

test("capabilitiesFor resolves fixed operation capabilities", () => {
  assert.deepEqual(capabilitiesFor("upload_file"), ["file_upload"]);
  assert.deepEqual(capabilitiesFor("set_network"), ["network_control"]);
  assert.deepEqual(capabilitiesFor("background"), ["app_lifecycle"]);
  assert.deepEqual(capabilitiesFor("foreground"), ["app_lifecycle"]);
});

test("capabilitiesFor resolves value aware delta_window capabilities", () => {
  assert.deepEqual(capabilitiesFor("delta_window", { close: {} }), []);
  assert.deepEqual(capabilitiesFor("delta_window", { close: { require_no_unexplained: true } }), [
    "db.delta_assertion"
  ]);
  assert.deepEqual(capabilitiesFor("delta_window", { close: { expect_mutations: [{}] } }), [
    "db.bounded_polling"
  ]);
});

test("base operations demand an empty frozen array", () => {
  const capabilities = capabilitiesFor("tap");

  assert.deepEqual(capabilities, []);
  assert.throws(() => capabilities.push("network_control"));
});

test("exported structures are frozen", () => {
  assert.throws(() => OPS.push("sleep"));
  assert.throws(() => OP_CATEGORIES.navigation.push("wait"));
  assert.throws(() => {
    OP_CAPABILITIES.tap = ["raw_escape"];
  });
});

test("unknown operations throw a named AttestError", () => {
  assert.throws(
    () => capabilitiesFor("sleep"),
    (error) => error.code === "E_UNKNOWN_OP"
  );
});
