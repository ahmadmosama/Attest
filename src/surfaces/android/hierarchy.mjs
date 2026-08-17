import { AttestError } from "../../errors.mjs";

// uiautomator emits `bounds="[left,top][right,bottom]"`.
const BOUNDS_RE = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u;
const NODE_RE = /<node\b([^>]*?)(\/?)>/gu;
const ATTR_RE = /([\w:-]+)="([^"]*)"/gu;

const ENTITIES = Object.freeze({
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'"
});

function decodeEntities(value) {
  return value.replaceAll(/&(?:amp|lt|gt|quot|apos|#\d+);/gu, (match) => {
    if (match.startsWith("&#")) {
      return String.fromCodePoint(Number(match.slice(2, -1)));
    }
    return ENTITIES[match] ?? match;
  });
}

function parseBounds(value) {
  const match = BOUNDS_RE.exec(value ?? "");
  if (match === null) {
    return null;
  }

  const [left, top, right, bottom] = match.slice(1, 5).map(Number);
  return Object.freeze({
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    // Integer centre. adb `input tap` takes integers, and rounding here rather
    // than at the call site keeps the tap point deterministic, which matters
    // because a run must be reproducible (ISO-03).
    centerX: Math.floor((left + right) / 2),
    centerY: Math.floor((top + bottom) / 2)
  });
}

function attributes(raw) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let match = ATTR_RE.exec(raw);
  while (match !== null) {
    out[match[1]] = decodeEntities(match[2]);
    match = ATTR_RE.exec(raw);
  }
  return out;
}

function booleanAttr(value) {
  return value === "true";
}

function toNode(attrs, index) {
  return Object.freeze({
    index,
    resourceId: attrs["resource-id"] ?? "",
    text: attrs.text ?? "",
    contentDesc: attrs["content-desc"] ?? "",
    className: attrs.class ?? "",
    packageName: attrs.package ?? "",
    checkable: booleanAttr(attrs.checkable),
    checked: booleanAttr(attrs.checked),
    clickable: booleanAttr(attrs.clickable),
    enabled: booleanAttr(attrs.enabled),
    focused: booleanAttr(attrs.focused),
    scrollable: booleanAttr(attrs.scrollable),
    selected: booleanAttr(attrs.selected),
    displayed: attrs.displayed === undefined ? true : booleanAttr(attrs.displayed),
    bounds: parseBounds(attrs.bounds)
  });
}

/**
 * Parse a uiautomator XML dump into a flat, frozen list of nodes.
 *
 * Flat rather than nested on purpose. Every locate strategy Attest needs is a
 * predicate over attributes plus bounds, and a flat list keeps matching, and the
 * ambiguity check below, trivial to reason about.
 */
export function parseHierarchy(xml) {
  if (typeof xml !== "string" || xml.trim().length === 0) {
    throw new AttestError("E_ANDROID_HIERARCHY_EMPTY", "uiautomator returned an empty hierarchy.", {
      remediation: "Retry the dump after the screen settles, the window may still have been in transition."
    });
  }

  const nodes = [];
  NODE_RE.lastIndex = 0;
  let match = NODE_RE.exec(xml);
  while (match !== null) {
    nodes.push(toNode(attributes(match[1]), nodes.length));
    match = NODE_RE.exec(xml);
  }

  if (nodes.length === 0) {
    throw new AttestError("E_ANDROID_HIERARCHY_EMPTY", "uiautomator hierarchy contained no nodes.", {
      bytes: xml.length
    });
  }

  return Object.freeze(nodes);
}

// `android.widget.Button` -> `Button`. Matching on the simple name is what lets
// one declared role cover Button, AppCompatButton and MaterialButton without
// the binding having to know which support library the app was built against.
export function simpleClassName(className) {
  const index = String(className ?? "").lastIndexOf(".");
  return index === -1 ? String(className ?? "") : String(className).slice(index + 1);
}

// Android resource ids are package qualified (`com.example:id/submit`) and a
// binding is not. Accepting the `:id/<value>` suffix is what makes one binding
// file work against a debug build and a release build with different ids.
function matchesResourceId(node, selector) {
  if (selector.resourceId !== undefined && node.resourceId !== selector.resourceId) {
    return false;
  }

  if (selector.resourceIdSuffix !== undefined) {
    const value = selector.resourceIdSuffix;
    if (node.resourceId !== value && !node.resourceId.endsWith(`:id/${value}`)) {
      return false;
    }
  }

  return true;
}

