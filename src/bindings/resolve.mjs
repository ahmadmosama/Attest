import { AttestError } from "../errors.mjs";
import { parseSemanticRef } from "../ir/semantic-ref.mjs";

export const LOCATOR_STRATEGIES = Object.freeze(["testId", "accessibilityId", "roleName", "raw"]);

const RAW_FIELDS = Object.freeze(["css", "xpath", "uiautomator", "predicate"]);

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function refKey(ref) {
  return `${ref.kind}:${ref.name}`;
}

function normalizeRef(ref) {
  if (typeof ref === "string") {
    return parseSemanticRef(ref);
  }

  if (ref !== null && typeof ref === "object") {
    return parseSemanticRef(refKey(ref));
  }

  return parseSemanticRef(ref);
}

function withDisambiguators(locator, binding) {
  const next = { ...locator };
  if (binding.nth !== undefined) {
    next.nth = binding.nth;
  }
  if (binding.within !== undefined) {
    next.within = binding.within;
  }
  return next;
}

function rawLocator(binding) {
  const rawField = RAW_FIELDS.find((field) => binding[field] !== undefined);
  if (rawField === undefined) {
    return null;
  }

  return {
    locator: {
      strategy: "raw",
      raw: Object.freeze({ kind: rawField, value: binding[rawField] })
    },
    usedRaw: true
  };
}

function elementLocator(binding) {
  if (binding.testId !== undefined) {
    return {
      locator: withDisambiguators({ strategy: "testId", value: binding.testId }, binding),
      usedRaw: false
    };
  }

  if (binding.accessibilityId !== undefined) {
    return {
      locator: withDisambiguators(
        { strategy: "accessibilityId", value: binding.accessibilityId },
        binding
      ),
      usedRaw: false
    };
  }

  if (binding.role !== undefined) {
    const roleLocator = { strategy: "roleName", role: binding.role };
    if (binding.name !== undefined) {
      roleLocator.name = binding.name;
    }
    return {
      locator: withDisambiguators(roleLocator, binding),
      usedRaw: false
    };
  }

  return rawLocator(binding);
}

function unbound(bindings, key) {
  throw new AttestError(
    "E_UNBOUND_REF",
    `SemanticRef ${key} has no binding on surface ${bindings.surface} in ${bindings.file}`,
    {
      ref: key,
      surface: bindings.surface,
      file: bindings.file
    }
  );
}

function resolveElementLike(bindings, key, sourceKind) {
  const source = sourceKind === "state" ? bindings.states : bindings.elements;
  const binding = source?.[key];
  if (binding === undefined) {
    unbound(bindings, key);
  }

  const resolved = elementLocator(binding);
  if (resolved === null) {
    unbound(bindings, key);
  }

  return deepFreeze({ ...resolved, sourceKind });
}

function resolveScreen(bindings, key) {
  const screen = bindings.screens?.[key];
  if (screen === undefined) {
    unbound(bindings, key);
  }

  const ready = elementLocator(screen.ready);
  if (ready === null) {
    unbound(bindings, `${key}.ready`);
  }

  const locator = {
    strategy: "screen",
    ready: ready.locator
  };
  if (screen.path !== undefined) {
    locator.path = screen.path;
  }
  if (screen.deeplink !== undefined) {
    locator.deeplink = screen.deeplink;
  }

  return deepFreeze({
    locator,
    usedRaw: ready.usedRaw,
    sourceKind: "screen"
  });
}

export function resolveRef(bindings, ref) {
  const parsed = normalizeRef(ref);
  const key = refKey(parsed);

  if (parsed.kind === "screen") {
    return resolveScreen(bindings, key);
  }

  if (parsed.kind === "state") {
    return resolveElementLike(bindings, key, "state");
  }

  return resolveElementLike(bindings, key, "element");
}
