import { AttestError } from "../errors.mjs";
import { parseSemanticRef } from "./semantic-ref.mjs";

const EMPTY_CAPABILITIES = Object.freeze([]);

function freezeStringArray(values) {
  return Object.freeze([...values]);
}

function freezeCategoryRecord(record) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(record).map(([category, ops]) => [category, freezeStringArray(ops)])
    )
  );
}

function buildCapabilityRecord(ops, explicitCapabilities) {
  return Object.freeze(
    Object.fromEntries(
      ops.map((opName) => [
        opName,
        explicitCapabilities[opName] === undefined
          ? EMPTY_CAPABILITIES
          : freezeStringArray(explicitCapabilities[opName])
      ])
    )
  );
}

function assertKnownOp(opName) {
  if (!OP_SET.has(opName)) {
    throw new AttestError("E_UNKNOWN_OP", "Unknown operation", { opName });
  }
}

function validateTargetIfPresent(opName, opValue) {
  if (!TARGET_OP_SET.has(opName)) {
    return;
  }

  if (typeof opValue === "string") {
    parseSemanticRef(opValue);
    return;
  }

  if (opValue !== null && typeof opValue === "object" && typeof opValue.target === "string") {
    parseSemanticRef(opValue.target);
  }
}

function hasRequireNoUnexplained(opValue) {
  return Boolean(
    opValue !== null &&
      typeof opValue === "object" &&
      opValue.close !== null &&
      typeof opValue.close === "object" &&
      opValue.close.require_no_unexplained === true
  );
}

function hasExpectedMutations(opValue) {
  return Boolean(
    opValue !== null &&
      typeof opValue === "object" &&
      opValue.close !== null &&
      typeof opValue.close === "object" &&
      Array.isArray(opValue.close.expect_mutations) &&
      opValue.close.expect_mutations.length > 0
  );
}

export const OP_CATEGORIES = freezeCategoryRecord({
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

export const OPS = freezeStringArray(Object.values(OP_CATEGORIES).flat());

export const OP_SET = Object.freeze(new Set(OPS));

const TARGET_OP_SET = Object.freeze(
  new Set([
    "open",
    "tap",
    "long_press",
    "fill",
    "clear",
    "scroll_until_visible",
    "select_option",
    "upload_file",
    "expect_visible",
    "expect_hidden",
    "expect_text",
    "expect_state",
    "expect_count"
  ])
);

// Verbatim from ARCHITECTURE.md: upload_file, set_network, background, delta_window,
// and the expect_mutations field on delta_window. Additive entries make capability
// mapping total for foreground, set_permission, set_clipboard, and raw.
export const OP_CAPABILITIES = buildCapabilityRecord(OPS, {
  upload_file: ["file_upload"],
  set_network: ["network_control"],
  background: ["app_lifecycle"],
  delta_window: ["db.delta_assertion", "db.bounded_polling"],
  foreground: ["app_lifecycle"],
  set_permission: ["permission_control"],
  set_clipboard: ["clipboard_control"],
  raw: ["raw_escape"]
});

export function isOp(name) {
  return OP_SET.has(name);
}

export function capabilitiesFor(opName, opValue) {
  assertKnownOp(opName);
  validateTargetIfPresent(opName, opValue);

  if (opName !== "delta_window") {
    return OP_CAPABILITIES[opName];
  }

  const capabilities = [
    ...(hasRequireNoUnexplained(opValue) ? ["db.delta_assertion"] : []),
    ...(hasExpectedMutations(opValue) ? ["db.bounded_polling"] : [])
  ];

  return freezeStringArray(capabilities);
}
