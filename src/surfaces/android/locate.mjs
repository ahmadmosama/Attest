import { LOCATOR_STRATEGIES } from "../../bindings/resolve.mjs";
import { AttestError, UnsupportedOpError, UsageError } from "../../errors.mjs";
import { findOne } from "./hierarchy.mjs";

// One declared role maps to an explicit list of simple class names. This is a
// table rather than a heuristic on purpose: a heuristic that "looks like a
// button" is how a gate ends up driving the wrong widget and still reporting
// green. An unlisted role is refused by name.
export const ANDROID_ROLE_CLASSES = Object.freeze({
  button: Object.freeze([
    "Button",
    "ImageButton",
    "AppCompatButton",
    "MaterialButton",
    "FloatingActionButton",
    "ExtendedFloatingActionButton"
  ]),
  link: Object.freeze(["TextView", "AppCompatTextView", "MaterialTextView"]),
  heading: Object.freeze(["TextView", "AppCompatTextView", "MaterialTextView"]),
  text: Object.freeze(["TextView", "AppCompatTextView", "MaterialTextView"]),
  textbox: Object.freeze(["EditText", "AppCompatEditText", "TextInputEditText"]),
  checkbox: Object.freeze(["CheckBox", "AppCompatCheckBox", "MaterialCheckBox"]),
  radio: Object.freeze(["RadioButton", "AppCompatRadioButton", "MaterialRadioButton"]),
  switch: Object.freeze(["Switch", "SwitchCompat", "SwitchMaterial", "MaterialSwitch"]),
  image: Object.freeze(["ImageView", "AppCompatImageView", "ShapeableImageView"]),
  tab: Object.freeze(["TabView", "TabItem"])
});

export const ANDROID_ROLES = Object.freeze(Object.keys(ANDROID_ROLE_CLASSES));

const STRATEGY_SET = new Set(LOCATOR_STRATEGIES);
const WITHIN_PREFIX = "testId:";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireLocatorObject(locator) {
  if (!isObject(locator)) {
    throw new UsageError("E_BAD_LOCATOR", "Locator must be an object", { locator });
  }
}

function assertString(value, field, locator) {
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageError("E_BAD_LOCATOR", `Locator field ${field} must be a non empty string`, {
      field,
      locator
    });
  }

  return value;
}

function testIdSelector(value) {
  return Object.freeze({ resourceIdSuffix: value });
}

function roleSelector(locator) {
  const classes = ANDROID_ROLE_CLASSES[locator.role];
  if (classes === undefined) {
    throw new UnsupportedOpError(
      "E_ANDROID_ROLE_UNSUPPORTED",
      `Android surface has no class mapping for role ${locator.role}`,
      {
        role: locator.role,
        accepted: ANDROID_ROLES,
        remediation:
          "Bind this element by id or accessibilityId in the android bindings file rather than by role."
      }
    );
  }

  if (locator.name === undefined) {
    return Object.freeze({ classNameOneOf: classes });
  }

  return Object.freeze({
    classNameOneOf: classes,
    nameAny: assertString(locator.name, "name", locator)
  });
}

function rawRefused(locator) {
  const kind = isObject(locator.raw) ? locator.raw.kind : null;

  // css and xpath describe a DOM this surface does not have. uiautomator and
  // predicate describe query languages that only a UiAutomator or XCUITest
  // server can evaluate, and this backend drives adb directly (decision C6).
  // Approximating any of them against a dumped tree is guessing.
  throw new UnsupportedOpError(
    "E_RAW_SELECTOR_KIND",
    `Android surface does not support raw selector kind ${kind ?? "<missing>"}`,
    {
      strategy: locator.strategy,
      kind,
      supported: [],
      remediation:
        "Bind this element by id, accessibilityId or role in the android bindings file. The adb backend has no selector engine to evaluate a raw query against."
    }
  );
}

function selectorFor(locator) {
  switch (locator.strategy) {
    case "testId":
      return testIdSelector(assertString(locator.value, "value", locator));
    case "accessibilityId":
      return Object.freeze({ contentDesc: assertString(locator.value, "value", locator) });
    case "roleName":
      assertString(locator.role, "role", locator);
      return roleSelector(locator);
    case "raw":
      return rawRefused(locator);
    default:
      throw new UnsupportedOpError("E_UNSUPPORTED_LOCATOR_STRATEGY", "Unsupported locator strategy", {
        strategy: locator.strategy,
        locator,
        knownStrategies: LOCATOR_STRATEGIES
      });
  }
}

