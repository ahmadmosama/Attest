import { AttestError } from "../errors.mjs";
import { assertKnownCapability, isDbCapability } from "./registry.mjs";

function badDescriptor(reason, details = {}) {
  return new AttestError("E_BAD_CAPABILITY_DESCRIPTOR", "Invalid surface capability descriptor", {
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

function normalizeSurfaceCapabilities(supports) {
  const capabilities = normalizeStringArray(supports, "supports");

  for (const capability of capabilities) {
    assertKnownCapability(capability);
    if (isDbCapability(capability)) {
      throw badDescriptor("surface_claimed_db_capability", { capability });
    }
  }

  return capabilities;
}

export function defineSurfaceCapabilities(input = {}) {
  assertDescriptorObject(input);
  const { surface, supports, degraded = [] } = input;

  assertNonEmptyString(surface, "surface");

  const frozenSupports = normalizeSurfaceCapabilities(supports);
  const frozenDegraded = normalizeStringArray(degraded, "degraded");
  const supportSet = new Set(frozenSupports);

  return Object.freeze({
    surface,
    supports: frozenSupports,
    degraded: frozenDegraded,
    has(capability) {
      assertKnownCapability(capability);
      return !isDbCapability(capability) && supportSet.has(capability);
    }
  });
}
