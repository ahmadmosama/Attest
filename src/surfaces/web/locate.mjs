import { LOCATOR_STRATEGIES } from "../../bindings/resolve.mjs";
import { UnsupportedOpError, UsageError } from "../../errors.mjs";

const SUPPORTED_RAW_KINDS = Object.freeze(["css", "xpath"]);
const SUPPORTED_RAW_KIND_SET = new Set(SUPPORTED_RAW_KINDS);
const STRATEGY_SET = new Set(LOCATOR_STRATEGIES);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireLocatorObject(locator) {
  if (!isObject(locator)) {
    throw new UsageError("E_BAD_LOCATOR", "Locator must be an object", {
      locator
    });
  }
}

function requireRootMethod(root, method) {
  if (typeof root?.[method] !== "function") {
    throw new UsageError("E_BAD_LOCATOR_ROOT", `Locator root must expose ${method}()`, {
      method
    });
  }
}

function assertString(value, field, locator) {
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageError("E_BAD_LOCATOR", `Locator field ${field} must be a non empty string`, {
      field,
      locator
    });
  }
}

function escapeCssAttributeValue(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function applyWithin(root, within) {
  if (within === undefined) {
    return root;
  }

  if (typeof within !== "string" || within.length === 0) {
    throw new UsageError("E_UNSUPPORTED_WITHIN", "Locator within must name a testId container", {
      within
    });
  }

  const prefix = "testId:";
  const value = within.startsWith(prefix) ? within.slice(prefix.length) : within;
  if (value.length === 0 || value.includes(":")) {
    throw new UsageError("E_UNSUPPORTED_WITHIN", "Only testId containers are supported for within", {
      within,
      supported: "testId"
    });
  }

  requireRootMethod(root, "getByTestId");
  return root.getByTestId(value);
}

function applyNth(playwrightLocator, locator) {
  if (locator.nth === undefined) {
    return playwrightLocator;
  }

  if (!Number.isInteger(locator.nth) || locator.nth < 0) {
    throw new UsageError("E_BAD_LOCATOR", "Locator nth must be a non negative integer", {
      nth: locator.nth,
      locator
    });
  }

  if (typeof playwrightLocator?.nth !== "function") {
    throw new UsageError("E_BAD_LOCATOR_ROOT", "Resolved locator must expose nth()", {
      method: "nth"
    });
  }

  return playwrightLocator.nth(locator.nth);
}

function byTestId(root, locator) {
  assertString(locator.value, "value", locator);
  requireRootMethod(root, "getByTestId");
  return root.getByTestId(locator.value);
}

function byRoleName(root, locator) {
  assertString(locator.role, "role", locator);
  requireRootMethod(root, "getByRole");

  if (locator.name === undefined) {
    return root.getByRole(locator.role);
  }

  assertString(locator.name, "name", locator);
  return root.getByRole(locator.role, { name: locator.name, exact: true });
}

function byAccessibilityId(root, locator) {
  assertString(locator.value, "value", locator);
  requireRootMethod(root, "locator");

  // Android maps accessibilityId to content-desc, iOS to accessibilityIdentifier,
  // and web maps the shared binding vocabulary to aria-label.
  return root.locator(`[aria-label="${escapeCssAttributeValue(locator.value)}"]`);
}

function byRaw(root, locator) {
  if (!isObject(locator.raw)) {
    throw new UsageError("E_BAD_LOCATOR", "Raw locator must carry a raw descriptor", {
      locator
    });
  }

  const { kind, value } = locator.raw;
  assertString(kind, "raw.kind", locator);
  assertString(value, "raw.value", locator);

  if (!SUPPORTED_RAW_KIND_SET.has(kind)) {
    throw new UnsupportedOpError(
      "E_RAW_SELECTOR_KIND",
      `Web surface does not support raw selector kind ${kind}`,
      {
        strategy: locator.strategy,
        kind,
        value
      }
    );
  }

  requireRootMethod(root, "locator");
  return root.locator(kind === "xpath" ? `xpath=${value}` : value);
}

function translateScoped(scopedRoot, locator) {
  switch (locator.strategy) {
    case "testId":
      return byTestId(scopedRoot, locator);
    case "roleName":
      return byRoleName(scopedRoot, locator);
    case "accessibilityId":
      return byAccessibilityId(scopedRoot, locator);
    case "raw":
      return byRaw(scopedRoot, locator);
    default:
      throw new UnsupportedOpError("E_UNSUPPORTED_LOCATOR_STRATEGY", "Unsupported locator strategy", {
        strategy: locator.strategy,
        locator,
        knownStrategies: LOCATOR_STRATEGIES
      });
  }
}

export function toLocator(root, locator) {
  requireLocatorObject(locator);

  if (!STRATEGY_SET.has(locator.strategy)) {
    throw new UnsupportedOpError("E_UNSUPPORTED_LOCATOR_STRATEGY", "Unsupported locator strategy", {
      strategy: locator.strategy,
      locator,
      knownStrategies: LOCATOR_STRATEGIES
    });
  }

  const scopedRoot = applyWithin(root, locator.within);
  const playwrightLocator = translateScoped(scopedRoot, locator);
  return applyNth(playwrightLocator, locator);
}

function quote(value) {
  return JSON.stringify(value);
}

export function describeLocator(locator) {
  requireLocatorObject(locator);

  switch (locator.strategy) {
    case "testId":
      return `testId=${locator.value}`;
    case "roleName":
      return locator.name === undefined
        ? `role=${locator.role}`
        : `role=${locator.role} name=${quote(locator.name)}`;
    case "accessibilityId":
      return `accessibilityId=${locator.value}`;
    case "raw":
      return isObject(locator.raw) ? `raw.${locator.raw.kind}=${locator.raw.value}` : "raw=<invalid>";
    default:
      return `strategy=${locator.strategy}`;
  }
}
