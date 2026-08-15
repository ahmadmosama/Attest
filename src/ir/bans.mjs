import { createDiagnostic } from "./diagnostics.mjs";
import { OP_SET, OPS } from "./ops.mjs";
import { positionOf } from "./parse.mjs";

const SLEEP_KEYS = new Set(["sleep", "pause", "delay"]);
const CONDITIONAL_KEYS = new Set([
  "if",
  "else",
  "elif",
  "when",
  "unless",
  "branch",
  "switch",
  "case",
  "platform",
  "only_on",
  "skip_on"
]);
const SELECTOR_KEYS = new Set([
  "css",
  "xpath",
  "selector",
  "locator",
  "test_id",
  "testid",
  "resource_id",
  "resourceid",
  "accessibility_id",
  "accessibilityid",
  "uiautomator",
  "predicate",
  "class_name"
]);
const URL_KEYS = new Set(["url", "path", "href", "deeplink", "base_url"]);

const FIXED_WAIT_KEY_PATTERN =
  /^(wait|wait_?ms|wait_?for|waitFor|timeout_?ms|duration_?ms|after_?ms)$/i;
const SELECTOR_PREFIX_PATTERN = /^(#|\.|\/\/|\[)/;
const SELECTOR_CONTAINS_PATTERN = /( > | >> |\[data-)/;
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const PLATFORM_NAME_PATTERN =
  /\b(web|android|ios|chrome|chromium|safari|firefox|playwright|appium|simulator|emulator|browser)\b/i;

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keyAt(path) {
  return path.length === 0 ? null : path.at(-1);
}

function parentPath(path) {
  return path.slice(0, -1);
}

function firstKey(value) {
  return isRecord(value) ? Object.keys(value)[0] : undefined;
}

function isStepPath(path) {
  return path.length === 2 && path[0] === "steps" && Number.isInteger(path[1]);
}

function isRawStepPath(path, root) {
  if (path.length < 2 || path[0] !== "steps" || !Number.isInteger(path[1])) {
    return false;
  }

  return firstKey(root?.steps?.[path[1]]) === "raw";
}

function isRequirementPath(path) {
  return path[0] === "requirement";
}

function isConditionalPath(path) {
  return CONDITIONAL_KEYS.has(lower(keyAt(path)));
}

function suppressionForPath(path, root) {
  if (path.length !== 3 || path[0] !== "suppressions" || !Number.isInteger(path[1])) {
    return null;
  }

  return root?.suppressions?.[path[1]] ?? null;
}

function isWildcardForbiddenSuppression(value) {
  return (
    isRecord(value) &&
    ["ignore", "derived", "external_writer"].includes(value.kind) &&
    typeof value.entity === "string" &&
    /[*%]/.test(value.entity)
  );
}

function isSelectorString(value) {
  return SELECTOR_PREFIX_PATTERN.test(value) || SELECTOR_CONTAINS_PATTERN.test(value);
}

function isUrlString(value) {
  return URL_SCHEME_PATTERN.test(value) || value.includes("://");
}

function quote(value) {
  const text = String(value);
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text);
}

function levenshtein(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const cost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      current.push(
        Math.min(previous[rightIndex + 1] + 1, current[rightIndex] + 1, previous[rightIndex] + cost)
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function nearestOp(opName) {
  let best = null;

  for (const candidate of OPS) {
    const distance = levenshtein(opName, candidate);
    if (best === null || distance < best.distance) {
      best = { candidate, distance };
    }
  }

  return best !== null && best.distance <= 2 ? best.candidate : null;
}

function hasSpecificBanForUnknownOp(opName) {
  const name = lower(opName);
  return (
    SLEEP_KEYS.has(name) ||
    FIXED_WAIT_KEY_PATTERN.test(opName) ||
    CONDITIONAL_KEYS.has(name) ||
    SELECTOR_KEYS.has(name) ||
    URL_KEYS.has(name) ||
    PLATFORM_NAME_PATTERN.test(opName)
  );
}

export const BAN_RULES = Object.freeze([
  Object.freeze({
    code: "E_BANNED_SLEEP",
    title: "Sleep is not a scenario operation",
    appliesTo: "keys and scalar values",
    test(node, path) {
      const key = lower(keyAt(path));
      if (SLEEP_KEYS.has(key)) {
        return "bounded convergence polling replaces sleep; sleep does not exist anywhere in the system";
      }
      if (typeof node === "string" && lower(node) === "sleep") {
        return "bounded convergence polling replaces sleep; sleep does not exist anywhere in the system";
      }
      return null;
    }
  }),
  Object.freeze({
    code: "E_BANNED_FIXED_WAIT",
    title: "Fixed waits are runner configuration",
    appliesTo: "keys and wait steps",
    test(node, path) {
      const key = keyAt(path);
      if (typeof key === "string" && FIXED_WAIT_KEY_PATTERN.test(key)) {
        return `fixed wait key ${quote(key)} is not allowed; timeouts are runner configuration`;
      }
      if (isStepPath(path) && firstKey(node) === "wait") {
        return "fixed wait step is not allowed; timeouts are runner configuration";
      }
      return null;
    }
  }),
  Object.freeze({
    code: "E_BANNED_CONDITIONAL",
    title: "Conditionals are not scenario syntax",
    appliesTo: "keys",
    test(_node, path) {
      const key = lower(keyAt(path));
      if (CONDITIONAL_KEYS.has(key)) {
        return `conditional key ${quote(keyAt(path))} is not allowed in a scenario`;
      }
      return null;
    }
  }),
  Object.freeze({
    code: "E_SELECTOR_IN_SCENARIO",
    title: "Selectors live in bindings",
    appliesTo: "keys and scalar values",
    test(node, path, ctx) {
      if (isRawStepPath(path, ctx.root)) {
        return null;
      }

      const key = lower(keyAt(path));
      if (SELECTOR_KEYS.has(key)) {
        return `selector key ${quote(keyAt(path))} is legal only in the bindings layer (SCEN-03)`;
      }
      if (typeof node === "string" && isSelectorString(node)) {
        return `selector value ${quote(node)} is legal only in the bindings layer (SCEN-03)`;
      }
      return null;
    }
  }),
  Object.freeze({
    code: "E_URL_IN_SCENARIO",
    title: "URLs live outside scenarios",
    appliesTo: "keys and scalar values",
    test(node, path, ctx) {
      if (isRawStepPath(path, ctx.root)) {
        return null;
      }

      const key = lower(keyAt(path));
      if (URL_KEYS.has(key)) {
        return `URL key ${quote(keyAt(path))} is not allowed in a scenario`;
      }
      if (typeof node === "string" && isUrlString(node)) {
        return `URL value ${quote(node)} is not allowed in a scenario`;
      }
      return null;
    }
  }),
  Object.freeze({
    code: "E_PLATFORM_NAME_IN_SCENARIO",
    title: "Platform names live outside scenarios",
    appliesTo: "keys and scalar values",
    test(node, path, ctx) {
      if (
        isRawStepPath(path, ctx.root) ||
        isRequirementPath(path) ||
        isConditionalPath(path) ||
        isConditionalPath(parentPath(path))
      ) {
        return null;
      }

      const key = keyAt(path);
      if (typeof key === "string" && PLATFORM_NAME_PATTERN.test(key)) {
        return `platform name ${quote(key)} is not allowed in a scenario`;
      }
      if (typeof node === "string" && PLATFORM_NAME_PATTERN.test(node)) {
        return `platform name in ${quote(node)} is not allowed in a scenario`;
      }
      return null;
    }
  }),
  Object.freeze({
    code: "E_UNKNOWN_OP",
    title: "Steps use the closed operation vocabulary",
    appliesTo: "step objects",
    test(node, path) {
      if (!isStepPath(path) || !isRecord(node)) {
        return null;
      }

      const keys = Object.keys(node);
      if (keys.length !== 1 || OP_SET.has(keys[0]) || hasSpecificBanForUnknownOp(keys[0])) {
        return null;
      }

      const suggestion = nearestOp(keys[0]);
      const hint = suggestion === null ? "" : `; did you mean ${quote(suggestion)}?`;
      return `unknown operation ${quote(keys[0])}; expected one of the closed vocabulary${hint}`;
    }
  }),
  Object.freeze({
    code: "E_WILDCARD_ENTITY",
    title: "Ignore suppressions name concrete entities",
    appliesTo: "suppression entries",
    test(node, path, ctx) {
      const suppression = suppressionForPath(path, ctx.root);
      if (
        keyAt(path) !== "entity" ||
        typeof node !== "string" ||
        !isWildcardForbiddenSuppression(suppression)
      ) {
        return null;
      }

      return `suppression kind ${quote(suppression.kind)} cannot use wildcard entity ${quote(node)}`;
    }
  }),
  Object.freeze({
    code: "E_RAW_WITHOUT_REASON",
    title: "Raw steps require a written reason",
    appliesTo: "raw steps",
    test(node, path) {
      if (!isStepPath(path) || !isRecord(node) || !isRecord(node.raw)) {
        return null;
      }

      const reason = typeof node.raw.reason === "string" ? node.raw.reason.trim() : "";
      if (reason.length >= 10) {
        return null;
      }

      return "raw steps require a written reason of at least 10 characters";
    }
  })
]);

function visit(value, path, ctx) {
  for (const rule of BAN_RULES) {
    const reason = rule.test(value, path, ctx);
    if (reason !== null) {
      const pos = positionOf(ctx.positions, path);
      ctx.diagnostics.add(
        createDiagnostic({
          file: pos.file ?? ctx.file,
          line: pos.line,
          col: pos.col,
          code: rule.code,
          reason,
          path
        })
      );
    }
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      visit(item, [...path, index], ctx);
    }
    return;
  }

  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      visit(item, [...path, key], ctx);
    }
  }
}

export function applyBans(ast, diagnostics) {
  if (ast === null || ast === undefined || ast.value === null || ast.value === undefined) {
    return;
  }

  visit(ast.value, [], {
    diagnostics,
    file: ast.file,
    positions: ast.positions,
    root: ast.value
  });
}
