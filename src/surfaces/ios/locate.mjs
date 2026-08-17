import { LOCATOR_STRATEGIES } from "../../bindings/resolve.mjs";
import { AttestError, UnsupportedOpError, UsageError } from "../../errors.mjs";

/**
 * Shared vocabulary locators to iOS accessibility queries.
 *
 * The tree comes from the accessibility hierarchy rather than uiautomator, but
 * every decision here is the one Android already made, for the same reasons:
 * ambiguity is an error, roles map through an explicit table rather than a
 * heuristic, and a raw selector kind is refused because there is no engine to
 * evaluate it against a dumped tree.
 */

// XCUIElement types, by the role name the shared vocabulary uses. An unlisted
// role is refused rather than guessed, because guessing which element to drive
// is how a gate passes while touching the wrong thing.
export const IOS_ROLE_TYPES = Object.freeze({
  button: Object.freeze(["Button", "NavigationBar.Button", "ToolbarButton"]),
  link: Object.freeze(["Link", "StaticText"]),
  heading: Object.freeze(["StaticText", "NavigationBar"]),
  text: Object.freeze(["StaticText"]),
  textbox: Object.freeze(["TextField", "SecureTextField", "TextView"]),
  checkbox: Object.freeze(["Switch", "Toggle"]),
  radio: Object.freeze(["RadioButton"]),
  switch: Object.freeze(["Switch", "Toggle"]),
  image: Object.freeze(["Image"]),
  tab: Object.freeze(["TabBar.Button", "Tab"])
});

export const IOS_ROLES = Object.freeze(Object.keys(IOS_ROLE_TYPES));

const STRATEGY_SET = new Set(LOCATOR_STRATEGIES);
const WITHIN_PREFIX = "testId:";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

/**
 * On iOS both portable strategies land on the same attribute.
 *
 * `accessibilityIdentifier` is what a test id is on this platform: it is set
 * for automation and is not shown to a user, unlike `accessibilityLabel`, which
 * is read aloud and is translated. Matching a label would make a scenario fail
 * the moment the app ships a second language.
 */
function identifierSelector(value) {
  return Object.freeze({ identifier: value });
}

function roleSelector(locator) {
  const types = IOS_ROLE_TYPES[locator.role];
  if (types === undefined) {
    throw new UnsupportedOpError("E_IOS_ROLE_UNSUPPORTED", `iOS surface has no element type for role ${locator.role}`, {
      role: locator.role,
      accepted: IOS_ROLES,
      remediation: "Bind this element by accessibilityId in the ios bindings file rather than by role."
    });
  }

  if (locator.name === undefined) {
    return Object.freeze({ typeOneOf: types });
  }

  return Object.freeze({ typeOneOf: types, nameAny: assertString(locator.name, "name", locator) });
}

function rawRefused(locator) {
  const kind = isObject(locator.raw) ? locator.raw.kind : null;

  throw new UnsupportedOpError("E_RAW_SELECTOR_KIND", `iOS surface does not support raw selector kind ${kind ?? "<missing>"}`, {
    strategy: locator.strategy,
    kind,
    supported: [],
    remediation:
      "Bind this element by accessibilityId or role in the ios bindings file. The simctl backend has no selector engine to evaluate a raw query against."
  });
}