function matchesSelector(node, selector) {
  if (!matchesResourceId(node, selector)) {
    return false;
  }
  if (selector.text !== undefined && node.text !== selector.text) {
    return false;
  }
  if (selector.contentDesc !== undefined && node.contentDesc !== selector.contentDesc) {
    return false;
  }
  // A name in the shared vocabulary is an accessible name, and Android spells
  // that as either text or content-desc depending on the widget.
  if (
    selector.nameAny !== undefined &&
    node.text !== selector.nameAny &&
    node.contentDesc !== selector.nameAny
  ) {
    return false;
  }
  if (selector.className !== undefined && node.className !== selector.className) {
    return false;
  }
  if (
    selector.classNameOneOf !== undefined &&
    !selector.classNameOneOf.includes(simpleClassName(node.className))
  ) {
    return false;
  }
  return true;
}

function containedIn(node, container) {
  if (container === null) {
    return true;
  }

  const bounds = node.bounds;
  return (
    bounds !== null &&
    bounds.left >= container.left &&
    bounds.top >= container.top &&
    bounds.right <= container.right &&
    bounds.bottom <= container.bottom
  );
}

function boundedSample(candidates) {
  // Bounded on purpose. A hostile or merely large screen must not put an
  // unbounded dump into an artifact.
  return Object.freeze(
    candidates.slice(0, 5).map((node) =>
      Object.freeze({ index: node.index, resourceId: node.resourceId, text: node.text, bounds: node.bounds })
    )
  );
}

export function selectorFromBinding(binding) {
  if (binding === null || typeof binding !== "object") {
    throw new AttestError("E_ANDROID_BINDING_INVALID", "Android binding must be an object", {});
  }

  const selector = {};
  if (typeof binding.id === "string" && binding.id.length > 0) {
    selector.resourceId = binding.id;
  }
  if (typeof binding.text === "string" && binding.text.length > 0) {
    selector.text = binding.text;
  }
  if (typeof binding.desc === "string" && binding.desc.length > 0) {
    selector.contentDesc = binding.desc;
  }
  if (typeof binding.className === "string" && binding.className.length > 0) {
    selector.className = binding.className;
  }

  if (Object.keys(selector).length === 0) {
    throw new AttestError("E_ANDROID_BINDING_INVALID", "Android binding must name at least one of id, text, desc, className", {
      binding: Object.keys(binding)
    });
  }

  return Object.freeze(selector);
}

/**
 * Every node matching a selector, in document order.
 */
export function findAll(nodes, selector, { requireVisible = true, container = null } = {}) {
  return Object.freeze(
    nodes.filter(
      (node) =>
        matchesSelector(node, selector) &&
        containedIn(node, container) &&
        (!requireVisible || (node.displayed && node.bounds !== null))
    )
  );
}

/**
 * Find exactly one node.
 *
 * Ambiguity is an ERROR, never a silent first match. Taking the first of three
 * matches is how a scenario passes while driving the wrong widget, and this
 * project exists to not do that. `nth` is the declared way to disambiguate, so
 * choosing among several matches is always something the bindings said out
 * loud rather than something the adapter decided.
 */
export function findOne(nodes, selector, { requireVisible = true, container = null, nth = null } = {}) {
  const candidates = findAll(nodes, selector, { requireVisible, container });

  if (candidates.length === 0) {
    return Object.freeze({ ok: false, reason: "not_found", selector, matches: 0 });
  }

  if (nth !== null) {
    if (nth >= candidates.length) {
      return Object.freeze({
        ok: false,
        reason: "nth_out_of_range",
        selector,
        matches: candidates.length,
        nth,
        sample: boundedSample(candidates)
      });
    }

    return Object.freeze({ ok: true, node: candidates[nth] });
  }

  if (candidates.length > 1) {
    return Object.freeze({
      ok: false,
      reason: "ambiguous",
      selector,
      matches: candidates.length,
      sample: boundedSample(candidates)
    });
  }

  return Object.freeze({ ok: true, node: candidates[0] });
}

export function tapPoint(node) {
  if (node?.bounds === null || node?.bounds === undefined) {
    throw new AttestError("E_ANDROID_NODE_NOT_TAPPABLE", "Node has no bounds so it cannot be tapped.", {
      resourceId: node?.resourceId ?? null
    });
  }

  return Object.freeze({ x: node.bounds.centerX, y: node.bounds.centerY });
}
