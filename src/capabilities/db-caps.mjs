import { AttestError } from "../errors.mjs";
import { assertKnownCapability, DB_CAPABILITIES, isDbCapability } from "./registry.mjs";

const CAPTURE_VALUES = Object.freeze(["logical_slot", "binlog", "change_stream", "snapshot", "none"]);
const BEFORE_IMAGE_VALUES = Object.freeze(["full", "key_only", "none"]);
const WATERMARK_FENCING_VALUES = Object.freeze(["inline", "external", "none"]);

function badDescriptor(reason, details = {}) {
  return new AttestError("E_BAD_CAPABILITY_DESCRIPTOR", "Invalid database capability descriptor", {
    reason,
    ...details
  });
}

function assertDescriptorObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw badDescriptor("descriptor_not_object");
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw badDescriptor("invalid_string", { field });
  }
}

function assertBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw badDescriptor("invalid_boolean", { field });
  }
}

function assertEnum(value, field, accepted) {
  if (!accepted.includes(value)) {
    throw badDescriptor("out_of_range", { field, accepted });
  }
}

function normalizeStringArray(value, field) {
  if (!Array.isArray(value)) {
    throw badDescriptor("invalid_array", { field });
  }

  const seen = new Set();
  const normalized = [];
  for (const item of value) {
    assertNonEmptyString(item, field);
    if (!seen.has(item)) {
      seen.add(item);
      normalized.push(item);
    }
  }

  return Object.freeze(normalized);
}

function dbCapabilitiesFromFlags({ deltaAssertion, boundedPolling }) {
  const supports = [
    ...(deltaAssertion ? ["db.delta_assertion"] : []),
    ...(boundedPolling ? ["db.bounded_polling"] : [])
  ];

  for (const capability of supports) {
    assertKnownCapability(capability);
    if (!isDbCapability(capability)) {
      throw badDescriptor("db_claimed_surface_capability", { capability });
    }
  }

  return Object.freeze(supports);
}

export function defineDbCapabilities(input = {}) {
  assertDescriptorObject(input);
  const {
    driver,
    capture,
    deltaAssertion,
    boundedPolling,
    beforeImages,
    ordering,
    txAttribution,
    watermarkFencing,
    transactionalTeardown,
    degraded = []
  } = input;

  assertNonEmptyString(driver, "driver");
  assertEnum(capture, "capture", CAPTURE_VALUES);
  assertBoolean(deltaAssertion, "deltaAssertion");
  assertBoolean(boundedPolling, "boundedPolling");
  assertEnum(beforeImages, "beforeImages", BEFORE_IMAGE_VALUES);
  assertBoolean(ordering, "ordering");
  assertBoolean(txAttribution, "txAttribution");
  assertEnum(watermarkFencing, "watermarkFencing", WATERMARK_FENCING_VALUES);
  assertBoolean(transactionalTeardown, "transactionalTeardown");

  const supports = dbCapabilitiesFromFlags({ deltaAssertion, boundedPolling });
  const frozenDegraded = normalizeStringArray(degraded, "degraded");
  const supportSet = new Set(supports);

  return Object.freeze({
    driver,
    capture,
    deltaAssertion,
    boundedPolling,
    beforeImages,
    ordering,
    txAttribution,
    watermarkFencing,
    transactionalTeardown,
    supports,
    degraded: frozenDegraded,
    has(capability) {
      assertKnownCapability(capability);
      return isDbCapability(capability) && supportSet.has(capability);
    }
  });
}

for (const capability of DB_CAPABILITIES) {
  assertKnownCapability(capability);
}

export const NOT_IMPLEMENTED_DB_CAPS = defineDbCapabilities({
  driver: "none",
  capture: "none",
  deltaAssertion: false,
  boundedPolling: false,
  beforeImages: "none",
  ordering: false,
  txAttribution: false,
  watermarkFencing: "none",
  transactionalTeardown: false
});