function selectorFor(locator) {
  switch (locator.strategy) {
    // Both portable strategies resolve to accessibilityIdentifier, which is
    // what the Phase 1 locator vocabulary already promised for this platform.
    case "testId":
      return identifierSelector(assertString(locator.value, "value", locator));
    case "accessibilityId":
      return identifierSelector(assertString(locator.value, "value", locator));
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

  const value = locator.within.startsWith(WITHIN_PREFIX) ? locator.within.slice(WITHIN_PREFIX.length) : locator.within;
  if (value.length === 0 || value.includes(":")) {
    throw new UsageError("E_UNSUPPORTED_WITHIN", "Only testId containers are supported for within", {
      within: locator.within,
      supported: "testId"
    });
  }

  return identifierSelector(value);
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
  if (!isObject(locator)) {
    throw new UsageError("E_BAD_LOCATOR", "Locator must be an object", { locator });
  }

  switch (locator.strategy) {
    case "testId":
    case "accessibilityId":
      return `identifier=${locator.value}`;
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

export function toIosQuery(locator) {
  if (!isObject(locator)) {
    throw new UsageError("E_BAD_LOCATOR", "Locator must be an object", { locator });
  }

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

// The tree reports `XCUIElementTypeButton`; the role table says `Button`. The
// prefix carries no information, and stripping it here keeps the table
// readable rather than making every entry repeat fifteen characters.
function simpleType(type) {
  if (typeof type !== "string") {
    return "";
  }

  return type.split(".").at(-1).replace(/^XCUIElementType/u, "");
}

function matches(element, selector) {
  if (selector.identifier !== undefined && element.identifier !== selector.identifier) {
    return false;
  }

  if (selector.typeOneOf !== undefined) {
    const type = simpleType(element.type);
    if (!selector.typeOneOf.some((accepted) => simpleType(accepted) === type)) {
      return false;
    }
  }

  // A name in the shared vocabulary is an accessible name, and iOS spells that
  // as the label, falling back to the visible title.
  if (
    selector.nameAny !== undefined &&
    element.label !== selector.nameAny &&
    element.title !== selector.nameAny
  ) {
    return false;
  }

  return true;
}

function insideFrame(element, container) {
  if (container === null) {
    return true;
  }

  const frame = element.frame;
  return (
    frame !== null &&
    frame !== undefined &&
    frame.x >= container.x &&
    frame.y >= container.y &&
    frame.x + frame.width <= container.x + container.width &&
    frame.y + frame.height <= container.y + container.height
  );
}

// Visible means it has a frame. It deliberately does NOT mean enabled: a
// disabled button is on the screen, and `expect_state: disabled` has to be able
// to find it. Conflating the two would make that assertion unwritable, and the
// scenario would time out looking for an element that was there all along.
function visible(element) {
  return element.frame !== null && element.frame !== undefined;
}

function sample(candidates) {
  return Object.freeze(
    candidates.slice(0, 5).map((element) =>
      Object.freeze({ identifier: element.identifier, type: element.type, label: element.label })
    )
  );
}

/**
 * Find exactly one element in a flattened accessibility tree.
 *
 * Ambiguity is an error, never a first match, for the reason it is on every
 * other surface: taking the first of three matches is how a scenario passes
 * while driving the wrong control.
 */
export function findByQuery(elements, query, { requireVisible = true } = {}) {
  let container = null;

  if (query.within !== null) {
    const found = elements.filter((element) => matches(element, query.within) && visible(element));
    if (found.length !== 1) {
      return Object.freeze({
        ok: false,
        reason: found.length === 0 ? "container_not_found" : "container_ambiguous",
        matches: found.length,
        description: query.description
      });
    }
    container = found[0].frame;
  }

  const candidates = elements.filter(
    (element) =>
      matches(element, query.selector) && insideFrame(element, container) && (!requireVisible || visible(element))
  );

  if (candidates.length === 0) {
    return Object.freeze({ ok: false, reason: "not_found", matches: 0, description: query.description });
  }

  if (query.nth !== null) {
    if (query.nth >= candidates.length) {
      return Object.freeze({
        ok: false,
        reason: "nth_out_of_range",
        matches: candidates.length,
        nth: query.nth,
        description: query.description
      });
    }

    return Object.freeze({ ok: true, element: candidates[query.nth], description: query.description });
  }

  if (candidates.length > 1) {
    return Object.freeze({
      ok: false,
      reason: "ambiguous",
      matches: candidates.length,
      sample: sample(candidates),
      description: query.description
    });
  }

  return Object.freeze({ ok: true, element: candidates[0], description: query.description });
}

export function locateFailure(result, { i = null, kind = null } = {}) {
  const ambiguous = result.reason === "ambiguous" || result.reason === "container_ambiguous";

  return new AttestError(ambiguous ? "E_IOS_AMBIGUOUS" : "E_IOS_NOT_FOUND", ambiguous ? "iOS locator matched more than one element" : "iOS locator did not resolve to an element", {
    i,
    kind,
    locator: result.description,
    reason: result.reason,
    matches: result.matches ?? 0,
    ...(result.sample === undefined ? {} : { sample: result.sample }),
    remediation: ambiguous
      ? "Add nth or within to the binding, or give the element a unique accessibilityIdentifier in the app."
      : "Check the ios bindings file names the accessibilityIdentifier this screen actually sets."
  });
}

export function tapPoint(element) {
  const frame = element?.frame;
  if (frame === null || frame === undefined) {
    throw new AttestError("E_IOS_ELEMENT_NOT_TAPPABLE", "Element has no frame so it cannot be tapped.", {
      identifier: element?.identifier ?? null
    });
  }

  // Integer centre, rounded here rather than at the call site so the tap point
  // is deterministic and a run stays reproducible.
  return Object.freeze({
    x: Math.floor(frame.x + frame.width / 2),
    y: Math.floor(frame.y + frame.height / 2)
  });
}