function withinSelector(locator) {
  if (locator.within === undefined) {
    return null;
  }

  if (typeof locator.within !== "string" || locator.within.length === 0) {
    throw new UsageError("E_UNSUPPORTED_WITHIN", "Locator within must name a testId container", {
      within: locator.within
    });
  }

  const value = locator.within.startsWith(WITHIN_PREFIX)
    ? locator.within.slice(WITHIN_PREFIX.length)
    : locator.within;

  if (value.length === 0 || value.includes(":")) {
    throw new UsageError("E_UNSUPPORTED_WITHIN", "Only testId containers are supported for within", {
      within: locator.within,
      supported: "testId"
    });
  }

  return testIdSelector(value);
}

function nthFor(locator) {
  if (locator.nth === undefined) {
    return null;
  }

  if (!Number.isInteger(locator.nth) || locator.nth < 0) {
    throw new UsageError("E_BAD_LOCATOR", "Locator nth must be a non negative integer", {
      nth: locator.nth,
      locator
    });
  }

  return locator.nth;
}

export function describeLocator(locator) {
  requireLocatorObject(locator);

  switch (locator.strategy) {
    case "testId":
      return `id=${locator.value}`;
    case "accessibilityId":
      return `contentDesc=${locator.value}`;
    case "roleName":
      return locator.name === undefined
        ? `role=${locator.role}`
        : `role=${locator.role} name=${JSON.stringify(locator.name)}`;
    case "raw":
      return isObject(locator.raw) ? `raw.${locator.raw.kind}=${locator.raw.value}` : "raw=<invalid>";
    default:
      return `strategy=${locator.strategy}`;
  }
}

/**
 * Translate one shared vocabulary locator into an Android node query.
 *
 * Pure, so it is assertable with no device. Every refusal happens here rather
 * than at match time, so an unbindable locator fails the same way whether or
 * not the screen happened to contain something that looked close enough.
 */
export function toAndroidQuery(locator) {
  requireLocatorObject(locator);

  if (!STRATEGY_SET.has(locator.strategy)) {
    throw new UnsupportedOpError("E_UNSUPPORTED_LOCATOR_STRATEGY", "Unsupported locator strategy", {
      strategy: locator.strategy,
      locator,
      knownStrategies: LOCATOR_STRATEGIES
    });
  }

  return Object.freeze({
    selector: selectorFor(locator),
    within: withinSelector(locator),
    nth: nthFor(locator),
    description: describeLocator(locator)
  });
}

function containerBounds(nodes, query) {
  if (query.within === null) {
    return null;
  }

  const found = findOne(nodes, query.within, { requireVisible: true });
  if (!found.ok) {
    return Object.freeze({ ok: false, reason: `container_${found.reason}`, matches: found.matches });
  }

  return Object.freeze({ ok: true, bounds: found.node.bounds });
}

/**
 * Resolve a query against one parsed hierarchy.
 *
 * Returns a result rather than throwing, because "no match" is a legitimate
 * pass for expect_hidden and a legitimate not-yet for a converging locate.
 */
export function findByQuery(nodes, query, { requireVisible = true } = {}) {
  const container = containerBounds(nodes, query);
  if (container !== null && container.ok !== true) {
    return Object.freeze({ ok: false, reason: container.reason, matches: 0, description: query.description });
  }

  const found = findOne(nodes, query.selector, {
    requireVisible,
    container: container === null ? null : container.bounds,
    nth: query.nth
  });

  return Object.freeze({ ...found, description: query.description });
}

export function locateFailure(result, { i = null, kind = null } = {}) {
  const code = result.reason === "ambiguous" ? "E_ANDROID_AMBIGUOUS" : "E_ANDROID_NOT_FOUND";
  const message =
    result.reason === "ambiguous"
      ? "Android locator matched more than one node"
      : "Android locator did not resolve to a node";

  return new AttestError(code, message, {
    i,
    kind,
    locator: result.description,
    reason: result.reason,
    matches: result.matches ?? 0,
    ...(result.nth === undefined ? {} : { nth: result.nth }),
    ...(result.sample === undefined ? {} : { sample: result.sample }),
    remediation:
      result.reason === "ambiguous"
        ? "Add nth or within to the binding, or give the element a unique id in the app."
        : "Check the android bindings file names the id this screen actually renders."
  });
}
