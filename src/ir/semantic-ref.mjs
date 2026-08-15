import { AttestError } from "../errors.mjs";

export const SEMANTIC_REF_KINDS = Object.freeze([
  "screen",
  "state",
  "button",
  "field",
  "item",
  "badge",
  "text",
  "list",
  "toggle",
  "tab",
  "link",
  "dialog",
  "image"
]);

const KIND_SET = new Set(SEMANTIC_REF_KINDS);
const PLATFORM_NAMES = new Set(["web", "android", "ios"]);
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const SELECTOR_SHAPE_PATTERN = /[#./[\]>=@()$"' \t\r\n]/;

function badSemanticRef(reason, details = {}) {
  return new AttestError("E_BAD_SEMANTIC_REF", "Invalid SemanticRef", {
    reason,
    ...details
  });
}

export function parseSemanticRef(raw) {
  if (typeof raw !== "string") {
    throw badSemanticRef("not_a_string", { foundType: typeof raw });
  }

  const colonMatches = raw.match(/:/g) ?? [];
  if (colonMatches.length !== 1) {
    const reason = colonMatches.length > 1 ? "more_than_one_colon" : "missing_colon";
    throw badSemanticRef(reason, { found: raw });
  }

  const [kind, name] = raw.split(":");
  if (PLATFORM_NAMES.has(kind)) {
    throw badSemanticRef("platform_kind", { kind });
  }

  if (!KIND_SET.has(kind)) {
    throw badSemanticRef("unknown_kind", { kind });
  }

  if (SELECTOR_SHAPE_PATTERN.test(name)) {
    throw badSemanticRef("selector_shaped_name", { name });
  }

  if (!NAME_PATTERN.test(name)) {
    throw badSemanticRef("invalid_name", { name });
  }

  return Object.freeze({ kind, name });
}

export function isSemanticRef(raw) {
  try {
    parseSemanticRef(raw);
    return true;
  } catch (error) {
    if (error instanceof AttestError && error.code === "E_BAD_SEMANTIC_REF") {
      return false;
    }

    throw error;
  }
}
