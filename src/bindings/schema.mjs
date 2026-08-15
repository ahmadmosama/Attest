import { z } from "zod";

import { parseSemanticRef } from "../ir/semantic-ref.mjs";

const SURFACES = Object.freeze(["web", "android", "ios"]);
const ELEMENT_FIELDS = Object.freeze([
  "testId",
  "accessibilityId",
  "role",
  "name",
  "nth",
  "within",
  "css",
  "xpath",
  "uiautomator",
  "predicate"
]);
const COORDINATE_FIELDS = Object.freeze(["point", "x", "y", "coordinates", "tapPoint"]);
const RAW_FIELDS = Object.freeze(["css", "xpath", "uiautomator", "predicate"]);
const ELEMENT_FIELD_SET = new Set(ELEMENT_FIELDS);
const COORDINATE_FIELD_SET = new Set(COORDINATE_FIELDS);

const NonEmptyStringSchema = z.string().trim().min(1);

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function hasPortablePrimary(binding) {
  return hasText(binding.testId) || hasText(binding.accessibilityId);
}

function hasRoleNamePrimary(binding) {
  return hasText(binding.role);
}

function hasRawPrimary(binding) {
  return RAW_FIELDS.some((field) => hasText(binding[field]));
}

function hasPrimary(binding) {
  return hasPortablePrimary(binding) || hasRoleNamePrimary(binding) || hasRawPrimary(binding);
}

function addIssue(ctx, message, path = []) {
  ctx.addIssue({
    code: "custom",
    message,
    path
  });
}

function validateNoUnknownElementFields(binding, ctx) {
  for (const key of Object.keys(binding)) {
    if (COORDINATE_FIELD_SET.has(key)) {
      addIssue(
        ctx,
        "E_COORDINATE_BINDING: Coordinate taps are not a binding kind per ARCHITECTURE.md Anti Pattern 7",
        [key]
      );
      continue;
    }

    if (!ELEMENT_FIELD_SET.has(key)) {
      addIssue(ctx, `Unknown element binding field "${key}"`, [key]);
    }
  }
}

function validateElementPrimary(binding, ctx) {
  if (!hasPrimary(binding)) {
    addIssue(ctx, "ElementBinding requires testId, accessibilityId, role plus name, or a raw selector");
  }

  if ((hasOwn(binding, "nth") || hasOwn(binding, "within")) && !hasPrimary(binding)) {
    addIssue(ctx, "nth and within are disambiguators and require a primary locator");
  }

  if (hasOwn(binding, "name") && !hasRoleNamePrimary(binding)) {
    addIssue(ctx, "name requires role");
  }
}

function validateSemanticRefKey(key, expectedKind, ctx) {
  let parsed;
  try {
    parsed = parseSemanticRef(key);
  } catch {
    addIssue(ctx, `Invalid SemanticRef key "${key}"`, [key]);
    return;
  }

  if (expectedKind !== undefined && parsed.kind !== expectedKind) {
    addIssue(ctx, `Expected ${expectedKind}: SemanticRef key, got "${key}"`, [key]);
    return;
  }

  if (expectedKind === undefined && (parsed.kind === "screen" || parsed.kind === "state")) {
    addIssue(ctx, `Element binding key must not be "${parsed.kind}" ref "${key}"`, [key]);
  }
}

function validateSemanticRefMapKeys(map, expectedKind, ctx) {
  for (const key of Object.keys(map)) {
    validateSemanticRefKey(key, expectedKind, ctx);
  }
}

export const ElementBindingSchema = z
  .object({
    testId: NonEmptyStringSchema.optional(),
    accessibilityId: NonEmptyStringSchema.optional(),
    role: NonEmptyStringSchema.optional(),
    name: NonEmptyStringSchema.optional(),
    nth: z.number().int().nonnegative().optional(),
    within: NonEmptyStringSchema.optional(),
    css: NonEmptyStringSchema.optional(),
    xpath: NonEmptyStringSchema.optional(),
    uiautomator: NonEmptyStringSchema.optional(),
    predicate: NonEmptyStringSchema.optional()
  })
  .passthrough()
  .superRefine((binding, ctx) => {
    validateNoUnknownElementFields(binding, ctx);
    validateElementPrimary(binding, ctx);
  });

const ElementMapSchema = z.record(z.string(), ElementBindingSchema).superRefine((map, ctx) => {
  validateSemanticRefMapKeys(map, undefined, ctx);
});

const StateMapSchema = z.record(z.string(), ElementBindingSchema).superRefine((map, ctx) => {
  validateSemanticRefMapKeys(map, "state", ctx);
});

const ScreenBindingSchema = z
  .object({
    path: NonEmptyStringSchema.optional(),
    deeplink: NonEmptyStringSchema.optional(),
    ready: ElementBindingSchema
  })
  .strict();

const ScreenMapSchema = z.record(z.string(), ScreenBindingSchema).superRefine((map, ctx) => {
  validateSemanticRefMapKeys(map, "screen", ctx);
});

function validateScreenTargetForSurface(screen, surface, key, ctx) {
  if (surface === "web") {
    if (!hasText(screen.path)) {
      addIssue(ctx, `Web screen "${key}" requires path`, ["screens", key, "path"]);
    }
    if (hasOwn(screen, "deeplink")) {
      addIssue(ctx, `Web screen "${key}" must not define deeplink`, ["screens", key, "deeplink"]);
    }
    return;
  }

  if (!hasText(screen.deeplink)) {
    addIssue(ctx, `Mobile screen "${key}" requires deeplink`, ["screens", key, "deeplink"]);
  }
  if (hasOwn(screen, "path")) {
    addIssue(ctx, `Mobile screen "${key}" must not define path`, ["screens", key, "path"]);
  }
}

export const BindingsSchema = z
  .object({
    surface: z.enum(SURFACES),
    elements: ElementMapSchema.default({}),
    screens: ScreenMapSchema.default({}),
    states: StateMapSchema.default({})
  })
  .strict()
  .superRefine((bindings, ctx) => {
    for (const [key, screen] of Object.entries(bindings.screens)) {
      validateScreenTargetForSurface(screen, bindings.surface, key, ctx);
    }
  });
